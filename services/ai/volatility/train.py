"""Compares volatility forecasters on real BTC/USDT minutes and exports the chosen one.

The task: at the close of each minute, forecast realised volatility over the
next 15 minutes. Five forecasters, from textbook to deep learning:

  ewma      RiskMetrics exponentially weighted variance (lambda tuned on training data)
  garch     GARCH(1,1) fitted by maximum likelihood, forecast 15 steps ahead
  har       HAR regression: log future volatility on log past volatility at several horizons
  lightgbm  gradient-boosted trees on the same features
  lstm      a small recurrent network on the last hour of minute returns

Models are compared by walk-forward validation (always trained on the past
only) using QLIKE, the standard loss for variance forecasts. The simplest
model not significantly worse than the best (Diebold-Mariano test) is chosen,
refitted on the first 80% of the data, and reported once on the last 20%.

    python -m volatility.train --data data/btcusdt_1m.csv
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib
from datetime import datetime, timezone

import lightgbm as lgb
import numpy as np
import pandas as pd
from arch import arch_model
from sklearn.linear_model import LinearRegression

from .features import FEATURE_NAMES, FLOOR, HORIZON, WINDOWS, features, log_returns, target

WARMUP = max(WINDOWS)
# Simplest to run, explain and keep correct in production first.
SIMPLEST_FIRST = ["ewma", "har", "garch", "lightgbm", "lstm"]
# Models the TypeScript gateway can run (packages/volatility).
LIVE = ["ewma", "har", "garch"]
OUT = pathlib.Path(__file__).resolve().parents[3] / "packages" / "volatility"


# ---- evaluation ----


def qlike(true_log_vol: np.ndarray, pred_log_vol: np.ndarray) -> float:
    """QLIKE on variances: robust to noise in the realised measure, the usual choice for volatility forecasts."""
    ratio = np.exp(2 * (true_log_vol - pred_log_vol))
    return float(np.mean(ratio - np.log(ratio) - 1))


def qlike_losses(true_log_vol: np.ndarray, pred_log_vol: np.ndarray) -> np.ndarray:
    ratio = np.exp(2 * (true_log_vol - pred_log_vol))
    return ratio - np.log(ratio) - 1


def diebold_mariano(loss_a: np.ndarray, loss_b: np.ndarray, lag: int = 4) -> float:
    """One-sided p-value that model a has higher expected loss than model b
    (Diebold-Mariano with a Newey-West variance for autocorrelated losses)."""
    d = loss_a - loss_b
    n = len(d)
    centred = d - d.mean()
    variance = np.dot(centred, centred) / n
    for k in range(1, lag + 1):
        variance += 2 * (1 - k / (lag + 1)) * np.dot(centred[k:], centred[:-k]) / n
    statistic = d.mean() / np.sqrt(variance / n)
    return float(0.5 * math.erfc(statistic / math.sqrt(2)))


def scores(true_log_vol: np.ndarray, pred_log_vol: np.ndarray) -> dict:
    return {
        "qlike": round(qlike(true_log_vol, pred_log_vol), 5),
        "rmse_log_vol": round(float(np.sqrt(np.mean((true_log_vol - pred_log_vol) ** 2))), 5),
        # Mincer-Zarnowitz style: how much of the variation in realised volatility the forecast explains.
        "r2_log_vol": round(float(np.corrcoef(true_log_vol, pred_log_vol)[0, 1] ** 2), 4),
    }


# ---- forecasters: each returns a predicted ln(15-minute volatility) for every minute ----


def ewma(r: np.ndarray, lam: float) -> np.ndarray:
    """Exponentially weighted per-minute variance, scaled to 15 minutes.

    Return i (r[0] is not a return) gets weight max(1 - lambda, 1/i): a plain
    running mean until there are enough returns for the exponential weights,
    so the live service, which starts with no history, computes the same thing.
    """
    s2 = np.zeros_like(r)
    s = 0.0
    for i in range(1, len(r)):
        w = max(1 - lam, 1 / i)
        s = (1 - w) * s + w * r[i] ** 2
        s2[i] = s
    return np.log(np.maximum(np.sqrt(HORIZON * s2), FLOOR))


def fit_garch(r_train: np.ndarray) -> dict:
    # Returns in basis points: per-minute variances near 1-100 keep the
    # optimiser well conditioned (per-thousand left it short of convergence).
    scale = 10_000.0
    result = arch_model(r_train * scale, mean="Zero", vol="GARCH", p=1, q=1, rescale=False).fit(disp="off", options={"maxiter": 500})
    if result.convergence_flag != 0:
        raise RuntimeError(f"GARCH fit did not converge: {result.optimization_result.message}")
    return {"omega": float(result.params["omega"]), "alpha": float(result.params["alpha[1]"]), "beta": float(result.params["beta[1]"]), "scale": scale}


def garch(r: np.ndarray, p: dict) -> np.ndarray:
    """Filtered one-step variance, then the closed-form sum of the next 15 one-step variances."""
    omega, alpha, beta, scale = p["omega"], p["alpha"], p["beta"], p["scale"]
    persistence = alpha + beta
    long_run = omega / (1 - persistence)
    x = r * scale
    next_var = np.empty_like(r)
    v = long_run
    for i in range(len(r)):
        v = omega + alpha * x[i] ** 2 + beta * v  # variance of minute i+1 given minute i
        next_var[i] = v
    total = HORIZON * long_run + (next_var - long_run) * (1 - persistence**HORIZON) / (1 - persistence)
    return np.log(np.sqrt(np.maximum(total, 1e-12)) / scale)


# ---- pipeline ----


def run(data: pathlib.Path, out: pathlib.Path) -> dict:
    df = pd.read_csv(data)
    high, low, close = (df[c].to_numpy(dtype=np.float64) for c in ("high", "low", "close"))
    r = log_returns(close)
    x = features(high, low, close)
    y = target(close)

    usable = np.arange(WARMUP, len(close) - HORIZON)
    n = len(usable)
    from .lstm import LOOKBACK, lstm_inputs, predict_lstm, train_lstm  # PyTorch is only needed here

    seq = lstm_inputs(high, low, close, r)

    def fit_all(train_idx: np.ndarray) -> tuple[dict[str, np.ndarray], dict[str, dict]]:
        """Fits every forecaster on `train_idx` only; returns forecasts for every minute and the fitted parameters."""
        # The last tenth of the training range is held back for early stopping.
        cut = int(len(train_idx) * 0.9)
        fit_idx, stop_idx = train_idx[:cut], train_idx[cut:]
        predictions: dict[str, np.ndarray] = {}
        params: dict[str, dict] = {}

        lambdas = [0.9, 0.94, 0.97, 0.98, 0.99, 0.995]
        best_lambda = min(lambdas, key=lambda lam: qlike(y[fit_idx[::HORIZON]], ewma(r, lam)[fit_idx[::HORIZON]]))
        predictions["ewma"], params["ewma"] = ewma(r, best_lambda), {"lambda": best_lambda}

        params["garch"] = fit_garch(r[fit_idx])
        predictions["garch"] = garch(r, params["garch"])

        # The regressions below predict the mean of ln(volatility). Exponentiating
        # that under-predicts variance (Jensen's inequality), which QLIKE punishes
        # hardest, and rightly: under-estimating risk is the dangerous direction.
        # If ln(vol) is roughly normal with residual variance s2, ln of the
        # expected variance's square root is the mean plus s2, so each model's
        # forecast is shifted by its own training residual variance.
        def debiased(pred: np.ndarray) -> tuple[np.ndarray, float]:
            shift = float(np.var(y[fit_idx] - pred[fit_idx]))
            return pred + shift, shift

        har = LinearRegression().fit(x[fit_idx], y[fit_idx])
        raw = np.full(len(close), np.nan)
        raw[usable] = har.predict(x[usable])
        predictions["har"], har_shift = debiased(raw)
        params["har"] = {"intercept": float(har.intercept_) + har_shift, "coefficients": [float(c) for c in har.coef_]}

        gbm = lgb.LGBMRegressor(n_estimators=600, learning_rate=0.03, num_leaves=31, min_child_samples=100, random_state=0, verbose=-1)
        gbm.fit(x[fit_idx], y[fit_idx], eval_X=x[stop_idx], eval_y=y[stop_idx], callbacks=[lgb.early_stopping(50, verbose=False)])
        raw = np.full(len(close), np.nan)
        raw[usable] = gbm.predict(x[usable])
        predictions["lightgbm"], _ = debiased(raw)

        lstm, lstm_norm, windows = train_lstm(seq, y, fit_idx, stop_idx)
        raw = np.full(len(close), np.nan)
        raw[usable] = predict_lstm(lstm, windows, usable)
        predictions["lstm"], _ = debiased(raw)
        params["lstm"] = {"lookback": LOOKBACK, **lstm_norm}
        return predictions, params

    # Walk-forward validation over 40-80% of the data: refit on everything
    # before each window, score the window. Volatility regimes change, so one
    # validation period says more about that period than about the models
    # (with a single window the ranking flipped when the window moved).
    pooled: dict[str, list[np.ndarray]] = {name: [] for name in SIMPLEST_FIRST}
    per_window: dict[str, list[float]] = {name: [] for name in SIMPLEST_FIRST}
    for a, b in [(0.4, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 0.8)]:
        predictions, _ = fit_all(usable[: int(n * a)])
        blocks = usable[int(n * a) : int(n * b)][::HORIZON]  # non-overlapping 15-minute blocks
        for name in SIMPLEST_FIRST:
            losses = qlike_losses(y[blocks], predictions[name][blocks])
            pooled[name].append(losses)
            per_window[name].append(round(float(losses.mean()), 5))
    walk = {name: np.concatenate(pooled[name]) for name in SIMPLEST_FIRST}

    # Choose the simplest model that is not significantly worse than the best.
    # A small, noisy edge does not justify a model that is harder to run,
    # explain and keep correct in production.
    best = min(SIMPLEST_FIRST, key=lambda name: walk[name].mean())
    results: dict[str, dict] = {}
    for name in SIMPLEST_FIRST:
        results[name] = {
            "walk_forward_qlike": round(float(walk[name].mean()), 5),
            "per_window_qlike": per_window[name],
            "p_worse_than_best": 1.0 if name == best else round(diebold_mariano(walk[name], walk[best]), 4),
        }
    chosen = next(name for name in SIMPLEST_FIRST if results[name]["p_worse_than_best"] >= 0.05)
    # The gateway runs the closed-form models; if a heavier one is chosen, it runs the best of those instead and says so.
    live = chosen if chosen in LIVE else min(LIVE, key=lambda name: walk[name].mean())

    # Final models: refit on the first 80%, then a single look at the untouched last 20%.
    final, params = fit_all(usable[: int(n * 0.8)])
    test_blocks = usable[int(n * 0.8) :][::HORIZON]
    for name in SIMPLEST_FIRST:
        results[name]["test"] = scores(y[test_blocks], final[name][test_blocks])

    out.mkdir(parents=True, exist_ok=True)
    (out / "models").mkdir(exist_ok=True)
    manifest = {
        "version": 1,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data": {
            "symbol": "BTCUSDT",
            "minutes": int(len(close)),
            "from": pd.to_datetime(int(df["open_time"].iloc[0]), unit="ms", utc=True).isoformat(),
            "to": pd.to_datetime(int(df["open_time"].iloc[-1]), unit="ms", utc=True).isoformat(),
            "split": "walk-forward validation over 40-80% (four windows), test on the last 20%",
        },
        "horizon_minutes": HORIZON,
        "windows": list(WINDOWS),
        "features": FEATURE_NAMES,
        "chosen": chosen,
        "best_in_walk_forward": best,
        "chosen_by": "simplest model not significantly worse than the best in walk-forward QLIKE (Diebold-Mariano, 5%)",
        "live_model": live,
        "live_model_note": "the chosen model" if live == chosen else f"{chosen} cannot run in the gateway yet; {live} is the best model that can",
        "models": {"har": params["har"], "ewma": params["ewma"], "garch": params["garch"]},
        "results": results,
    }
    (out / "models" / "volatility.json").write_text(json.dumps(manifest, indent=2))
    write_golden(high, low, close, params, out)
    return manifest


def write_golden(high: np.ndarray, low: np.ndarray, close: np.ndarray, params: dict, out: pathlib.Path) -> None:
    """Sample bars, and the features and forecasts Python computes from them, for the TypeScript parity test.

    Everything is recomputed on the slice alone, starting with no history, as
    the live service sees a market it has just started watching.
    """
    start = len(close) - 300
    h, lo, c = high[start:], low[start:], close[start:]
    sub = features(h, lo, c)
    r = log_returns(c)
    har = params["har"]
    rows = list(range(0, 300, 37)) + [299]
    predictions = {
        "har": [float(har["intercept"] + np.dot(har["coefficients"], sub[i])) for i in range(len(c))],
        "ewma": ewma(r, params["ewma"]["lambda"]).tolist(),
        "garch": garch(r, params["garch"]).tolist(),
    }
    golden = {
        "bars": [{"high": float(a), "low": float(b), "close": float(d)} for a, b, d in zip(h, lo, c)],
        "rows": rows,
        "features": [[float(v) for v in sub[i]] for i in rows],
        "predictions": {name: [p[i] for i in rows] for name, p in predictions.items()},
    }
    (out / "test").mkdir(exist_ok=True)
    (out / "test" / "golden.json").write_text(json.dumps(golden))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=pathlib.Path, default=pathlib.Path("data/btcusdt_1m.csv"))
    parser.add_argument("--out", type=pathlib.Path, default=OUT)
    args = parser.parse_args()
    m = run(args.data, args.out)
    print(f"{m['data']['minutes']} real BTC/USDT minutes, {m['data']['from'][:10]} to {m['data']['to'][:10]}")
    print(f"{'model':<10} {'walk-fwd QLIKE':>15} {'p worse':>8} {'test QLIKE':>11} {'test RMSE':>10} {'test R2':>8}   per window")
    for name, r in sorted(m["results"].items(), key=lambda kv: kv[1]["walk_forward_qlike"]):
        print(
            f"{name:<10} {r['walk_forward_qlike']:>15.4f} {r['p_worse_than_best']:>8.3f} {r['test']['qlike']:>11.4f} "
            f"{r['test']['rmse_log_vol']:>10.4f} {r['test']['r2_log_vol']:>8.3f}   {r['per_window_qlike']}"
        )
    print(f"best in walk-forward: {m['best_in_walk_forward']}; chosen: {m['chosen']} ({m['chosen_by']})")
    print(f"the gateway runs: {m['live_model']} ({m['live_model_note']})")


if __name__ == "__main__":
    main()
