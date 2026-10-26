"""Tests for the volatility pipeline: features and targets that cannot see the
future, the forecasters, the evaluation statistics, and the golden file the
TypeScript implementation is tested against. Synthetic data only; no download."""

import json
import pathlib

import numpy as np
import pytest

from volatility.features import FLOOR, HORIZON, features, log_returns, target
from volatility.train import diebold_mariano, ewma, garch, qlike, qlike_losses

PACKAGE = pathlib.Path(__file__).resolve().parents[3] / "packages" / "volatility"


def walk(n: int, sigma: float, seed: int = 0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    close = 100 * np.exp(np.cumsum(sigma * rng.standard_normal(n)))
    previous = np.concatenate([[close[0]], close[:-1]])
    return np.maximum(close, previous), np.minimum(close, previous), close


def test_features_only_use_the_past() -> None:
    high, low, close = walk(500, 0.001)
    before = features(high, low, close)
    # Rewrite the future after minute 300: nothing up to 300 may change.
    high2, low2, close2 = high.copy(), low.copy(), close.copy()
    close2[301:] *= 1.5
    high2[301:] *= 1.6
    low2[301:] *= 1.4
    after = features(high2, low2, close2)
    np.testing.assert_array_equal(before[:301], after[:301])
    assert not np.allclose(before[301:], after[301:])


def test_target_is_the_realised_volatility_of_the_next_15_minutes() -> None:
    _, _, close = walk(100, 0.001)
    r = log_returns(close)
    y = target(close)
    i = 40
    assert y[i] == pytest.approx(np.log(np.sqrt(np.sum(r[i + 1 : i + 1 + HORIZON] ** 2))))
    assert np.isnan(y[-HORIZON:]).all()  # the future is not known yet
    assert not np.isnan(y[: -HORIZON]).any()


def test_realised_volatility_features_recover_the_true_volatility() -> None:
    high, low, close = walk(20_000, 0.001)
    x = features(high, low, close)
    true = np.log(0.001 * np.sqrt(HORIZON))
    for column in range(4):  # rv over 5, 15, 60, 240 minutes, all scaled to 15
        assert np.median(x[1_000:, column]) == pytest.approx(true, abs=0.15)


def test_ewma_starts_as_a_running_mean_then_weights_exponentially() -> None:
    r = np.array([0.0, 0.01, -0.02, 0.03])
    pred = ewma(r, 0.5)
    assert pred[0] == pytest.approx(np.log(FLOOR))  # no returns yet
    assert pred[1] == pytest.approx(np.log(np.sqrt(HORIZON * 0.01**2)))
    s2 = (0.01**2 + 0.02**2) / 2  # weight 1/2 = max(0.5, 1/2)
    assert pred[2] == pytest.approx(np.log(np.sqrt(HORIZON * s2)))
    s3 = 0.5 * s2 + 0.5 * 0.03**2  # weight max(0.5, 1/3) = 0.5
    assert pred[3] == pytest.approx(np.log(np.sqrt(HORIZON * s3)))


def test_garch_forecast_reverts_to_its_long_run_level() -> None:
    p = {"omega": 0.5, "alpha": 0.1, "beta": 0.85, "scale": 10_000.0}
    long_run = p["omega"] / (1 - p["alpha"] - p["beta"])  # bp^2 per minute
    expected = np.log(np.sqrt(HORIZON * long_run) / p["scale"])
    # Returns exactly at the long-run size keep the variance there.
    r = np.full(200, np.sqrt(long_run) / p["scale"])
    assert garch(r, p)[-1] == pytest.approx(expected, abs=1e-6)
    # After a shock the forecast is higher, after calm lower.
    shocked, calm = r.copy(), r.copy()
    shocked[-1] *= 5
    calm[-5:] = 0
    assert garch(shocked, p)[-1] > expected > garch(calm, p)[-1]


def test_qlike_is_smallest_for_the_true_volatility() -> None:
    truth = np.log(np.full(100, 0.01))
    assert qlike(truth, truth) == pytest.approx(0)
    # And it punishes under-prediction more than over-prediction by the same factor.
    assert qlike(truth, truth - 0.3) > qlike(truth, truth + 0.3) > 0


def test_diebold_mariano_tells_a_worse_model_from_noise() -> None:
    rng = np.random.default_rng(1)
    truth = rng.normal(-5, 0.5, 4_000)
    good = truth + rng.normal(0, 0.3, 4_000)
    bad = truth + rng.normal(0, 0.6, 4_000)
    good_loss, bad_loss = qlike_losses(truth, good), qlike_losses(truth, bad)
    assert diebold_mariano(bad_loss, good_loss) < 0.001
    assert diebold_mariano(good_loss, bad_loss) > 0.999
    # Two equally good models are usually not "significantly" different.
    other = truth + rng.normal(0, 0.3, 4_000)
    assert diebold_mariano(qlike_losses(truth, other), good_loss) > 0.01


def test_golden_file_matches_the_current_python_code() -> None:
    """The TypeScript parity test trusts golden.json; this keeps golden.json honest."""
    golden = json.loads((PACKAGE / "test" / "golden.json").read_text())
    manifest = json.loads((PACKAGE / "models" / "volatility.json").read_text())
    bars = golden["bars"]
    high, low, close = (np.array([b[k] for b in bars]) for k in ("high", "low", "close"))
    x = features(high, low, close)
    r = log_returns(close)
    rows = golden["rows"]
    np.testing.assert_allclose(x[rows], golden["features"], rtol=0, atol=1e-12)
    har = manifest["models"]["har"]
    np.testing.assert_allclose(har["intercept"] + x[rows] @ np.array(har["coefficients"]), golden["predictions"]["har"], atol=1e-12)
    np.testing.assert_allclose(ewma(r, manifest["models"]["ewma"]["lambda"])[rows], golden["predictions"]["ewma"], atol=1e-12)
    np.testing.assert_allclose(garch(r, manifest["models"]["garch"])[rows], golden["predictions"]["garch"], atol=1e-12)
    assert manifest["live_model"] in ("ewma", "har", "garch"), "the gateway can only run the closed-form models"
