"""Tests for the market-making environment: the fill model, the accounting,
the limits, paired randomness, and the Avellaneda-Stoikov baseline. Training
(PPO) is not run here; it needs PyTorch and minutes."""

import math
from dataclasses import replace

import numpy as np
import pytest
from gymnasium.utils.env_checker import check_env

from rl.env import (
    MarketMakingEnv,
    MarketParams,
    action_for_distances,
    avellaneda_stoikov,
    fixed_spread_action,
    quotes_from_action,
    run_episode,
)

QUIET = replace(MarketParams(), trend_start_rate=0.0, burst_start_rate=0.0)


def test_is_a_valid_gymnasium_environment() -> None:
    check_env(MarketMakingEnv(), skip_render_check=True)


def test_quotes_fill_with_the_avellaneda_stoikov_probability() -> None:
    # Without inventory limits or trends, fills per second per side = A * exp(-k * delta).
    params = replace(QUIET, max_inventory=1_000_000, episode_s=20_000)
    env = MarketMakingEnv(params)
    for delta in (1.0, 3.0):
        result = run_episode(env, lambda e, o, d=delta: action_for_distances(d, d), seed=1)
        expected = 2 * params.arrival_rate * math.exp(-params.depth_decay * delta) * params.episode_s
        assert result["fills"] == pytest.approx(expected, rel=0.05)


def test_same_seed_same_market_whatever_the_quotes() -> None:
    # Common random numbers: the price path cannot depend on the strategy.
    env = MarketMakingEnv()
    paths = []
    for half in (0.5, 5.0):
        env.reset(seed=42)
        path = []
        for _ in range(300):
            env.step(fixed_spread_action(half))
            path.append((env.mid, env.trend, env.burst))
        paths.append(path)
    assert paths[0] == paths[1]


def test_rewards_add_up_to_pnl_minus_the_inventory_penalty() -> None:
    env = MarketMakingEnv()
    obs, _ = env.reset(seed=3)
    total, penalty, done = 0.0, 0.0, False
    while not done:
        obs, reward, _, done, _ = env.step(fixed_spread_action(1.0))
        total += reward
        penalty += env.p.inventory_penalty * env.inventory**2
    pnl = env.wealth - env.p.liquidation_cost_bps * abs(env.inventory)
    assert total == pytest.approx(pnl - penalty)


def test_denoised_training_reward_has_the_same_mean_and_less_variance() -> None:
    # The same episodes, scored both ways: the noise left out has mean zero...
    real = MarketMakingEnv(MarketParams())
    denoised = MarketMakingEnv(replace(MarketParams(), denoised_reward=True))
    a = [run_episode(real, lambda e, o: fixed_spread_action(1.5), s)["objective"] for s in range(200)]
    b = [run_episode(denoised, lambda e, o: fixed_spread_action(1.5), s)["objective"] for s in range(200)]
    assert np.mean(b) == pytest.approx(np.mean(a), abs=3 * np.std(np.subtract(a, b)) / np.sqrt(200))

    # ...and it is most of the noise in each step's reward, which is what the learner sees.
    def step_rewards(env: MarketMakingEnv) -> np.ndarray:
        env.reset(seed=1)
        return np.array([env.step(fixed_spread_action(1.5))[1] for _ in range(900)])

    assert np.std(step_rewards(denoised)) < 0.5 * np.std(step_rewards(real))


def test_inventory_never_breaches_the_limit() -> None:
    env = MarketMakingEnv(replace(MarketParams(), max_inventory=3))
    env.reset(seed=5)
    for _ in range(900):
        env.step(np.array([-1.0, 1.0]))  # tightest quotes, leaning hard to one side
        assert abs(env.inventory) <= 3


def test_informed_flow_leans_with_the_trend() -> None:
    params = replace(QUIET, max_inventory=1_000_000, episode_s=5_000)
    env = MarketMakingEnv(params)
    env.reset(seed=9)
    env.trend = 1  # force an up-trend that never ends
    env.p = replace(params, trend_end_rate=0.0)
    for _ in range(5_000):
        env.step(action_for_distances(0.0, 0.0))  # at the mid, every order fills us
    # Buyers lift our ask more often than sellers hit our bid, so we end up short into a rise.
    assert env.inventory < -2_000
    assert env.imbalance > 0.4


def test_action_mapping_round_trips() -> None:
    for bid, ask in [(1.0, 1.0), (3.0, 0.5), (0.4, 7.0)]:
        b, a = quotes_from_action(action_for_distances(bid, ask))
        assert (b, a) == (pytest.approx(bid), pytest.approx(ask))
    assert quotes_from_action(fixed_spread_action(2.0)) == (pytest.approx(2.0), pytest.approx(2.0))


def test_avellaneda_stoikov_quotes() -> None:
    bid, ask = avellaneda_stoikov(0, 20.0, 0.03, 0.5)
    assert bid == pytest.approx(ask)
    assert bid == pytest.approx(0.5 * 0.03 * (20 / 30) ** 2 * 60 + math.log(1 + 0.03 / 0.5) / 0.03)
    long_bid, long_ask = avellaneda_stoikov(5, 20.0, 0.03, 0.5)
    assert long_ask < ask and long_bid > bid  # long: keen to sell, reluctant to buy
    assert avellaneda_stoikov(0, 60.0, 0.03, 0.5)[0] > bid  # wider when volatile


def test_avellaneda_stoikov_beats_a_fixed_spread() -> None:
    # The textbook result, and a sanity check on the environment: inventory-aware quoting wins.
    env = MarketMakingEnv()
    seeds = range(30)
    fixed = np.mean([run_episode(env, lambda e, o: fixed_spread_action(2.0), s)["objective"] for s in seeds])
    stoikov = np.mean(
        [run_episode(env, lambda e, o: action_for_distances(*avellaneda_stoikov(e.inventory, e.forecast_vol, 0.02, 0.5)), s)["objective"] for s in seeds]
    )
    assert stoikov > fixed
