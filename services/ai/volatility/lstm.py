"""The recurrent-network forecaster, kept apart so the rest of the pipeline (and its tests) runs without PyTorch."""

from __future__ import annotations

import numpy as np
import torch
from torch import nn

LOOKBACK = 60  # minutes the LSTM sees


class Lstm(nn.Module):
    def __init__(self, channels: int) -> None:
        super().__init__()
        self.lstm = nn.LSTM(channels, 32, batch_first=True)
        self.head = nn.Linear(32, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out, _ = self.lstm(x)
        return self.head(out[:, -1, :]).squeeze(-1)


def lstm_inputs(high: np.ndarray, low: np.ndarray, close: np.ndarray, r: np.ndarray) -> np.ndarray:
    """Per minute: ln squared return and ln one-minute range."""
    return np.column_stack([np.log(r**2 + 1e-12), np.log(np.maximum(np.log(high / low), 1e-6))]).astype(np.float32)


def train_lstm(seq: np.ndarray, y: np.ndarray, train_idx: np.ndarray, val_idx: np.ndarray) -> tuple[Lstm, dict, np.ndarray]:
    torch.manual_seed(0)
    mean, std = seq[train_idx].mean(axis=0), seq[train_idx].std(axis=0) + 1e-6
    norm = (seq - mean) / std
    windows = np.lib.stride_tricks.sliding_window_view(norm, (LOOKBACK, norm.shape[1]))[:, 0]  # window i ends at minute i + LOOKBACK - 1

    def batch(idx: np.ndarray) -> torch.Tensor:
        return torch.from_numpy(np.ascontiguousarray(windows[idx - LOOKBACK + 1]))

    model = Lstm(norm.shape[1])
    optimiser = torch.optim.Adam(model.parameters(), lr=2e-3)
    y_t = torch.from_numpy(y.astype(np.float32))
    best, best_state, patience = np.inf, None, 0
    rng = np.random.default_rng(0)
    for _epoch in range(12):
        model.train()
        for chunk in np.array_split(rng.permutation(train_idx[::2]), max(1, len(train_idx) // 1024)):
            optimiser.zero_grad()
            loss = nn.functional.mse_loss(model(batch(chunk)), y_t[chunk])
            loss.backward()
            optimiser.step()
        model.eval()
        with torch.no_grad():
            val_loss = float(nn.functional.mse_loss(model(batch(val_idx)), y_t[val_idx]))
        if val_loss < best - 1e-4:
            best, best_state, patience = val_loss, {k: v.clone() for k, v in model.state_dict().items()}, 0
        else:
            patience += 1
            if patience >= 2:
                break
    model.load_state_dict(best_state)
    model.eval()
    return model, {"mean": mean.tolist(), "std": std.tolist()}, windows


def predict_lstm(model: Lstm, windows: np.ndarray, idx: np.ndarray) -> np.ndarray:
    with torch.no_grad():
        out = [model(torch.from_numpy(np.ascontiguousarray(windows[c - LOOKBACK + 1]))).numpy() for c in np.array_split(idx, max(1, len(idx) // 4096))]
    return np.concatenate(out)
