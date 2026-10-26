"""Downloads real 1-minute BTC/USDT candles from Binance's public market-data API (no key needed).

    python -m volatility.data --days 90 --out data/btcusdt_1m.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import pathlib
import time
import urllib.request

HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"]
MINUTE_MS = 60_000
PAGE = 1_000  # the API's maximum candles per request


def fetch_page(symbol: str, start_ms: int) -> list[list]:
    last_error: Exception | None = None
    for host in HOSTS:
        url = f"{host}/api/v3/klines?symbol={symbol}&interval=1m&limit={PAGE}&startTime={start_ms}"
        try:
            with urllib.request.urlopen(url, timeout=20) as response:
                return json.loads(response.read())
        except Exception as error:  # try the next host
            last_error = error
    raise RuntimeError(f"all Binance hosts failed: {last_error}")


def download(symbol: str, days: int, out: pathlib.Path) -> int:
    end = int(time.time() * 1000) // MINUTE_MS * MINUTE_MS
    start = end - days * 24 * 60 * MINUTE_MS
    rows: list[list] = []
    cursor = start
    while cursor < end:
        page = fetch_page(symbol, cursor)
        if not page:
            break
        rows.extend(k for k in page if k[0] < end)
        cursor = page[-1][0] + MINUTE_MS
        time.sleep(0.1)  # stay well inside the public rate limit
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["open_time", "open", "high", "low", "close", "volume", "trades"])
        for k in rows:
            writer.writerow([k[0], k[1], k[2], k[3], k[4], k[5], k[8]])
    return len(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", default="BTCUSDT")
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument("--out", type=pathlib.Path, default=pathlib.Path("data/btcusdt_1m.csv"))
    args = parser.parse_args()
    n = download(args.symbol, args.days, args.out)
    print(f"wrote {n} one-minute candles ({n / 1440:.1f} days) to {args.out}")


if __name__ == "__main__":
    main()
