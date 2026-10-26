"""Watch the RL market maker learn, live.

Trains a fresh PPO policy from scratch and, every `--every` steps, scores it
on the same unseen episodes as Avellaneda-Stoikov, so you can see it go from
random quoting to beating the textbook strategy. Nothing is saved: the
shipped policy in services/bots/models is untouched.

    python -m rl.watch --steps 400000
"""

from __future__ import annotations

import argparse
import pathlib
import sys
import time
from dataclasses import replace

import numpy as np
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.vec_env import DummyVecEnv, VecNormalize

from .env import MarketMakingEnv, MarketParams, action_for_distances, avellaneda_stoikov, run_episode
from .train import Actor, btc_vol_samples

EVAL_SEEDS = range(3_000_000, 3_000_010)  # unseen by training
AS_GAMMA = 0.03  # the risk aversion train.py tuned for the baseline


def score(env: MarketMakingEnv, policy) -> float:
    return float(np.mean([run_episode(env, policy, s)["objective"] for s in EVAL_SEEDS]))


class Progress(BaseCallback):
    """Every `every` steps: evaluate the current policy and print one line."""

    def __init__(self, env: MarketMakingEnv, baseline: float, every: int, total: int) -> None:
        super().__init__()
        self.env, self.baseline, self.every, self.total = env, baseline, every, total
        self.next = every
        self.start = time.time()

    def _on_step(self) -> bool:
        if self.num_timesteps < self.next:
            return True
        self.next += self.every
        actor = Actor(self.model).eval()

        def policy(e, o):
            with torch.no_grad():
                return actor(torch.from_numpy(o[None, :])).numpy()[0]

        ppo = score(self.env, policy)
        done = self.num_timesteps / self.total
        bar = "#" * int(done * 30) + "." * (30 - int(done * 30))
        verdict = "beats AS" if ppo > self.baseline else "below AS"
        print(f"[{bar}] {self.num_timesteps:>9,} steps {time.time() - self.start:>6.0f}s | PPO {ppo:>7.1f} vs AS {self.baseline:>6.1f}  {verdict}", flush=True)
        return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--steps", type=int, default=400_000)
    parser.add_argument("--every", type=int, default=40_000)
    parser.add_argument("--data", type=pathlib.Path, default=pathlib.Path("data/btcusdt_1m.csv"))
    args = parser.parse_args()

    params = MarketParams(vol_samples=btc_vol_samples(args.data) if args.data.exists() else MarketParams().vol_samples)
    env = MarketMakingEnv(params)
    baseline = score(env, lambda e, o: action_for_distances(*avellaneda_stoikov(e.inventory, e.forecast_vol, AS_GAMMA, params.depth_decay)))
    print(f"Objective = profit minus inventory risk, averaged over {len(EVAL_SEEDS)} unseen 15-minute episodes.", flush=True)
    print(f"Avellaneda-Stoikov (the textbook strategy) scores {baseline:.1f}. Training PPO from scratch...\n", flush=True)

    training = replace(params, denoised_reward=True)
    venv = VecNormalize(DummyVecEnv([lambda: MarketMakingEnv(training)] * 8), norm_obs=False, norm_reward=True, gamma=0.999)
    venv.seed(20_000)
    model = PPO("MlpPolicy", venv, n_steps=1_800, batch_size=3_600, n_epochs=10, gamma=0.999, gae_lambda=0.95,
                learning_rate=3e-4, policy_kwargs={"net_arch": [64, 64], "log_std_init": -0.5}, seed=1, verbose=0, device="cpu")
    model.learn(total_timesteps=args.steps, callback=Progress(env, baseline, args.every, args.steps))
    print("\nDone. (Nothing saved; the full run is `python -m rl.train --steps 5000000`.)", flush=True)
    sys.exit(0)


if __name__ == "__main__":
    main()
