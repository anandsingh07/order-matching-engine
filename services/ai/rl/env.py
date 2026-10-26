"""A market-making environment in the Avellaneda-Stoikov tradition, plus the
two things the closed-form model leaves out and real market makers live with.

The market maker keeps one bid and one ask around the mid price. Every step is
one second:

1. Hidden state may change:
   - volatility regime: calm, or a burst at 3x (bursts start about every 7
     minutes and last about a minute);
   - trend: none, up or down (trends start about every 3 minutes and last
     about a minute).
2. Market orders arrive, Poisson with rate A per side. Each reaches a random
   depth from the mid, exponential with rate k (in bps), and fills our quote
   on that side if the quote is within reach: the AS fill probability
   exp(-k * delta). During a trend the flow leans with it (informed traders
   buy before a rise), which is adverse selection: the side that fills is the
   side about to lose.
3. The mid moves: trend drift plus volatility noise.

Reward: change in mark-to-market wealth, minus phi * inventory^2 (the risk of
holding it). At the end, the inventory is closed at a cost per unit.

What the agent sees is what the live bot can see: its inventory, the
gateway's volatility forecast (true volatility with forecast error), and the
public tape's buy/sell imbalance. Not the trend itself.

Units: prices in basis points of the starting price (the mid starts at
10,000), quantities in lots. Random draws never depend on the agent's quotes,
so with the same seed every strategy faces exactly the same order flow and
price path (common random numbers), and comparisons between them are paired.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import gymnasium as gym
import numpy as np

REFERENCE_VOL_BPS = 20.0  # a typical BTC 15-minute volatility; observations are relative to it
HORIZON_S = 900  # one forecast horizon, the volatility forecast's 15 minutes


@dataclass(frozen=True)
class MarketParams:
    arrival_rate: float = 1.0  # market orders per second, per side (A)
    depth_decay: float = 0.5  # k, per bp: an order reaches past 2 bps on average
    max_inventory: int = 10
    burst_multiplier: float = 3.0
    burst_start_rate: float = 1 / 400
    burst_end_rate: float = 1 / 60
    trend_start_rate: float = 1 / 180
    trend_end_rate: float = 1 / 60
    trend_drift_bps: float = 0.25  # per second while a trend lasts
    flow_lean: float = 0.6  # buy rate x (1 + lean) in an up-trend, sell rate x (1 - lean)
    forecast_noise: float = 0.2  # log-normal error of the volatility forecast
    inventory_penalty: float = 0.005  # phi, per lot^2 per second
    liquidation_cost_bps: float = 2.0  # per lot, to close what is left at the end
    episode_s: int = 900
    imbalance_decay: float = 0.1  # EWMA weight of the order-flow imbalance (about 10 s)
    # Training only: leave out inventory x price noise, which has mean zero
    # whatever the agent does but dominates every reward. Same objective in
    # expectation, far less variance. Evaluation always uses the real reward.
    denoised_reward: bool = False
    # 15-minute volatility for each episode, in bps; drawn from real BTC data by train.py.
    vol_samples: tuple[float, ...] = field(default=(REFERENCE_VOL_BPS,))


# ---- the action: how quotes are set ----

MIN_HALF_SPREAD, MAX_HALF_SPREAD = 0.25, 25.0  # bps
MAX_SKEW = 10.0  # bps


def quotes_from_action(action: np.ndarray) -> tuple[float, float]:
    """Action in [-1, 1]^2 -> (bid distance, ask distance) from the mid, in bps.

    a[0] sets the half spread on a log scale from 0.25 to 25 bps; a[1] shifts
    both quotes down (positive, leaning to sell) or up by up to 10 bps.
    """
    a0, a1 = float(np.clip(action[0], -1, 1)), float(np.clip(action[1], -1, 1))
    half = math.exp(math.log(MIN_HALF_SPREAD) + (a0 + 1) / 2 * (math.log(MAX_HALF_SPREAD) - math.log(MIN_HALF_SPREAD)))
    skew = a1 * MAX_SKEW
    return max(half + skew, 0.0), max(half - skew, 0.0)


def observation(inventory: int, max_inventory: int, forecast_vol_bps: float, imbalance: float) -> np.ndarray:
    """What the policy sees; the live bot builds the same vector (services/bots/src/rl-policy.ts)."""
    return np.array(
        [inventory / max_inventory, float(np.clip(math.log(forecast_vol_bps / REFERENCE_VOL_BPS), -3, 3)), float(np.clip(imbalance, -1, 1))],
        dtype=np.float32,
    )


class MarketMakingEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(self, params: MarketParams = MarketParams()) -> None:
        self.p = params
        self.observation_space = gym.spaces.Box(low=np.array([-1, -3, -1], dtype=np.float32), high=np.array([1, 3, 1], dtype=np.float32))
        self.action_space = gym.spaces.Box(low=-1, high=1, shape=(2,), dtype=np.float32)

    # The state is public so baselines and tests can read it.
    def reset(self, *, seed: int | None = None, options: dict | None = None) -> tuple[np.ndarray, dict]:
        super().reset(seed=seed)
        rng = self.np_random
        self.t = 0
        self.mid = 10_000.0
        self.cash = 0.0
        self.inventory = 0
        self.base_vol = float(rng.choice(self.p.vol_samples))  # 15-minute volatility, bps
        self.burst = False
        self.trend = 0
        self.buys_ewma = self.sells_ewma = 0.0
        self.fills = 0
        self.forecast_error = math.exp(self.p.forecast_noise * rng.standard_normal())
        return self._observe(), {}

    @property
    def vol(self) -> float:
        """Current true 15-minute volatility, bps."""
        return self.base_vol * (self.p.burst_multiplier if self.burst else 1.0)

    @property
    def forecast_vol(self) -> float:
        return self.vol * self.forecast_error

    @property
    def imbalance(self) -> float:
        total = self.buys_ewma + self.sells_ewma
        return 0.0 if total < 1e-9 else (self.buys_ewma - self.sells_ewma) / total

    @property
    def wealth(self) -> float:
        return self.cash + self.inventory * self.mid

    def _observe(self) -> np.ndarray:
        return observation(self.inventory, self.p.max_inventory, self.forecast_vol, self.imbalance)

    def step(self, action: np.ndarray) -> tuple[np.ndarray, float, bool, bool, dict]:
        p, rng = self.p, self.np_random
        bid_distance, ask_distance = quotes_from_action(action)
        before = self.wealth

        # 1. Hidden state. All draws happen whatever the quotes are (common random numbers).
        u_burst, u_trend, u_dir = rng.random(3)
        if self.burst:
            self.burst = u_burst >= p.burst_end_rate
        else:
            self.burst = u_burst < p.burst_start_rate
        if self.trend == 0:
            if u_trend < p.trend_start_rate:
                self.trend = 1 if u_dir < 0.5 else -1
        elif u_trend < p.trend_end_rate:
            self.trend = 0
        if rng.random() < 1 / HORIZON_S:  # the forecast is refreshed now and then, with new error
            self.forecast_error = math.exp(p.forecast_noise * rng.standard_normal())

        # 2. Market orders, leaning with the trend. Buyers lift our ask; sellers hit our bid.
        buy_rate = p.arrival_rate * (1 + p.flow_lean * self.trend)
        sell_rate = p.arrival_rate * (1 - p.flow_lean * self.trend)
        buy_reach = rng.exponential(1 / p.depth_decay, rng.poisson(buy_rate))
        sell_reach = rng.exponential(1 / p.depth_decay, rng.poisson(sell_rate))
        noise = rng.standard_normal()
        self.buys_ewma += p.imbalance_decay * (len(buy_reach) - self.buys_ewma)
        self.sells_ewma += p.imbalance_decay * (len(sell_reach) - self.sells_ewma)

        bid, ask = self.mid - bid_distance, self.mid + ask_distance
        for _ in range(int(np.sum(sell_reach >= bid_distance))):
            if self.inventory >= p.max_inventory:
                break
            self.inventory += 1
            self.cash -= bid
            self.fills += 1
        for _ in range(int(np.sum(buy_reach >= ask_distance))):
            if self.inventory <= -p.max_inventory:
                break
            self.inventory -= 1
            self.cash += ask
            self.fills += 1

        # 3. The price moves.
        sigma_per_second = self.vol / math.sqrt(HORIZON_S)
        shock = sigma_per_second * noise
        self.mid += p.trend_drift_bps * self.trend + shock

        self.t += 1
        change = self.wealth - before
        if p.denoised_reward:
            change -= self.inventory * shock
        reward = change - p.inventory_penalty * self.inventory**2
        done = self.t >= p.episode_s
        if done:
            reward -= p.liquidation_cost_bps * abs(self.inventory)
        return self._observe(), float(reward), False, done, {}


# ---- baselines ----


def fixed_spread_action(half_spread: float) -> np.ndarray:
    """A constant half spread and no skew."""
    a0 = 2 * (math.log(half_spread) - math.log(MIN_HALF_SPREAD)) / (math.log(MAX_HALF_SPREAD) - math.log(MIN_HALF_SPREAD)) - 1
    return np.array([a0, 0.0], dtype=np.float32)


def avellaneda_stoikov(inventory: int, forecast_vol_bps: float, gamma: float, k: float, horizon_s: float = 60.0) -> tuple[float, float]:
    """The Avellaneda-Stoikov (2008) quotes: (bid distance, ask distance) from the mid, in bps.

    Reservation price: mid - q * gamma * sigma^2 * T. Optimal total spread:
    gamma * sigma^2 * T + (2 / gamma) * ln(1 + gamma / k). Run with a rolling
    horizon T, since a live market maker has no closing time.
    """
    var_per_second = (forecast_vol_bps / math.sqrt(HORIZON_S)) ** 2
    skew = inventory * gamma * var_per_second * horizon_s
    half = 0.5 * gamma * var_per_second * horizon_s + math.log(1 + gamma / k) / gamma
    return max(half + skew, 0.0), max(half - skew, 0.0)


def action_for_distances(bid_distance: float, ask_distance: float) -> np.ndarray:
    """The action giving these quote distances (within the action's range)."""
    half = min(max((bid_distance + ask_distance) / 2, MIN_HALF_SPREAD), MAX_HALF_SPREAD)
    skew = float(np.clip((bid_distance - ask_distance) / 2, -MAX_SKEW, MAX_SKEW))
    a0 = 2 * (math.log(half) - math.log(MIN_HALF_SPREAD)) / (math.log(MAX_HALF_SPREAD) - math.log(MIN_HALF_SPREAD)) - 1
    return np.array([a0, skew / MAX_SKEW], dtype=np.float32)


def run_episode(env: MarketMakingEnv, policy, seed: int) -> dict:
    """Runs one episode; `policy(env, obs)` returns an action. Returns the episode's results."""
    obs, _ = env.reset(seed=seed)
    total, inventory_abs, done = 0.0, 0.0, False
    while not done:
        obs, reward, _, done, _ = env.step(policy(env, obs))
        total += reward
        inventory_abs += abs(env.inventory)
    pnl = env.wealth - env.p.liquidation_cost_bps * abs(env.inventory)
    return {"objective": total, "pnl": pnl, "fills": env.fills, "mean_abs_inventory": inventory_abs / env.p.episode_s}
