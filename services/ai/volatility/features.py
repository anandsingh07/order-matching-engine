"""Volatility features from 1-minute bars.

The live gateway computes the same features in TypeScript
(packages/volatility/src/features.ts). A golden file written by train.py
holds sample bars with the features computed here; a TypeScript test must
reproduce them, so the two implementations cannot drift apart.

Definitions, at the close of minute t:
  r_i       = ln(close_i / close_{i-1})                        one-minute log return
  rv(k)     = sqrt(sum of r_i^2 over the last k minutes) * sqrt(15 / k)
              realised volatility over k minutes, rescaled to a 15-minute horizon
              (with fewer than k minutes of history, the minutes available are used)
  range15   = ln(max high / min low) over the last 15 minutes
  features  = ln(rv(5)), ln(rv(15)), ln(rv(60)), ln(rv(240)), ln(range15)    (floored at 1e-6)
  target    = ln(sqrt(sum of r_i^2 over the next 15 minutes))
"""

from __future__ import annotations

import numpy as np

WINDOWS = (5, 15, 60, 240)
HORIZON = 15
FLOOR = 1e-6
FEATURE_NAMES = [f"log_rv_{k}m" for k in WINDOWS] + ["log_range_15m"]


def log_returns(close: np.ndarray) -> np.ndarray:
    """r[0] is 0: the first bar has no previous close."""
    r = np.zeros_like(close, dtype=np.float64)
    r[1:] = np.log(close[1:] / close[:-1])
    return r


def _trailing_sum(x: np.ndarray, k: int) -> np.ndarray:
    """Sum over the last k values ending at each index (fewer at the start)."""
    c = np.concatenate([[0.0], np.cumsum(x)])
    idx = np.arange(1, len(x) + 1)
    return c[idx] - c[np.maximum(0, idx - k)]


def features(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    """One row of features per minute, using only that minute and earlier ones."""
    r2 = log_returns(close) ** 2
    n = np.arange(1, len(close) + 1)
    columns = []
    for k in WINDOWS:
        used = np.minimum(n, k)
        rv = np.sqrt(_trailing_sum(r2, k)) * np.sqrt(HORIZON / used)
        columns.append(np.log(np.maximum(rv, FLOOR)))
    # Rolling max/min over 15 minutes.
    hi = np.array([high[max(0, i - HORIZON + 1) : i + 1].max() for i in range(len(high))])
    lo = np.array([low[max(0, i - HORIZON + 1) : i + 1].min() for i in range(len(low))])
    columns.append(np.log(np.maximum(np.log(hi / lo), FLOOR)))
    return np.column_stack(columns)


def target(close: np.ndarray) -> np.ndarray:
    """ln realised volatility over the next 15 minutes; NaN where the future is not known."""
    r2 = log_returns(close) ** 2
    future = np.full(len(close), np.nan)
    c = np.concatenate([[0.0], np.cumsum(r2)])
    for i in range(len(close) - HORIZON):
        future[i] = c[i + 1 + HORIZON] - c[i + 1]
    return np.log(np.maximum(np.sqrt(future), FLOOR))
