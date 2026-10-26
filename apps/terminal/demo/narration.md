# Demo narration

The spoken track of the product demo (`docs/demo.mp4`, `docs/demo.webm`). One paragraph per scene,
split into cues: each line starting with a `` `key` `` is one clip, synthesized on its own by
`narration.py` and laid into the video at the moment `demo.spec.ts` cues it (the first cue of a
scene at the scene's start). The spec holds each beat on screen until its clip has finished, so no
sentence is cut. Only the text after the key is spoken; everything else in this file is ignored.

Facts come from README.md and docs/INTERVIEW_GUIDE.md. Live numbers (the forecast, the limits, how
many manipulators are flagged) are only in the on-screen captions, because the narration is
synthesized before the market exists. Two cues have a variant that the spec picks at film time:
`plain-english.2-rules` replaces `plain-english.2` when the local model does not answer in time and
the built-in rules read the order instead, and `options.3-mm` replaces `options.3` when Bob's order
fills against a market maker instead of Alice's offer.

How to re-run: see the header of `narration.py`.

## title

`title.1` Hi! I built this stock exchange from scratch in TypeScript: a matching engine, a live trading terminal, futures and options, and a few AI pieces. What you're seeing is a real run, recorded automatically.

## market

`market.1` Here's the terminal. Bots trade five symbols through the real WebSocket gateway, so everything on screen is live.

`market.2` There's the order book, and an anonymous trade tape, just like a real exchange.

## volatility

`volatility.1` Up here is a volatility forecast: how far TCS will probably move in the next fifteen minutes. I tested five models on ninety days of real Bitcoin data, and kept the simplest one that held up.

`volatility.2` That forecast sets the price band and the circuit breaker. It can only tighten them, so a bad forecast can't switch protection off.

## options

`options.1` TCS has futures and options too. The market makers quote Black-Scholes prices from that same forecast.

`options.2` Alice writes a call. She offers one contract inside the market maker's spread.

`options.3` In another browser, Bob buys it. They each get a private fill, and the tape only shows an anonymous trade.

`options.3-mm` In another browser, Bob buys the call. Each trader only sees their own fills, and the tape stays anonymous.

`options.4` Writing a call means posting margin. At expiry, everything is cash-settled on TCS's average price over its last minute.

## circuit-breaker

`circuit-breaker.1` Now let's try to break it. On Bitcoin, Alice sends a buy way outside the price band, and it's rejected before it reaches the book.

`circuit-breaker.2` Next, a buy that's bigger than every offer in the book.

`circuit-breaker.3` The price jumps too far, too fast, so the circuit breaker halts Bitcoin into an auction. Everything else keeps trading.

`circuit-breaker.4` Bob's market order is blocked. During an auction, only limit and stop orders go in.

`circuit-breaker.5` When the halt ends, the auction reopens Bitcoin at one single price.

## plain-english

`plain-english.1` You can also just type an order in plain English.

`plain-english.2` A small language model, running locally in Ollama, reads it, and then code checks the answer against her words. Nothing's been sent yet.

`plain-english.2-rules` This time the built-in rules read it, no model needed. Nothing's been sent yet.

`plain-english.3` She fills in the ticket, checks it, and presses Buy herself.

## surveillance

`surveillance.1` This is the compliance desk: live market abuse surveillance.

`surveillance.2` For its first three minutes, it ran in shadow mode, scoring everyone but alerting no one. Then it set thresholds for each market.

`surveillance.3` Then five manipulator bots joined HDFC Bank. Each flagged trader comes with the pattern it looks like, and the reasons, in plain words.

`surveillance.4` Two ONNX models do the scoring: LightGBM for the known patterns, and a Gaussian mixture for anything unlike honest trading.

`surveillance.5` To be fair, in a market this thin, honest bots can get flagged too, and the page shows that.

## leaderboard

`leaderboard.1` And tournaments. Everyone starts with the same paper cash, and the leaderboard ranks live return, then drawdown. Bots don't rank.

## outro

`outro.1` Under the hood: about a million operations a second on one thread, a crash-safe journal, failover that's tested by killing the primary, and a Rust and WebAssembly port of the engine.

`outro.2` It's a simulator, with paper money. And where a result was weak, the README says so. Thanks for watching!
