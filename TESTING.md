# How to test this project

All commands are for **PowerShell** on Windows. Run them from the project folder:

```powershell
cd C:\Anand\public\order-matching-engine
```

## 1. First-time setup

```powershell
pnpm install
```

You need Node.js 24+ and pnpm (`npm install -g pnpm` if it is missing).

Optional extras, each needed only for one part:

- **Ollama**, for plain-English orders read by the local model: install it, then `ollama pull qwen2.5:1.5b` (and `qwen2.5:3b` for the full evaluation). Without it, the built-in rules answer alone and the 6 live tests skip.
- **Rust**, only to rebuild the WebAssembly engine after changing `packages/engine-rs/rust/`: rustup, then `rustup target add wasm32-unknown-unknown`. The built `wasm/engine.wasm` is committed, so the tests and benchmark do not need it. See [section 11](#11-windows-smart-app-control) for which toolchain works on this laptop.
- **Python 3.12**, for the model-training tests (below).

## 2. Run everything

```powershell
pnpm typecheck   # TypeScript finds type errors without running anything
pnpm test        # runs every test in every package (a few minutes; the live surveillance tests, the Rust parity suite and the backtester take longest)
```

A healthy run ends with lines like these for each package (629 tests across 14 packages):

```
packages/pricing test:       Tests  13 passed (13)
packages/volatility test:    Tests  17 passed (17)
packages/client test:        Tests  10 passed (10)
packages/core test:          Tests  52 passed (52)
apps/terminal test:          Tests  47 passed (47)
packages/journal test:       Tests  17 passed (17)
packages/surveillance test:  Tests  14 passed (14)
packages/nl-orders test:     Tests  138 passed (138)
packages/engine-rs test:     Tests  69 passed (69)
packages/exchange test:      Tests  30 passed (30)
packages/replication test:   Tests  8 passed (8)
services/gateway test:       Tests  123 passed (123)
services/bots test:          Tests  28 passed (28)
packages/backtest test:      Tests  63 passed (63)
```

The 6 live tests in `nl-orders` talk to a real Ollama. If Ollama is not running, vitest reports them as skipped instead of passed.

The model-training tests are Python:

```powershell
cd services\ai
.\.venv\Scripts\python.exe -m pytest -q      # 22 passed
cd ..\..
```

(First time only: `py -3.12 -m venv services\ai\.venv`, then `services\ai\.venv\Scripts\pip install -r services\ai\requirements.txt`. If Smart App Control blocks a pandas DLL, see [section 11](#11-windows-smart-app-control). *Training* also needs PyTorch and stable-baselines3, for the volatility LSTM and the RL market maker: `pip install torch --index-url https://download.pytorch.org/whl/cpu` and `pip install "stable-baselines3>=2.4"`. The tests do not.)

Browser end-to-end tests are separate, because they start servers and a real browser (8 tests, a couple of minutes):

```powershell
pnpm --filter @ome/terminal exec playwright install chromium   # first time only
pnpm e2e
```

The e2e gateway points `OLLAMA_URL` at a closed port, so the plain-English test runs the same with or without Ollama on this machine, and in CI.

The terminal's lint and production build are checked too (CI runs both):

```powershell
pnpm --filter @ome/terminal lint
pnpm --filter @ome/terminal build     # routes /, /leaderboard and /surveillance
```

## 3. Run one package or one file

```powershell
pnpm --filter @ome/core test                       # just the matching engine
pnpm --filter @ome/journal test                    # just durability / crash tests
pnpm --filter @ome/exchange test                   # just worker threads / ring buffer
pnpm --filter @ome/engine-rs test                  # the Rust engine's parity suite (~20 s on a quiet machine)
pnpm --filter @ome/backtest test                   # the backtester
pnpm --filter @ome/nl-orders test                  # plain-English orders
pnpm --filter @ome/pricing test                    # Black-Scholes and implied volatility

cd packages\core
pnpm vitest run test/advanced-orders.test.ts       # one file
pnpm vitest run -t "iceberg"                       # only tests whose name contains "iceberg"
pnpm vitest                                        # watch mode: re-runs as you edit (q to quit)
cd ..\..

pnpm --filter @ome/gateway exec vitest run test/tournaments.test.ts test/tournament-gateway.test.ts   # just tournaments
```

To run the black-box gateway tests through 2 front-end processes instead of one:

```powershell
$env:GATEWAY_TEST_PROCESSES = "2"; pnpm --filter @ome/gateway exec vitest run test/gateway.test.ts; Remove-Item Env:GATEWAY_TEST_PROCESSES
```

## 4. What each kind of test proves

| Test file | Type | What it proves |
|---|---|---|
| `core/test/order-book.test.ts` | Unit tests | Each rule on its own: price-time priority, IOC, FOK, cancel, amend, rejections |
| `core/test/advanced-orders.test.ts` | Unit tests | Icebergs, self-trade prevention, stop orders and stop cascades |
| `core/test/differential.test.ts` | **Differential fuzzing** | The fast engine gives *exactly* the same events as a slow, simple reference engine for thousands of random command sequences |
| `core/test/invariants.test.ts` | **Property tests** | Rules that must always hold: the book is never crossed, quantity is never created or lost |
| `core/test/snapshot.test.ts` | Property test | A book restored from a snapshot behaves identically from then on |
| `core/test/auction.test.ts` | Unit tests | Call auction: max-volume price, every tie-break, icebergs, stops after the uncross |
| `engine-rs/test/parity.test.ts` | **Differential parity** | The Rust/WebAssembly engine gives byte-identical events and state to the TypeScript engine on 450,000 seeded commands (indicative auction compared after every command while an auction is open) and on random, hostile, FOK-heavy and near-2^53 sequences |
| `engine-rs/test/core-suite.test.ts` | Reused suite | The core engine's own unit, invariant, snapshot and reference-differential tests pass unchanged against the Rust engine |
| `engine-rs/test/rust-order-book.test.ts` | Unit tests | Snapshots cross between the two engines; id handles are recycled; wasm memory can grow mid-command; f64 rounding in auction totals past 2^53 is pinned; out-of-type enum strings are refused; both engines fail the same way on the known 2^53 auction overflow |
| `journal/test/journal.test.ts` | Failure tests | Torn writes, corrupt files, snapshot fallback and pruning |
| `journal/test/crash.test.ts` | **Real crash test** | Kills the engine process 6 times; every acknowledged order is recovered |
| `exchange/test/ring-buffer.test.ts` | Concurrency test | 200,000 messages between two real threads arrive intact and in order |
| `exchange/test/exchange.test.ts` | Equivalence test | Multi-threaded exchange equals the single-threaded engine, per symbol; symbols listed while running match too, go to the least-loaded worker, are refused once delisted, and recover from disk |
| `exchange/test/codec.test.ts` | Round-trip property test | Binary encoding loses nothing (NaN, -0, Unicode, missing fields) |
| `gateway/test/gateway.test.ts` | Integration (real sockets) | Auth, validation, rate limits, trader isolation, private fills, **no id leaks**; a connection's commands reach the engine in the order sent (a cancel right behind its order cannot overtake it) |
| `gateway/test/accounts.test.ts` | Unit tests | Cash, P&L, exposure, buying power, fat-finger limits, when to liquidate; futures and option margins, partial closes, closing orders net of resting ones; what counts as flat for a tournament |
| `gateway/test/market-control.test.ts` | Integration | Opening auction, circuit-breaker halt and reopen, price bands, liquidation end to end |
| `gateway/test/wire.test.ts` | Unit tests | The front-end link codec: orders, cancels and amends round-trip; acks, rejects and execution reports rebuild to byte-identical JSON; frames split at any byte reassemble; corrupt frames close the link |
| `gateway/test/cluster.test.ts` | Integration (3 real front-end processes) | Fills reach only their owner on any front-end; 100 duplicate client ids through two front-ends give one ack each; 30 subscribers get every trade once, in order; 200 order-then-cancel pairs stay in order; `welcome` comes first for eager connections; a browser abort of a plain-English parse frees the trader's model slot; front-end crash and reconnect; no processes left after close |
| `gateway/test/derivatives.test.ts` | Unit tests | Series listing on the expiry cycle; option values and bands; the settlement price is the last minute's VWAP, barely moved by a last-second print, with its fallbacks |
| `gateway/test/expiry.test.ts` | Integration | A call and a future trade and cash-settle at Rs 4,127.50 to the paisa; derivatives halt with their underlying; trading stops at the expiry instant; a burst of one-contract sells cannot open an unmargined short |
| `gateway/test/tournaments.test.ts` | Unit + property tests | FX conversion, drawdown and Sharpe by hand; ranking tie-breaks, identical under 20 shuffles of 500 seeded near-tie fields; every join rule; sign-ups for the next tournament; frozen results; rolling slots |
| `gateway/test/tournament-gateway.test.ts` | Integration (real gateway, injected clock) | Alice +1.00% rank 1, Bob −0.526% rank 2, bots absent; trades after the end change nothing; the order/join race is refused; a sign-up is entered at the end; an uncross and a future expiry at the end are valued at the end's mark |
| `gateway/test/parse-order.test.ts` | Integration (fake Ollama) | `POST /api/parse-order`: 401/400/413; exact rules order; live-price warnings; the model path; a hijacked-model cancel refused; spot only; fallback sentences never contain the Ollama URL; a hung parser cut off with a 503; one model request per trader; `llm` ignored in hybrid; per-trader 429; warm-up and close |
| `client/test/parse-order.test.ts` | Unit tests | The client's plain-English call: Bearer token and body; replies passed through; 401/404/429 and network errors; an abort rethrows |
| `pricing/test/pricing.test.ts` | **Property tests** + textbook cases | Put-call parity, no-arbitrage bounds, monotonicity, Greeks against finite differences, implied-volatility round trips (2,000 random options each); Hull's examples; a normal CDF accurate to 2e-16 |
| `bots/test/quotes.test.ts` | Property tests | Market-maker quotes are always valid: tick grid, never crossed, limits respected |
| `bots/test/market.test.ts` | Integration | Real bots on a real gateway make a working market |
| `bots/test/derivatives.test.ts` | Property tests + integration | Options quotes (3,000 cases) stay on the tick grid, uncrossed and inside the no-arbitrage bounds; the desk hedges a customer's call purchase in the stock on a real gateway; requoting by amend |
| `terminal/src/lib/lib.test.ts` | Unit tests | Order lifecycle, P&L maths, depth ladder, order-form parsing |
| `terminal/src/lib/derivatives.test.ts` | Unit tests | The option chain: grouping, implied volatility and delta from the mid, in-the-money sides, contract terms, countdown |
| `terminal/src/lib/leaderboard.test.ts` | Unit tests | Tournament ordering, countdowns, signed returns, when to offer Join or show "signed up" |
| `terminal/src/lib/nl-order.test.ts` | Unit tests | Plain-English proposals round-trip through the ticket's own `buildOrder`; warnings when the ticket cannot send a time in force; stale replies dropped |
| `terminal/e2e/terminal.spec.ts` | **Browser end-to-end** | A real person's flows in Chromium: trade, cancel, validation, click-to-fill, price bands, a circuit-breaker halt |
| `terminal/e2e/nl-order.spec.ts` | **Browser end-to-end** | A typed order becomes a proposal, prefills the ticket, and nothing is sent until the user presses Buy; a typed cancel; the no-model message; Esc and Discard; the FOK warning |
| `nl-orders/test/rules.test.ts`, `numbers.test.ts` | Unit + property tests | Numbers as people write them (exact decimals, commas only when they group thousands), names and typos, every refusal, and the rule parser never guesses |
| `nl-orders/test/validate.test.ts` | Unit + **property tests** | Exact integer ticks, tick/lot checks, missing fields, stops that would trigger at once; any valid order round-trips |
| `nl-orders/test/ground.test.ts` | Unit tests | The text check: dropped, invented or duplicated numbers, sides and instruments the text does not name, type and TIF words, cancels wider than the text, a condition read as a limit |
| `nl-orders/test/parse.test.ts` | Integration (mock Ollama, port 0) | Structured-output request, user text kept as data, timeouts, no Ollama, fallback, the busy message only when the model would have been asked |
| `nl-orders/test/fixtures.test.ts` | Label checks + regression | 287 labelled phrasings are valid orders; the rules' exact pass counts are pinned, with zero wrong proposals |
| `nl-orders/test/ticket.test.ts` | Contract test | Proposals prefilled into the terminal's real ticket build back into the same order |
| `nl-orders/test/live.test.ts` | **Live** (skips without Ollama) | The default model through real Ollama: the right order or "unclear", never a different order |
| `backtest/test/engine.test.ts` | Unit + **property tests** | Hand-computed scenarios with exact P&L; a plain limit through the touch takes liquidity; quotes a print proves crossed; latency and a too-late cancel; fees and rebates; nothing is visible a millisecond before a trade; `cash + position × mark` = fills' gains − fees for random tapes and actions |
| `backtest/test/strategies.test.ts` | **Integration on real data** | The backtest's RL and AS orders equal the live bots' second by second; all four strategies run on 30 real minutes of BTC/USDT deterministically, books straight; rewriting the future changes nothing before it; the MA crossover trades the right way |
| `backtest/test/windows.test.ts` | Unit + integration | Windows partition the tape exactly; each starts with the forecast the continuous run had; paired differences and Student-t intervals by hand |
| `backtest/test/data.test.ts` | Unit tests | Every input format reads the same real trades; over-precise values fail; the downloader pages (past a quiet first hour too), refuses gaps, honours 429 and the weight limit, falls back to the other host |
| `backtest/test/report.test.ts` | Unit tests | The HTML report is self-contained and escapes everything; dates appear when a run crosses midnight |
| `surveillance/test/features.test.ts` | Unit tests | Each surveillance feature on hand-written events; the simulator is deterministic |
| `surveillance/test/model.test.ts` | **ML evaluation** | The shipped ONNX models on fresh unseen markets: catches manipulation, rarely flags honest traders, catches the unseen kind |
| `bots/test/surveillance.test.ts` | **Live end to end** | Manipulator bots trade over WebSocket; every one must be flagged |
| `services/ai/tests/test_surveillance.py` | Python | No data leaks between train/validation/test; the ONNX export matches the trained model |
| `services/ai/tests/test_volatility.py` | Python | Features and target never see the future; EWMA, GARCH, QLIKE and Diebold-Mariano behave as the maths says; `golden.json` matches the Python code |
| `volatility/test/parity.test.ts` | **Cross-language parity** | TypeScript computes the same features and forecasts as Python on real BTC bars, to 9 decimal places |
| `volatility/test/forecaster.test.ts` | Unit tests | Minute bars from trades (including empty minutes), warm-up, recovers a known volatility, no look-ahead |
| `gateway/test/market-control.test.ts` (volatility) | Integration | A calm quarter-hour tightens the band to 2%, rejects an order the static band allowed, and halts on a 1.5% jump |
| `replication/test/replication.test.ts` | Integration (real TCP) | Replica state equals the primary's; sync mode waits for the replica; catch-up from the backlog or a snapshot; promotion with a higher epoch; fencing; an old primary's unacknowledged commands are discarded |
| `replication/test/failover.test.ts` | **Real failover test** | Two node processes; the primary is `SIGKILL`ed 4 times mid-trading; every acknowledged command survives; roles swap; both disks equal a reference replay |
| `surveillance/test/monitor.test.ts` | Unit tests | Shadow mode: no alerts while shadowing; per-symbol quantile thresholds; never tighter than trained; caps hold; thin symbols keep the trained thresholds |
| `bots/test/surveillance.test.ts` (shadow) | **Live end to end** | After 20 s of honest shadow traffic, every manipulator is still caught, with at most 1 of 6 honest traders flagged |
| `services/ai/tests/test_rl.py` | Python | The market-making environment: e^(-k delta) fills, paired randomness, reward accounting, inventory limits, adverse flow, Avellaneda-Stoikov, the denoised training reward |
| `bots/test/rl.test.ts` | **Cross-language parity** + integration | The ONNX policy reproduces Python's golden actions; it learned inventory control and tape reading; it quotes validly on a real gateway |

**Property-based testing (fast-check)** means you do not write the inputs. You write a rule, and the library invents thousands of random inputs trying to break it.

## 5. When a property test fails

fast-check prints something like:

```
Property failed after 126 tests
{ seed: -1150337694, path: "21:3:2:2", endOnFailure: true }
Counterexample: [[{"kind":"limit","side":"buy","price":97,...}, ...]]
Shrunk 61 time(s)
```

- **Counterexample** is the smallest input that still breaks the rule. fast-check *shrinks* the failing case automatically, so you usually get only 2–5 orders to think about.
- **seed and path** let you replay that exact failure. Paste them into the test's options while you debug:

  ```ts
  { numRuns: runs, seed: -1150337694, path: "21:3:2:2" }
  ```

  Remove them again once it is fixed.

## 6. Deep runs (more random cases)

The differential test runs 300 random sequences by default. To hunt for rare bugs, run far more:

```powershell
$env:FC_RUNS = "20000"; pnpm --filter @ome/core test; Remove-Item Env:FC_RUNS
```

The CI workflow does this every night.

## 7. Exercise: prove the tests catch bugs

A test suite that never fails proves nothing. Try this yourself:

1. Open `packages/core/src/order-book.ts` and find this line in `match()`:

   ```ts
   price: level.price,
   ```

2. Change it to the bug "trade at the taker's price instead of the maker's":

   ```ts
   price: limit ?? level.price,
   ```

3. Run `pnpm --filter @ome/core test`. The differential test and several unit tests fail, and fast-check shows a two-order counterexample.
4. **Undo your change** and run the tests again; they are green.

More bugs to try (undo each one afterwards):

- In `runStops()`, change `a.arrival - b.arrival` to `b.arrival - a.arrival`. Stops now fire in the wrong order.
- In `PriceLevel.push()`, delete the line `this.orderCount++;`. Market depth is now wrong.
- In `packages/core/src/order-book.ts` `fromSnapshot()`, change `snapshot.stops` to `snapshot.stops.slice(1)`. The crash test in `@ome/journal` catches this one.
- In `packages/core/src/price-level.ts` `OrderPool.add()`, change `display ?? -1` to `display ?? 0`. The differential test fails at once: ordinary orders now look like icebergs with a slice size of 0.
- In `packages/replication/src/primary.ts` `settle()`, change `this.mode === "sync" ? this.replicaAcked : Infinity` to `Infinity` (acknowledge before the replica has the command). Run `pnpm --filter @ome/replication test`: the failover test fails, because a killed primary had acknowledged commands its replica never got.
- In `packages/volatility/src/features.ts`, change `Math.sqrt(HORIZON / used)` to `Math.sqrt(HORIZON / k)`. Run `pnpm --filter @ome/volatility test`: the parity test fails for the features and HAR, because TypeScript no longer matches Python (EWMA and GARCH still pass; they do not use those features).

**The backtester** (run `pnpm --filter @ome/backtest test` after each):

- In `packages/backtest/src/engine.ts`, change `const ACTION = 2;` to `const ACTION = 0;`, so the strategy's actions run before the tape at equal timestamps. The latency test fails.
- In `run()`, change `marketTime(i) : Infinity` to `marketTime(i) - 5 : Infinity`, so strategies see each trade 5 ms early. The no-look-ahead tests fail (14 tests in all).
- In `onTape()`, delete the second `this.cross(...)` line (the rule that a print proves a quote on its far side crossed). The crossed-quote test and the accounting property test fail.
- In `packages/backtest/src/strategies.ts`, pass `-flow.value` instead of `flow.value` to `distances`. The RL live-parity test fails: the backtest no longer quotes what the live bot quotes.

**Plain-English orders** (run `pnpm --filter @ome/nl-orders test`):

- In `packages/nl-orders/src/ground.ts`, delete the line that pushes ``nothing in the text says ${fields.side}``. The text-check tests fail on a model that reads "becho" (sell) as a buy.
- In `packages/nl-orders/src/validate.ts`, change `stopPrice <= market` to `stopPrice < market`. The bracket and at-the-market stop tests fail.

**Tournaments** (run `pnpm --filter @ome/gateway exec vitest run test/tournaments.test.ts test/tournament-gateway.test.ts`):

- In `services/gateway/src/tournaments.ts`, delete the line `if (this.host.isUnlimited(traderId)) return { error: "unlimited_account" };`. Bots can now join and rank, and the tests that refuse a bot fail.

**The Rust engine** (needs the Rust toolchain from section 1; each change must be built into the wasm before the tests see it):

1. In `packages/engine-rs/rust/src/book.rs` `run_stops()`, change `a.arrival.total_cmp(&b.arrival)` to `b.arrival.total_cmp(&a.arrival)`.
2. Run `pnpm --filter @ome/engine-rs build:wasm`, then `pnpm --filter @ome/engine-rs test`. Every parity test fails; the seeded streams fail at command 333 (seed 1) and 1,987 (seed 42), and fast-check shrinks it to 4 commands.
3. Undo the change and run `build:wasm` again. The rebuilt file is byte-identical to the committed one: `(Get-FileHash packages\engine-rs\wasm\engine.wasm).Hash` starts with `ED87D29D`.

A second one: in `indicative_auction()`, change `distance < best_distance` to `distance <= best_distance` (the auction tie-break picks the higher of two equally near prices). After `build:wasm`, 7 tests fail, including all 4 fast-check properties, with 3-command counterexamples. The seeded streams pass: they never produce that tie, which is why the random properties exist.

## 8. Run the whole system and test it by hand

Open **three** terminals in the project folder.

```powershell
# Terminal 1: exchange + gateway
pnpm gateway

# Terminal 2: bots (market makers, options desk, noise traders, live Binance BTC feed)
pnpm bots -- --binance

# Terminal 3: the trading terminal
pnpm terminal
```

Open http://localhost:3000, type any name, and trade. The gateway starts with a **10-second opening auction**, so for the first moments every symbol shows AUCTION and an indicative price. Things to try:

- Click a price in the order book: the ticket fills in that price.
- Type a bad price (e.g. `4100.03` on TCS) and see the error before anything is sent.
- Place a limit order away from the market, see it in **Open orders** and on the book, then cancel it.
- Buy with a market order, then check **Fills** and **Positions** (P&L updates with every trade).
- Open a second browser window with another name and trade against yourself.
- Try to buy more than your buying power (e.g. 300 TCS): the order is refused.
- Try a price more than 10% from the last trade: "price outside band".
- Trigger the circuit breaker: in two windows, trade BTCUSDT, then trade again more than 5% higher. The symbol halts for 15 seconds with an explanation, then reopens by auction. (Do this in the first 15 minutes. After that the volatility forecast tightens the band, usually to 2–3%, so a 5% jump is refused as "price outside band", and a smaller jump of 1–2% trips the breaker.)
- Watch the line above the chart: "Volatility forecast warming up", then after 15 minutes "Expected 15m move ±0.21% (…)", with the band and halt trigger it sets. `Invoke-RestMethod http://127.0.0.1:8080/api/volatility | ConvertTo-Json -Depth 5` shows the model, how every model scored, and each symbol's forecast. `$env:VOL_MODEL = "har"; pnpm gateway` runs a different model; `$env:VOLATILITY = "0"` turns it off.

The bots print a summary every 10 seconds. To poke the REST API directly, use a fourth terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:8080/api/health
Invoke-RestMethod http://127.0.0.1:8080/api/instruments
Invoke-RestMethod "http://127.0.0.1:8080/api/book/BTCUSDT?levels=5"
Invoke-RestMethod http://127.0.0.1:8080/api/trades/TCS | Select-Object -Last 5
Invoke-RestMethod "http://127.0.0.1:8080/api/candles/TCS?interval=5s" | Select-Object -Last 3
```

Compare our BTC price with the real one:

```powershell
Invoke-RestMethod "https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT"
```

**Futures and options.** Start the gateway with a short expiry cycle so you can watch a series expire, then the bots (the options market makers are on by default):

```powershell
$env:DERIVATIVES_EXPIRY_MS = "120000"; pnpm gateway     # terminal 1: series expire every 2 minutes
pnpm bots                                               # terminal 2
```

- Select TCS or INFY: the futures-and-options bar shows each series with its expiry countdown, and the **option chain** lists calls and puts by strike, with bid, offer, implied volatility and delta; in-the-money strikes are shaded.
- Click a quote in the chain: the ticket fills in that series. The ticket shows the contract's terms (10 TCS or 25 INFY shares per contract, prices per share).
- Buy a call or a future, and leave a limit order resting on the same series. At expiry, the resting order is cancelled as `expired`, the position settles in the **Settlements** tab (with how the price was set: the last minute's VWAP), and a new series is listed around the new price.
- Try to sell more contracts than you hold, one at a time: once your open sells already cover your position, the next ones need margin like any new short.
- The measured live check (no gateway needed, about 4 minutes): `pnpm --filter @ome/bots derivatives -- --minutes=4 --cycle=60`. It ends with the settlement, zero-sum and ledger checks. `$env:DERIVATIVES = "0"` lists no derivatives; `pnpm bots -- --no-derivatives` leaves them unquoted.

**Tournaments and the leaderboard.**

```powershell
$env:TOURNAMENT_MS = "120000"; pnpm gateway     # rolling 2-minute tournaments
```

- In the terminal, click **Leaderboard** in the header. You see the live tournament and the next one.
- Click **Join** with a flat account: your account resets to the starting cash. Go back to trading (your session carries over), trade, and come back: your row is highlighted and ranked by return, then drawdown.
- Place a resting order and try to join another tournament: refused as not flat. Joining an upcoming one freezes your account until the start (`tournament_not_started`). While in one, Join on the next one signs you up instead.
- Create one by hand with the admin key, starting now for 10 minutes with Rs 5 lakh each:

```powershell
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
Invoke-RestMethod -Method Post "http://127.0.0.1:8080/api/tournaments?key=local-dev-admin-key" -ContentType application/json `
  -Body (@{ name = "Diwali Cup"; start = $now; end = $now + 600000; startingCash = @{ INR = 500000 } } | ConvertTo-Json)
Invoke-RestMethod http://127.0.0.1:8080/api/tournaments | ConvertTo-Json -Depth 4
Invoke-RestMethod http://127.0.0.1:8080/api/tournaments/t1/leaderboard | ConvertTo-Json -Depth 4
```

`$env:TOURNAMENT_MS = "15m"` stops the gateway at startup with an error (it must be a whole number of milliseconds of at least 1000).

**Plain-English orders.** With Ollama running and `qwen2.5:1.5b` pulled, `pnpm gateway` prints `Plain-English orders: hybrid (rules + qwen2.5:1.5b)` and then how long the model took to warm up. In the terminal, use the **Type an order** box under the ticket:

- `buy 10 infosys at 1790`: the rules answer at once (the reply says which parser read it). Check the proposal, press **Fill in the ticket**, check the ticket, and only then press its **Buy/Sell**. Try Hinglish and typos too, such as `TCS ke 10 share kharido 4100 pe` or `buy 5 relaince at market`.
- `cancel my infy orders`: a **Cancel N open orders** button lists each order first.
- `sell 3 tcs if it falls to 4000`: the rules cannot read this, so the model does. Press **Stop** while it reads, or **Use rules only**.
- `buy 5 tcs at market fill or kill`: the preview warns that the ticket sends no time in force on a market order.
- Phrasings that must be refused as unclear: `buy some tcs`, `buy 10 tata motors`, `don't sell 10 infy`, `buy 100 tcs at 4100 sl 4000` (a bracket is two orders).
- Quit Ollama from the tray and try again: the rules answer, with "The local model is not running (start Ollama), so only the built-in rules read this."
- `$env:NL_MODE = "rules"; pnpm gateway` never contacts the model; `$env:NL_ORDERS = "0"` turns the feature off; `OLLAMA_URL`, `NL_MODEL` and `NL_TIMEOUT_MS` point it elsewhere.

From PowerShell, through the API (it only proposes; nothing is ever sent):

```powershell
$s = Invoke-RestMethod -Method Post http://127.0.0.1:8080/api/session -ContentType application/json -Body '{"name":"alice"}'
Invoke-RestMethod http://127.0.0.1:8080/api/parse-order
Invoke-RestMethod -Method Post http://127.0.0.1:8080/api/parse-order -Headers @{ authorization = "Bearer $($s.token)" } `
  -ContentType application/json -Body '{"text":"buy 10 infy at 1790"}' | ConvertTo-Json -Depth 5
```

Without a gateway, see what each parser and model makes of a phrasing, or run the full evaluation (30–40 minutes here):

```powershell
pnpm --filter @ome/nl-orders try -- "sell 3 tcs if it falls to 4000"
pnpm --filter @ome/nl-orders eval -- --set=review --models=qwen2.5:1.5b --verbose
pnpm --filter @ome/nl-orders eval
```

**Backtests.** No gateway needed:

```powershell
pnpm --filter @ome/backtest backtest                       # all four strategies on the bundled 30 minutes of real BTC/USDT
start packages\backtest\reports\btcusdt-2026-10-23T1430Z.html   # the report: equity curves, markouts, where the quotes sat
pnpm --filter @ome/backtest backtest -- --strategy=as,rl --taker-fee-bps=1    # watch the RL policy's edge disappear
pnpm --filter @ome/backtest backtest -- --crossing=hold --queue=touch         # the alternative market models
```

For a full real day, download it first (public API, no key, about 10 minutes, 40 MB into the gitignored `data/` folder), then run it continuously and as 48 paired 30-minute windows:

```powershell
pnpm --filter @ome/backtest download -- --start=2026-10-24T00:00:00Z --minutes=1440 --out=data/btcusdt-2026-10-24.aggtrades.csv
pnpm --filter @ome/backtest backtest -- --data=data/btcusdt-2026-10-24.aggtrades.csv --windows=30
```

The windows table ends with each strategy's paired difference from Avellaneda-Stoikov and its 95% interval. A session the bots recorded (`--record=btc.jsonl`) can be backtested with `--data=btc.jsonl`.

**Multi-process gateway.**

```powershell
$env:GATEWAY_PROCESSES = "2"; pnpm gateway      # prints "(2 front-end processes, ...)"
```

Then run the bots and the terminal as usual: everything behaves as in one process. Things to check:

- Two browser windows with different names: each still sees only its own fills.
- In Task Manager, end one of the gateway's `node` front-end processes: the core restarts it. Clients that were connected through it lose their connection (the terminal says "Connection to the gateway was lost."), and signing in again works; the trading state lives in the core, so nothing else changes.
- Ctrl+C in terminal 1 stops the core and its front-ends; no `node` processes are left.

**Watch the AI catch cheaters.** Restart the bots with manipulators, then open the surveillance dashboard:

```powershell
pnpm bots -- --cheaters
```

Go to http://localhost:3000/surveillance and enter the admin key `local-dev-admin-key`. Within about 10 seconds the spoofer, layerer, pump-and-dump trader and wash-trading pair appear, each with the pattern and three reasons.

**Try shadow mode.** Start the gateway with a one-minute shadow period, run honest bots only, then add the cheaters once it has gone live:

```powershell
$env:SURVEILLANCE_SHADOW_MS = "60000"; pnpm gateway     # terminal 1
pnpm bots                                               # terminal 2: honest bots only
# After a minute the dashboard leaves "Shadow mode" and lists each symbol's calibrated thresholds.
# Then stop the bots (Ctrl+C) and restart them with the manipulators:
pnpm bots -- --cheaters
```

**Watch the RL market maker.** `pnpm bots -- --rl=TCS` quotes TCS with the trained policy: the console says so, and its quotes on the book move away from the side it holds. `--as=TCS` runs Avellaneda-Stoikov instead. For the measured comparison, run the head-to-head (about 6 minutes, no gateway needed):

```powershell
pnpm --filter @ome/bots compare -- --episodes=10
```

It ends with each strategy's PnL and the paired PPO-minus-AS difference with its 95% confidence interval.

**Watch a failover.** The failover test prints nothing on success, but you can follow it step by step: `pnpm --filter @ome/replication exec vitest run test/failover.test.ts --reporter=verbose`. To see it fail, plant the bug in section 7.

**Run it in Docker.** Docker Desktop needs Windows' Virtual Machine Platform, which is off on this laptop; turning it on needs an administrator (`wsl --install --no-distribution`, then a reboot). Until then, the CI `docker` job builds and smoke-tests the images on Linux. Once Docker runs:

```powershell
docker compose up --build        # gateway, bots and terminal; open http://localhost:3000
docker compose down              # stop (the exchange's data stays in the exchange-data volume)
```

Useful variations:

```powershell
$env:DATA_DIR = "./data"; pnpm gateway                  # durable: stop and restart, the books survive
pnpm bots -- --binance --record=btc.jsonl                # save the real feed...
pnpm bots -- --replay=btc.jsonl --speed=10               # ...and replay it offline, 10x faster
```

Stop everything with Ctrl+C in each terminal.

## 9. Benchmarks

```powershell
pnpm bench                                    # matching engine: orders/sec and latency
pnpm bench -- --ops=5000000                   # longer run
pnpm --filter @ome/journal bench              # cost of each fsync policy
pnpm --filter @ome/exchange bench             # scaling across worker threads
pnpm --filter @ome/engine-rs bench            # TypeScript vs Rust (through RustOrderBook) vs the Rust engine alone
pnpm --filter @ome/gateway loadtest           # the gateway under a trading load (in-process gateway, separate load processes)
```

Close other heavy apps first, and run each benchmark 2–3 times.

**On a laptop with performance and efficiency cores** (like this Intel Core Ultra), identical runs can differ 2×, depending on which cores Windows picks. For numbers you can compare, pin the run to one performance core:

```powershell
cd packages\core
$p = Start-Process node -ArgumentList "--import","tsx","bench/run.ts","--ops=5000000","--json" -NoNewWindow -PassThru -RedirectStandardOutput bench.json
$p.ProcessorAffinity = 0x3; $p.PriorityClass = "High"; $p.WaitForExit(); Get-Content bench.json; Remove-Item bench.json
cd ..\..
```

That is how the typed-array order storage was measured against the old one-object-per-order layout: the worst pause went from 164–173 ms to 30–32 ms.

**The Rust engine benchmark** uses the same recipe. Without `--engine`, it runs each of the three engines in its own child process, and the children inherit the parent's pinning and priority; the output's Machine line shows the priority they actually ran at:

```powershell
cd packages\engine-rs
$p = Start-Process node -ArgumentList "--import","tsx","bench/run.ts","--ops=1000000" -NoNewWindow -PassThru
$p.ProcessorAffinity = 0x3; $p.PriorityClass = "High"; $p.WaitForExit()
cd ..\..
```

On a near-idle machine it gave about 1.0M ops/sec for TypeScript, 1.14–1.23M for Rust through `RustOrderBook`, and 10.8–11.4M for the Rust engine alone. All three must report the same 449,827 trades and 287,462 resting orders; the benchmark exits non-zero if they differ. Check Task Manager first: when other heavy processes (an Ollama model, say) hold the CPU, the TypeScript engine falls to a third of that and only the ratios mean anything. `--engine=core --json` runs one engine in this process.

**The gateway load test.** By default it starts its own gateway and runs the clients in separate processes. Variations:

```powershell
pnpm --filter @ome/gateway loadtest -- --gateway-processes=2   # through 2 front-end processes
pnpm --filter @ome/gateway loadtest -- --watchers=100 --pin    # plus 100 market-data watchers; --pin puts gateway and load on separate cores
pnpm --filter @ome/gateway loadtest -- --flow=ioc              # the old flow, whose orders never trade (for comparison only)
```

To measure a running gateway, lift its rate limit first, or the run fails on purpose (`rate_limited` rejects mean you measured the limiter):

```powershell
$env:RATE_LIMIT = "off"; pnpm gateway                                 # terminal 1 (add $env:GATEWAY_PROCESSES = "2" to compare)
pnpm --filter @ome/gateway loadtest -- --url=http://127.0.0.1:8080   # terminal 2
```

Two runs per configuration differed by up to about 35% here, so interleave runs and compare within one sitting.

## 10. Profiling (finding where time goes)

```powershell
cd packages\core
node --cpu-prof --import tsx bench/run.ts
```

This writes a `.cpuprofile` file. Open it in Chrome DevTools (Performance tab, then load the profile) or in VS Code to see which functions use the most CPU. That is how the JSON bottleneck in the exchange was found, and how the gateway's time in per-message socket writes was found before corking.

```powershell
node --import tsx --trace-gc bench/run.ts --ops=5000000
```

`--trace-gc` prints every garbage-collection pause. That is how the GC problem in milestone 1 was found, and how the typed-array storage was understood: most of the GC time was young-generation *scavenges* (3.4 s over 5M operations), not full collections, and typed arrays cut them to 1.5 s. It also showed that the Rust wrapper's worst pauses are V8 collections of JavaScript-side objects, not the Rust engine.

## 11. Windows Smart App Control

Smart App Control on this laptop blocks some unsigned native binaries. Two cases have come up:

- **The GNU Rust toolchain was blocked.** Use the MSVC toolchain (`rustup toolchain install stable-x86_64-pc-windows-msvc`) with the WebAssembly target (`rustup target add wasm32-unknown-unknown`). `build:wasm` links with `rust-lld`, so no native linker is needed, and it uses any installed toolchain of the pinned release (rustc 1.99.1) whatever its host name. Native `cargo test` cannot link here (no MSVC linker), so the Rust code is tested only through the wasm build, from TypeScript. If an earlier attempt left a duplicate GNU toolchain installed, remove it with `rustup toolchain uninstall 1.99.1-x86_64-pc-windows-gnu`.
- **A pandas 3.1.0 DLL was blocked**, so the Python tests could not import pandas. pandas 3.0.6 works: `services\ai\.venv\Scripts\pip install "pandas==3.0.6"`.

If another native file is refused when it loads, suspect the same cause first and try another build or version of that package before changing any code.
