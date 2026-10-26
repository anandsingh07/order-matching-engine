"""Trains a market-making policy with PPO and compares it with the classic strategies.

    python -m rl.train --data data/btcusdt_1m.csv --steps 2000000

1. Calibrate: each episode's volatility is drawn from real BTC 15-minute
   realised volatility (the same Binance data as the volatility models).
2. Baselines, tuned on training episodes:
   - fixed spread: the best constant half spread;
   - Avellaneda-Stoikov: the closed-form optimum for this kind of market,
     with its risk aversion tuned, and the volatility forecast as its sigma.
3. PPO (stable-baselines3) on the same environment.
4. Evaluate every strategy on the same unseen episodes (common random
   numbers, so differences are paired) and test whether PPO's edge over AS is
   real. An oracle that knows the hidden trend gives an upper bound.
5. Export the policy to ONNX for the TypeScript bot, with golden cases.
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib
from dataclasses import replace
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.vec_env import DummyVecEnv, VecNormalize
from torch import nn

from volatility.features import HORIZON, log_returns

from .env import (
    MAX_HALF_SPREAD,
    MAX_SKEW,
    MIN_HALF_SPREAD,
    MarketMakingEnv,
    MarketParams,
    action_for_distances,
    avellaneda_stoikov,
    fixed_spread_action,
    observation,
    quotes_from_action,
    run_episode,
)

OUT = pathlib.Path(__file__).resolve().parents[3] / "services" / "bots" / "models"
TRAIN_SEEDS = range(0, 200)  # for tuning the baselines
TEST_SEEDS = range(1_000_000, 1_000_400)  # never seen by any strategy's tuning or training


def btc_vol_samples(data: pathlib.Path) -> tuple[float, ...]:
    """Realised volatility of every non-overlapping 15 minutes of real BTC, in bps."""
    close = pd.read_csv(data)["close"].to_numpy(dtype=np.float64)
    r2 = log_returns(close)[1:] ** 2
    blocks = r2[: len(r2) // HORIZON * HORIZON].reshape(-1, HORIZON).sum(axis=1)
    vol = np.sqrt(blocks) * 10_000
    return tuple(float(v) for v in vol[vol > 0])


def evaluate(env: MarketMakingEnv, policy, seeds) -> list[dict]:
    return [run_episode(env, policy, s) for s in seeds]


def summary(runs: list[dict]) -> dict:
    pnl = np.array([r["pnl"] for r in runs])
    return {
        "objective": round(float(np.mean([r["objective"] for r in runs])), 1),
        "pnl_mean": round(float(pnl.mean()), 1),
        "pnl_sd": round(float(pnl.std()), 1),
        "sharpe_per_episode": round(float(pnl.mean() / pnl.std()), 2),
        "fills": round(float(np.mean([r["fills"] for r in runs])), 0),
        "mean_abs_inventory": round(float(np.mean([r["mean_abs_inventory"] for r in runs])), 2),
    }


def paired(a: list[dict], b: list[dict], key: str = "objective") -> dict:
    """Mean of a - b per episode, with a 95% confidence interval (the episodes are independent)."""
    d = np.array([x[key] for x in a]) - np.array([y[key] for y in b])
    half = 1.96 * d.std(ddof=1) / math.sqrt(len(d))
    return {"mean": round(float(d.mean()), 1), "ci95": [round(float(d.mean() - half), 1), round(float(d.mean() + half), 1)], "a_better_share": round(float((d > 0).mean()), 3)}


class Actor(nn.Module):
    """The deterministic part of the PPO policy: observation -> mean action, clipped to the action range."""

    def __init__(self, model: PPO) -> None:
        super().__init__()
        self.features = model.policy.mlp_extractor.policy_net
        self.head = model.policy.action_net

    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        return torch.clamp(self.head(self.features(obs)), -1.0, 1.0)


def train(data: pathlib.Path | None, steps: int, out: pathlib.Path, seed: int = 0) -> dict:
    vol_samples = btc_vol_samples(data) if data is not None and data.exists() else MarketParams().vol_samples
    params = MarketParams(vol_samples=vol_samples)
    env = MarketMakingEnv(params)

    # Baselines, tuned on training episodes.
    fixed_grid = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5]
    fixed_scores = {h: np.mean([r["objective"] for r in evaluate(env, lambda e, o, h=h: fixed_spread_action(h), TRAIN_SEEDS)]) for h in fixed_grid}
    best_half = max(fixed_scores, key=fixed_scores.get)

    def as_policy(gamma: float):
        return lambda e, o: action_for_distances(*avellaneda_stoikov(e.inventory, e.forecast_vol, gamma, params.depth_decay))

    gamma_grid = [0.003, 0.005, 0.01, 0.02, 0.03, 0.05, 0.1]
    as_scores = {g: np.mean([r["objective"] for r in evaluate(env, as_policy(g), TRAIN_SEEDS)]) for g in gamma_grid}
    best_gamma = max(as_scores, key=as_scores.get)

    # PPO. Rewards are normalised for learning; observations are already scaled, so the exported policy needs no statistics.
    training = replace(params, denoised_reward=True)
    venv = VecNormalize(DummyVecEnv([lambda: MarketMakingEnv(training)] * 8), norm_obs=False, norm_reward=True, gamma=0.999)
    venv.seed(10_000 + seed)  # training episodes continue from these seeds, far from the test seeds
    model = PPO(
        "MlpPolicy",
        venv,
        n_steps=1_800,  # two episodes per environment per update
        batch_size=3_600,
        n_epochs=10,
        gamma=0.999,
        gae_lambda=0.95,
        learning_rate=3e-4,
        clip_range=0.2,
        ent_coef=0.0,
        policy_kwargs={"net_arch": [64, 64], "log_std_init": -0.5},
        seed=seed,
        verbose=0,
        device="cpu",
    )
    model.learn(total_timesteps=steps)
    actor = Actor(model).eval()

    def ppo_policy(e, o):
        with torch.no_grad():
            return actor(torch.from_numpy(o[None, :])).numpy()[0]

    def oracle_policy(e, o):
        # Avellaneda-Stoikov plus the hidden trend, which no real strategy can see: an upper bound.
        b, a = avellaneda_stoikov(e.inventory, e.forecast_vol, best_gamma, params.depth_decay)
        s = -4.0 * e.trend
        return action_for_distances(b + s, a - s)

    runs = {
        "fixed_spread": evaluate(env, lambda e, o: fixed_spread_action(best_half), TEST_SEEDS),
        "avellaneda_stoikov": evaluate(env, as_policy(best_gamma), TEST_SEEDS),
        "ppo": evaluate(env, ppo_policy, TEST_SEEDS),
        "oracle_knows_trend": evaluate(env, oracle_policy, TEST_SEEDS),
    }
    results = {name: summary(r) for name, r in runs.items()}
    comparison = {
        "ppo_minus_as_objective": paired(runs["ppo"], runs["avellaneda_stoikov"]),
        "ppo_minus_as_pnl": paired(runs["ppo"], runs["avellaneda_stoikov"], "pnl"),
        "ppo_minus_fixed_objective": paired(runs["ppo"], runs["fixed_spread"]),
    }

    # What the policy learned, in its own terms: quotes as each input varies alone.
    def quotes_at(inventory: int, vol: float, imbalance: float) -> list[float]:
        o = observation(inventory, params.max_inventory, vol, imbalance)
        b, a = quotes_from_action(ppo_policy(None, o))
        return [round(b, 2), round(a, 2)]

    behaviour = {
        "by_inventory": {str(q): quotes_at(q, 20.0, 0.0) for q in (-8, -4, 0, 4, 8)},
        "by_volatility_bps": {str(v): quotes_at(0, v, 0.0) for v in (10, 20, 40, 80)},
        "by_imbalance": {str(i): quotes_at(0, 20.0, i) for i in (-0.6, -0.3, 0.0, 0.3, 0.6)},
    }

    out.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        actor,
        torch.zeros(1, 3),
        out / "mm-policy.onnx",
        input_names=["obs"],
        output_names=["action"],
        dynamic_axes={"obs": {0: "batch"}, "action": {0: "batch"}},
        dynamo=False,
    )
    rng = np.random.default_rng(7)
    cases = [observation(int(rng.integers(-10, 11)), params.max_inventory, float(np.exp(rng.uniform(np.log(5), np.log(150)))), float(rng.uniform(-1, 1))) for _ in range(20)]
    golden = [
        {"obs": [float(v) for v in o], "action": [float(v) for v in ppo_policy(None, o)], "quotes": list(quotes_from_action(ppo_policy(None, o)))}
        for o in cases
    ]
    manifest = {
        "version": 1,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "algorithm": "PPO (stable-baselines3), MLP 64x64, deterministic mean action",
        "timesteps": steps,
        "observation": ["inventory / max_inventory", "ln(forecast 15m volatility bps / 20), clipped to +-3", "order-flow imbalance (EWMA ~10 s), -1..1"],
        "action": {"half_spread_bps": [MIN_HALF_SPREAD, MAX_HALF_SPREAD], "max_skew_bps": MAX_SKEW, "step_seconds": 1},
        "environment": {k: v for k, v in params.__dict__.items() if k != "vol_samples"} | {"vol_samples": len(vol_samples), "vol_median_bps": round(float(np.median(vol_samples)), 2)},
        "baselines": {"fixed_half_spread_bps": best_half, "as_gamma": best_gamma},
        "test_episodes": len(TEST_SEEDS),
        "results": results,
        "comparison": comparison,
        "behaviour": behaviour,
        "golden": golden,
    }
    (out / "mm-policy.json").write_text(json.dumps(manifest, indent=2))
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=pathlib.Path, default=pathlib.Path("data/btcusdt_1m.csv"))
    parser.add_argument("--steps", type=int, default=2_000_000)
    parser.add_argument("--out", type=pathlib.Path, default=OUT)
    args = parser.parse_args()
    m = train(args.data, args.steps, args.out)
    print(f"baselines: fixed half spread {m['baselines']['fixed_half_spread_bps']} bps, AS gamma {m['baselines']['as_gamma']}")
    print(f"{'strategy':<20} {'objective':>10} {'PnL':>8} {'sd':>7} {'Sharpe':>7} {'fills':>6} {'|q|':>5}")
    for name, r in m["results"].items():
        print(f"{name:<20} {r['objective']:>10.1f} {r['pnl_mean']:>8.1f} {r['pnl_sd']:>7.1f} {r['sharpe_per_episode']:>7.2f} {r['fills']:>6.0f} {r['mean_abs_inventory']:>5.2f}")
    for name, c in m["comparison"].items():
        print(f"{name}: {c['mean']} (95% CI {c['ci95'][0]} to {c['ci95'][1]}), better in {c['a_better_share']:.0%} of episodes")
    print("learned behaviour (bid, ask distance in bps):")
    for name, b in m["behaviour"].items():
        print(f"  {name}: {b}")


if __name__ == "__main__":
    main()
