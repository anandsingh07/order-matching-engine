import { expect, test, type Browser, type Page } from "@playwright/test";
import { copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  badge,
  caption,
  Director,
  fmtPrice,
  hold,
  Market,
  Narrator,
  OUT,
  portOpen,
  REPO,
  runNarration,
  spotlight,
  typeSlowly,
  writePng,
  type Instrument,
  type Where,
} from "./director";

// The product demo, recorded from a live run: a real gateway, bots and the terminal in a browser,
// narrated by a local text-to-speech voice.
//
//   KOKORO_MODELS=<dir> pnpm --filter @ome/terminal demo     ~21 minutes (the volatility model needs 15
//       one-minute bars); writes docs/demo.mp4 (H.264 + AAC), docs/demo.webm (VP9 + Opus), docs/demo-*.png
//   DEMO_SMOKE=1 KOKORO_MODELS=<dir> pnpm --filter @ome/terminal demo    ~9 minutes, forecast still
//       warming up, everything in test-results/demo only
//
// Narration (narration.md, narration.py, needs the services/ai venv): the clips are synthesized
// first, so the spec knows how long each one is. Every beat cues its clip and holds until the clip
// is over; `narration.py mix` then lays the clips at their cue times and muxes the audio in. The
// docs files are replaced only once the whole run and the mix have succeeded.
//
// Every state is waited for on the real UI; plain timers are only holds for the narration. Market
// numbers in captions are read live from the gateway's REST API at film time.

const SMOKE = process.env.DEMO_SMOKE === "1";
const GATEWAY_PORT = 18_290;
const WEB_PORT = 3_200;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const ADMIN_KEY = "local-dev-admin-key";
const SHADOW_MS = SMOKE ? 20_000 : 180_000;
const MANIPULATORS_AFTER_MS = SHADOW_MS + (SMOKE ? 5_000 : 20_000);
const MANIPULATORS = ["spoofer", "layerer", "pumper", "wash-a", "wash-b"];
const DOCS = join(REPO, "docs");
// Loose enough that the built-in rules pass it to the local model.
const NL_TEXT = "please buy me 15 shares of tata consultancy at the current market price";
/** Silence after a scene's last clip before the cut (on top of the narrator's gap). */
const SCENE_TAIL = 0.45;

test.setTimeout(SMOKE ? 15 * 60_000 : 50 * 60_000);

// ---- terminal locators --------------------------------------------------------------------
const nav = (p: Page) => p.getByRole("navigation", { name: "Instruments" });
const ticket = (p: Page) => p.getByRole("form", { name: "Order entry" });
const box = (p: Page) => p.getByRole("form", { name: "Plain-English order" });
const accountTabs = (p: Page) => p.getByRole("tablist", { name: "Account" });
const banner = (p: Page) => p.getByRole("status").filter({ hasText: /Trading halted|Opening auction/ });

async function tabCount(p: Page, label: "Fills" | "Open orders"): Promise<number> {
  const text = await accountTabs(p).getByRole("tab", { name: new RegExp(`^${label} \\(`) }).innerText();
  return Number(/\((\d+)\)/.exec(text)?.[1] ?? NaN);
}

async function selectSymbol(p: Page, symbol: string): Promise<void> {
  await nav(p).getByRole("button", { name: new RegExp(`^${symbol}\\b`) }).click();
  await expect(ticket(p).getByRole("button", { name: new RegExp(`^(Buy|Sell) ${symbol}$`) })).toBeVisible();
}

async function newCamera(browser: Browser, path: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: WEB,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    timezoneId: "Asia/Kolkata",
    locale: "en-GB",
  });
  // Hide the Next.js dev-tools badge.
  await context.addInitScript(() => {
    const add = () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal{display:none!important}";
      document.head.appendChild(style);
    };
    if (document.head) add();
    else document.addEventListener("DOMContentLoaded", add);
  });
  const page = await context.newPage();
  if (path !== "") await page.goto(path);
  return page;
}

async function login(p: Page, name: string): Promise<void> {
  await expect(p.getByLabel("Trader name")).toBeVisible({ timeout: 120_000 });
  await p.getByLabel("Trader name").fill(name);
  await p.getByRole("button", { name: "Start trading" }).click();
  await expect(nav(p)).toBeVisible({ timeout: 30_000 });
}

/** Joins the live tournament through the leaderboard page and comes back (client-side, so the session stays). */
async function joinTournament(p: Page): Promise<void> {
  await p.getByRole("link", { name: "Leaderboard" }).click();
  await p.getByRole("button", { name: "Join tournament" }).click({ timeout: 60_000 });
  await expect(p.getByText("You're in.")).toBeVisible();
  await p.getByRole("link", { name: "Back to the terminal" }).click();
  await expect(nav(p)).toBeVisible();
}

// ---- cards (title and outro), in the terminal's Neo-Brutalism theme (src/app/globals.css) --
const cardPage = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#fff4d6;color:#111;font-family:ui-sans-serif,system-ui,'Segoe UI',Roboto,Arial,sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 96px;box-sizing:border-box}
  .panel{background:#fffdf7;border:4px solid #111;box-shadow:10px 10px 0 0 #111;padding:44px 56px 40px}
  h1{font-family:'Archivo Black','Arial Black','Segoe UI Black',sans-serif;font-weight:400;font-size:66px;line-height:1.05;margin:0 0 22px;letter-spacing:.5px}
  h1 mark{background:#ffe600;color:#111;padding:0 10px;border:4px solid #111;box-shadow:5px 5px 0 0 #111}
  h1 span{color:#ff5c8a}
  p.sub{font-size:28px;font-weight:600;margin:0 0 30px;max-width:1080px;line-height:1.38}
  .chips{display:flex;flex-wrap:wrap;gap:14px;margin:0 0 34px}
  .chip{border:3px solid #111;box-shadow:4px 4px 0 0 #111;padding:6px 14px;font-weight:800;font-size:20px}
  p.foot{font-size:19px;color:#4a4a4a;margin:0;font-weight:600}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:22px 28px;margin:0 0 30px}
  .fact{background:#fff;border:3px solid #111;box-shadow:5px 5px 0 0 #111;padding:12px 18px 12px 0;display:flex;align-items:stretch;font-size:25px;line-height:1.3}
  .fact i{flex:0 0 14px;margin-right:16px;border-right:3px solid #111}
  .fact b{font-weight:800} .fact small{display:block;color:#4a4a4a;font-size:17px;font-weight:600;margin-top:2px}
  .y{background:#ffe600}.p{background:#ff5c8a}.c{background:#4dd8ff}.l{background:#b8f23a}.g{background:#2bd97c}.r{background:#ff5a5f}
</style></head><body><div class="wrap">${body}</div></body></html>`;

const titleCard = () =>
  cardPage(`<div class="panel">
  <h1><mark>Order Matching</mark> Engine<span>.</span></h1>
  <p class="sub">A stock exchange built from scratch in TypeScript: matching engine, trading terminal, bots,
  futures &amp; options, and AI for volatility, surveillance and plain-English orders.</p>
  <div class="chips"><span class="chip y">Matching engine</span><span class="chip c">Futures &amp; options</span>
  <span class="chip p">AI surveillance</span><span class="chip l">Local LLM orders</span><span class="chip g">Circuit breakers</span></div>
  <p class="foot">Recorded automatically with Playwright from a live run. Time cuts are marked.</p></div>`);

const outroCard = () =>
  cardPage(`<h1>Under the <mark>hood</mark><span>.</span></h1>
  <div class="grid">
    <div class="fact"><i class="y"></i><div><b>~985K orders/sec</b> on one thread<small>matching engine, p99 2.6 µs</small></div></div>
    <div class="fact"><i class="c"></i><div><b>~60K orders/sec</b> end to end<small>WebSocket gateway, trading mix, 2 front-end processes</small></div></div>
    <div class="fact"><i class="l"></i><div><b>~333K commands/sec</b> durable<small>write-ahead journal with group commit</small></div></div>
    <div class="fact"><i class="p"></i><div><b>Automatic failover</b><small>primary/replica replication, SIGKILL-tested</small></div></div>
    <div class="fact"><i class="r"></i><div><b>Rust/WebAssembly engine</b><small>byte-identical events to the TypeScript engine</small></div></div>
    <div class="fact"><i class="g"></i><div><b>97.3%</b> of manipulation caught offline<small>2.2% of honest windows flagged</small></div></div>
  </div>
  <p class="foot">TypeScript · Node 24 · Next.js 16 · Rust/WASM · ONNX models trained in Python · Ollama for local LLM parsing · weak results reported in the README</p>`);

// ---- the demo -----------------------------------------------------------------------------
test("record the product demo", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  // The narration clips first (cached): the spec needs each clip's length.
  runNarration(["synth"]);
  const market = new Market(GATEWAY_PORT);
  const d = new Director();
  const n = new Narrator(d);
  const stills: { name: string; frame: Buffer }[] = [];
  const captionLog: string[] = [];
  /** Keeps the frame on air now as a still. */
  const still = (name: string) => {
    const frame = d.frameAt(d.seconds());
    if (frame !== undefined) stills.push({ name, frame });
  };
  /** Shows a caption on every camera. */
  const show = async (text: string, where: Where = "low") => {
    captionLog.push(`${d.seconds().toFixed(1)} s: ${text}`);
    await caption(d.cameras, text, where);
  };
  /** A scene that ends only once its narration has finished. */
  const scene = (name: string, body: () => Promise<void>) =>
    d.scene(name, async () => {
      await body();
      await n.wait(SCENE_TAIL);
    });

  let failed: unknown = null;
  try {
    // ---- off camera: cameras, exchange, traders --------------------------------------------
    const [alice, bob, desk, card] = await Promise.all([newCamera(browser, "/"), newCamera(browser, "/"), newCamera(browser, "/surveillance"), newCamera(browser, "")]);
    await expect(desk.getByRole("heading", { name: "Market surveillance" })).toBeVisible({ timeout: 120_000 });
    await card.setContent(titleCard());

    const t0 = Date.now();
    await market.startGateway({
      CORS_ORIGINS: WEB,
      OPENING_AUCTION_MS: "0",
      HALT_MS: "30000",
      SURVEILLANCE_SHADOW_MS: String(SHADOW_MS),
      DERIVATIVES_EXPIRY_MS: "3600000",
      // The local model reads a sentence in a few seconds once loaded, more on a busy CPU.
      NL_TIMEOUT_MS: "19000",
    });
    console.log(`gateway up in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const tournament = await market.post<{ id: string }>(`/api/tournaments?key=${ADMIN_KEY}`, {
      name: "Demo Cup",
      start: Date.now(),
      end: Date.now() + 2 * 3_600_000,
    });
    market.startBots(["--seed=7"]);
    market.startActors([`--tournament=${tournament.id}`, "--manipulators=HDFCBANK", `--manipulators-at=${t0 + MANIPULATORS_AFTER_MS}`]);

    await login(alice, "alice");
    await joinTournament(alice);
    await login(bob, "bob");
    await joinTournament(bob);
    await selectSymbol(alice, "TCS");
    await selectSymbol(bob, "TCS");
    for (const p of [alice, bob, desk, card]) await d.addCamera(p);

    // Warm the plain-English reader off camera: the first model call loads it and fills its prompt cache.
    const status = await fetch(`${market.url}/api/parse-order`).then((r) => r.json() as Promise<{ mode: string; model: string | null; state: string }>);
    console.log(`plain-English orders: ${JSON.stringify(status)}`);
    const warmUp = async () => {
      const { token } = await market.post<{ token: string }>("/api/session", { name: "warm-up" });
      for (const text of [NL_TEXT]) {
        const started = Date.now();
        const r = await fetch(`${market.url}/api/parse-order`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ text }),
        }).then((x) => x.json() as Promise<{ kind: string; source: string; summary: string }>);
        console.log(`warm-up parse (${Date.now() - started} ms): ${r.source} ${r.kind}: ${r.summary}`);
      }
    };
    await warmUp();

    // ---- gates: film only a healthy market ---------------------------------------------------
    const instruments = await market.get<Instrument[]>("/api/instruments");
    const inst = (s: string) => instruments.find((i) => i.symbol === s)!;
    if (!SMOKE) {
      console.log("waiting for the volatility forecast (15 one-minute bars)...");
      await market.waitFor(async () => (await market.status("TCS")).volatility, 22 * 60_000, "the TCS volatility forecast");
      console.log(`forecast after ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
    }
    type Report = { mode: string; current: { traderId: string; traderName: string; symbol: string; assessment: { flagged: boolean; label: string } }[] };
    const surveillance = () => market.get<Report>(`/api/surveillance?key=${ADMIN_KEY}`);
    await market.waitFor(
      async () => {
        const r = await surveillance();
        const n = new Set(r.current.filter((a) => a.assessment.flagged && MANIPULATORS.includes(a.traderName)).map((a) => a.traderName)).size;
        return r.mode === "live" && n >= 4;
      },
      SMOKE ? 120_000 : 10 * 60_000,
      "4 of 5 manipulators flagged",
    );
    await market.waitFor(
      async () => {
        for (const s of ["TCS", "BTCUSDT"]) {
          const b = await market.book(s, 1);
          const t = await market.trades(s);
          if (b.bids.length === 0 || b.asks.length === 0 || t.length === 0 || Date.now() - t.at(-1)!.time > 15_000) return false;
        }
        return true;
      },
      60_000,
      "two-sided, trading TCS and BTCUSDT books",
    );

    /**
     * A TCS call for Alice to write. Out of the money first: a low delta keeps its quotes still while
     * Bob clicks, so her offer, halfway into a spread of 4 ticks or more, stays the best one.
     */
    const pickCall = async () => {
      const spot = (await market.status("TCS")).referencePrice;
      const calls = instruments
        .filter((i) => i.underlying === "TCS" && i.right === "call" && (i.expiry ?? 0) > Date.now() + 5 * 60_000)
        .sort((a, b) => b.strike! - a.strike!);
      for (const minTicks of [4, 2]) {
        for (const c of calls) {
          if (c.strike! < spot) continue;
          const b = await market.book(c.symbol, 1);
          const bid = b.bids[0]?.price;
          const ask = b.asks[0]?.price;
          if (bid === undefined || ask === undefined || bid < 2 * c.priceScale || ask - bid < minTicks * c.tickSize) continue;
          const mid = bid + c.tickSize * Math.floor((ask - bid) / c.tickSize / 2);
          return { c, bid, ask, mid, strike: String(c.strike! / c.priceScale) };
        }
      }
      return null;
    };
    await market.waitFor(pickCall, 90_000, "an out-of-the-money TCS call, bid 2.00 or more, spread 2 ticks or more");
    console.log(`gates passed ${((Date.now() - t0) / 60_000).toFixed(1)} min after the gateway started`);
    await warmUp();

    // Off camera, Alice is on TCS with 5-second candles (the default); the scene switches to 1m.
    // ============================================================================================
    await scene("title", async () => {
      d.cut(card);
      d.roll();
      await n.say("title.1");
      await hold(600);
      still("title");
    });

    await scene("market", async () => {
      d.cut(alice);
      await show("A live market: bots trade five symbols through the real WebSocket gateway.");
      await n.say("market.1");
      await alice.getByRole("group", { name: "Candle interval" }).getByRole("button", { name: "1m" }).click();
      await expect(alice.getByRole("group", { name: "Candle interval" }).getByRole("button", { name: "1m" })).toHaveAttribute("aria-pressed", "true");
      await hold(1_500);
      still("market");
      await n.say("market.2");
      await show("Order book and the anonymous trade tape.");
      await spotlight(alice, alice.getByRole("region", { name: "Order book" }), 2_200);
      await spotlight(alice, alice.getByRole("region", { name: "Trades" }), n.leftMs());
    });

    await scene("volatility", async () => {
      const st = await market.status("TCS");
      const vol = await market.get<{ model: { running: string; results: Record<string, unknown>; data: { minutes: number; symbol: string } } }>("/api/volatility");
      const days = Math.round(vol.model.data.minutes / 1_440);
      const readout = alice.getByLabel("Volatility forecast");
      if (st.volatility === null) {
        await show(`AI volatility forecast: it needs 15 one-minute bars first, so it is still warming up (smoke run).`);
        await n.say("volatility.1");
        await spotlight(alice, readout, n.leftMs());
        await n.say("volatility.2");
        await spotlight(alice, readout, n.leftMs());
        return;
      }
      await expect(readout).toContainText("Expected 15m move");
      const sigma = Number(st.volatility.sigmaPct.toFixed(2));
      await show(`AI volatility forecast: TCS ±${sigma}% in the next 15 minutes. Model: ${vol.model.running.toUpperCase()}, chosen from 5 by walk-forward tests on ${days} days of real ${vol.model.data.symbol}.`);
      await n.say("volatility.1");
      await spotlight(alice, readout, n.leftMs());
      still("volatility");
      const brk = st.breakerPct ?? 5;
      await show(
        brk < 5 || st.bandPct < 10
          ? `Limits set by the forecast: band ±${Number(st.bandPct.toFixed(1))}%, halt on a ${Number(brk.toFixed(2))}% move in a minute (static: 10% and 5%).`
          : `Limits only ever tighten: in this volatile market they stay at the static ±10% band and 5% breaker.`,
      );
      await n.say("volatility.2");
      await spotlight(alice, readout, n.leftMs());
    });

    await scene("options", async () => {
      const chain = alice.getByRole("region", { name: /^Option chain · TCS/ });
      await show("Futures and options on TCS, quoted at Black-Scholes values from the forecast. IV and Δ come from the live book.", "high");
      await n.say("options.1");
      await spotlight(alice, chain, n.leftMs());
      still("option-chain");

      const pick = await market.waitFor(pickCall, 20_000, "a TCS call to trade");
      const { c, bid, ask, mid, strike } = pick;
      const name = `TCS ${strike} call`;
      const fillsBefore = await tabCount(alice, "Fills");
      const openBefore = await tabCount(alice, "Open orders");
      await n.say("options.2");
      await alice.getByRole("button", { name: `Sell ${name} at ${fmtPrice(c, bid)}`, exact: true }).click();
      await expect(ticket(alice).getByRole("button", { name: `Sell ${c.symbol}` })).toBeVisible();
      await show(`Alice writes one ${name} at ${fmtPrice(c, mid)}, inside the market maker's ${fmtPrice(c, bid)} / ${fmtPrice(c, ask)}.`, "high");
      await typeSlowly(alice.getByLabel("Price", { exact: true }), fmtPrice(c, mid));
      await typeSlowly(alice.getByLabel("Quantity"), "1");
      await n.wait(-n.gap - 0.6); // she sends it as the sentence ends
      await ticket(alice).getByRole("button", { name: `Sell ${c.symbol}` }).click();
      await expect
        .poll(async () => (await tabCount(alice, "Open orders")) > openBefore || (await tabCount(alice, "Fills")) > fillsBefore, { timeout: 5_000 })
        .toBe(true);
      await hold(300);

      // Bob, in another browser, on the same chain.
      d.cut(bob);
      const offer = bob.getByRole("button", { name: `Buy ${name} at ${fmtPrice(c, mid)}`, exact: true });
      const hers = await offer.waitFor({ timeout: 4_000 }).then(
        () => true,
        () => false,
      );
      await n.say(hers ? "options.3" : "options.3-mm");
      await show("Bob, in another browser, buys the call.", "high");
      const bobFills = await tabCount(bob, "Fills");
      if (hers) await offer.click();
      else await bob.getByRole("button", { name: new RegExp(`^Buy ${name} at `) }).click();
      await expect(ticket(bob).getByRole("button", { name: `Buy ${c.symbol}` })).toBeVisible();
      await typeSlowly(bob.getByLabel("Quantity"), "1");
      await ticket(bob).getByRole("button", { name: `Buy ${c.symbol}` }).click();
      await expect(accountTabs(bob).getByRole("tab", { name: `Fills (${bobFills + 1})` })).toBeVisible({ timeout: 5_000 });
      const matched =
        hers &&
        (await expect(accountTabs(alice).getByRole("tab", { name: `Fills (${fillsBefore + 1})` }))
          .toBeVisible({ timeout: 3_000 })
          .then(
            () => true,
            () => false,
          ));
      if (hers && !matched) console.warn("Bob clicked Alice's offer but she has no new fill; the narration says they traded");
      await accountTabs(bob).getByRole("tab", { name: "Positions" }).click();
      const position = bob.getByRole("row").filter({ hasText: `${name} · ×` });
      await expect(position).toBeVisible();
      await show(
        matched ? `Bob, in another browser, lifts her offer. Each gets a private fill; the tape shows an anonymous trade.` : `Bob, in another browser, buys the call. Each trader sees only their own fills.`,
        "high",
      );
      await spotlight(bob, position, n.leftMs(2_500));
      still("two-traders");

      d.cut(alice);
      await show("Writing a call posts margin. At expiry, cash settlement on TCS's last-minute average price.", "high");
      await n.say("options.4");
      await spotlight(alice, alice.getByLabel("Account balance"), n.leftMs());
    });

    await scene("circuit-breaker", async () => {
      const btc = inst("BTCUSDT");
      await selectSymbol(bob, "BTCUSDT"); // off air
      await n.say("circuit-breaker.1");
      await selectSymbol(alice, "BTCUSDT");
      let st = await market.status("BTCUSDT");
      const band = Number(st.bandPct.toFixed(2));
      const brk = Number((st.breakerPct ?? 5).toFixed(2));
      const tick = (x: number) => Math.round(x / btc.tickSize) * btc.tickSize;
      const reject = tick(st.referencePrice * (1 + (band + 1.5) / 100));
      await show(`BTCUSDT limits now: band ±${band}%, halt on a ${brk}% move within a minute. First, a buy ${Number((band + 1.5).toFixed(2))}% above the last trade.`);
      await typeSlowly(alice.getByLabel("Price", { exact: true }), fmtPrice(btc, reject));
      await typeSlowly(alice.getByLabel("Quantity"), "0.01");
      await ticket(alice).getByRole("button", { name: "Buy BTCUSDT" }).click();
      const toast = alice.getByRole("button", { name: /Order rejected: price outside band/ });
      await expect(toast).toBeVisible();
      await show("Outside the band: refused before it reaches the book.");
      await spotlight(alice, toast, n.leftMs(2_000));

      st = await market.status("BTCUSDT");
      const jump = Math.min(band - 0.4, brk + Math.max(0.5, (band - brk) / 4));
      const price = tick(st.referencePrice * (1 + jump / 100));
      const asks = (await market.book("BTCUSDT", 100)).asks.filter((a) => a.price <= price).reduce((n, a) => n + a.quantity, 0);
      const maxQty = Math.floor(((45_000 * btc.priceScale) / price) * btc.quantityScale);
      // More than the whole book, with room for offers that arrive while she types: the rest of her bid stays at the high price.
      const qty = Math.min(maxQty, Math.round(asks * 1.5) + 0.1 * btc.quantityScale);
      const qtyText = (qty / btc.quantityScale).toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
      await n.say("circuit-breaker.2");
      await show(`Now a buy at ${fmtPrice(btc, price)} (+${Number(jump.toFixed(2))}%) for ${qtyText} BTC: more than every offer in the book.`);
      await typeSlowly(alice.getByLabel("Price", { exact: true }), fmtPrice(btc, price));
      await typeSlowly(alice.getByLabel("Quantity"), qtyText);
      await ticket(alice).getByRole("button", { name: "Buy BTCUSDT" }).click();
      const halted = () =>
        expect(banner(alice))
          .toContainText("Trading halted", { timeout: 6_000 })
          .then(
            () => true,
            () => false,
          );
      if (!(await halted())) {
        const recent = (await market.trades("BTCUSDT")).filter((t) => t.time > Date.now() - 15_000).map((t) => fmtPrice(btc, t.price));
        console.warn(`no halt after the sweep; last BTCUSDT trades: ${recent.join(", ")}; status ${JSON.stringify(await market.status("BTCUSDT"))}`);
        // Once more, from the new last price.
        st = await market.status("BTCUSDT");
        const again = tick(st.referencePrice * (1 + jump / 100));
        await typeSlowly(alice.getByLabel("Price", { exact: true }), fmtPrice(btc, again), 40);
        await ticket(alice).getByRole("button", { name: "Buy BTCUSDT" }).click();
        await expect(banner(alice)).toContainText("Trading halted", { timeout: 8_000 });
      }
      await expect(nav(alice).getByRole("button", { name: /^BTCUSDT/ })).toContainText("HALTED");
      await show(`The next trade prints ${Number(jump.toFixed(2))}% higher: the circuit breaker halts BTCUSDT into a call auction. Other symbols keep trading.`);
      await n.say("circuit-breaker.3");
      await spotlight(alice, banner(alice), n.leftMs());
      still("halt");

      d.cut(bob);
      await n.say("circuit-breaker.4");
      await ticket(bob).getByRole("tab", { name: "Market" }).click();
      await ticket(bob).getByRole("group", { name: "Side" }).getByRole("button", { name: "sell" }).click();
      await typeSlowly(bob.getByLabel("Quantity"), "0.01");
      await ticket(bob).getByRole("button", { name: "Sell BTCUSDT" }).click();
      const alert = ticket(bob).getByRole("alert");
      await expect(alert).toHaveText("During an auction only GTC limit and stop orders are accepted");
      await show("Bob's market order is stopped in the ticket: an auction takes only limit and stop orders.");
      await spotlight(bob, alert, n.leftMs(2_000));
      // Off air, Alice cancels whatever is left of her bid.
      await accountTabs(alice).getByRole("tab", { name: /^Open orders/ }).click();
      const leftover = alice.getByRole("row").filter({ hasText: "BTCUSDT" }).getByRole("button", { name: "Cancel", exact: true });
      for (let i = 0; i < 3 && (await leftover.count()) > 0; i++) await leftover.first().click({ timeout: 2_000 }).catch(() => {});
      if (await banner(bob).isVisible()) {
        await show("The banner shows the indicative reopening price.");
        await spotlight(bob, banner(bob), 2_200);
      }
      await n.wait();

      if (await banner(bob).isVisible()) {
        const pausedAt = Date.now();
        d.pause();
        await expect(banner(bob)).toContainText(/ in [0-3]s/, { timeout: 25_000 });
        d.roll();
        await badge(bob, `+${Math.round((Date.now() - pausedAt) / 1000)} s`, 900);
      }
      await show("When the halt ends, BTCUSDT reopens through the auction: everything that can trade does, at one price.");
      await n.say("circuit-breaker.5");
      await expect(banner(bob)).toBeHidden({ timeout: 10_000 });
      await expect(nav(bob).getByRole("button", { name: /^BTCUSDT/ })).not.toContainText("HALTED");
      await n.wait();
      await hold(400);
      await selectSymbol(alice, "TCS"); // off air, for the next scene
    });

    await scene("plain-english", async () => {
      d.cut(alice);
      const input = box(alice).getByLabel("Type an order");
      await show("Orders can also be typed in plain English.", "high");
      await n.say("plain-english.1");
      const fillsBefore = await tabCount(alice, "Fills");
      const fill = box(alice).getByRole("button", { name: "Fill in the TCS ticket" });
      const sourceLine = box(alice).getByText(/^Read by (the built-in rules ·|\S+ on this computer)/);
      /** Types a sentence and waits for the reading; a slow model read is cut out of the video and marked. */
      const read = async (text: string) => {
        await typeSlowly(input, text, 50);
        await n.wait(); // nothing may be cut out while a clip plays
        await input.press("Enter");
        const started = Date.now();
        // A reply (with the line saying who read it), or the box's own error after its 20-second limit.
        const replied = sourceLine.or(box(alice).getByRole("alert"));
        const quick = await replied.first().waitFor({ timeout: 4_000 }).then(
          () => true,
          () => false,
        );
        if (!quick) {
          d.pause();
          await replied.first().waitFor({ timeout: 30_000 });
          d.roll();
          await badge(alice, `+${Math.round((Date.now() - started - 4_000) / 1000)} s`, 900);
        }
      };
      await read(NL_TEXT);
      // On a very busy machine the model can time out; the rules then answer only simpler wording.
      let modelTimedOut = false;
      if (!(await fill.isVisible())) {
        modelTimedOut = true;
        console.warn(`the local model did not answer in time: ${await box(alice).innerText()}`);
        await read("buy 15 tcs at market");
      }
      const source = await sourceLine.innerText();
      const llm = /Read by (\S+) on this computer.*· ([\d.]+ m?s)/.exec(source);
      const rules = /Read by the built-in rules · ([\d.]+ m?s)/.exec(source);
      await show(
        llm !== null
          ? `A local model (${llm[1]} in Ollama) read it in ${llm[2]}; code checks the result against her words. Nothing is sent yet.`
          : `The built-in rules read it in ${rules?.[1] ?? "a moment"} (${modelTimedOut ? "the local model timed out on this busy machine" : "the local model was not needed"}). Nothing is sent yet.`,
        "high",
      );
      await n.say(llm !== null ? "plain-english.2" : "plain-english.2-rules");
      await spotlight(alice, box(alice), n.leftMs());
      still("plain-english");
      await expect(fill).toBeEnabled();
      await n.say("plain-english.3");
      await fill.click();
      await expect(ticket(alice).getByRole("button", { name: "Buy TCS" })).toBeVisible();
      await show("Confirming fills in the ticket. She checks it and presses Buy herself.", "high");
      await spotlight(alice, ticket(alice), Math.max(1_500, n.leftMs() - 800));
      await ticket(alice).getByRole("button", { name: "Buy TCS" }).click();
      // A market order can fill against several resting orders: one fill each.
      await expect.poll(() => tabCount(alice, "Fills"), { timeout: 5_000 }).toBeGreaterThan(fillsBefore);
      await accountTabs(alice).getByRole("tab", { name: /^Fills/ }).click();
      await hold(800);
    });

    await scene("surveillance", async () => {
      d.cut(desk);
      await show("The compliance desk: market-abuse surveillance, live in the gateway.", "top-right");
      await n.say("surveillance.1");
      await typeSlowly(desk.getByLabel("Admin key"), ADMIN_KEY, 45);
      await desk.getByRole("button", { name: "Open" }).click();
      const flaggedRegion = desk.getByRole("region", { name: "Flagged traders" });
      await expect(flaggedRegion.locator("article").first()).toBeVisible();
      const r = await surveillance();
      const flaggedNames = new Set(r.current.filter((a) => a.assessment.flagged).map((a) => a.traderName));
      const caught = MANIPULATORS.filter((m) => flaggedNames.has(m)).length;
      const honest = new Set(r.current.filter((a) => !MANIPULATORS.includes(a.traderName)).map((a) => a.traderName));
      const honestFlagged = [...honest].filter((n) => flaggedNames.has(n));
      console.log(`surveillance: ${caught}/5 manipulators, ${honestFlagged.length}/${honest.size} honest flagged (${honestFlagged.join(", ")})`);
      await show(
        `Shadow mode for the first ${SHADOW_MS / 60_000 >= 1 ? `${SHADOW_MS / 60_000} minutes` : `${SHADOW_MS / 1000} s`}: every trader scored, no one alerted, then thresholds per market.`,
        "top-right",
      );
      await n.say("surveillance.2");
      const calibration = desk.getByRole("region", { name: "Calibration" });
      await spotlight(desk, (await calibration.count()) > 0 ? calibration : desk.getByRole("region", { name: "Model" }), n.leftMs());
      await show(`Five manipulator bots joined HDFCBANK: ${caught} of 5 flagged, each with its pattern and the reasons in words.`, "top-right");
      await n.say("surveillance.3");
      await spotlight(desk, flaggedRegion, n.leftMs());
      still("surveillance");
      await show("Two ONNX models score every trader: LightGBM for known patterns, a Gaussian mixture for anything unlike honest trading.", "top-right");
      await n.say("surveillance.4");
      await spotlight(desk, desk.getByRole("region", { name: "Model" }), n.leftMs());
      await desk.mouse.move(720, 600);
      await desk.mouse.wheel(0, 700);
      await show(`Honestly reported: ${honestFlagged.length} of ${honest.size} honest bots are flagged right now too. Thin simulated markets make some look unusual.`, "top-right");
      await n.say("surveillance.5");
    });

    await scene("leaderboard", async () => {
      d.cut(alice);
      await n.say("leaderboard.1");
      await alice.getByRole("link", { name: "Leaderboard" }).click();
      const standings = alice.getByRole("region", { name: "Standings" });
      await expect.poll(() => standings.getByRole("row").count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(3); // header + entrants
      await show("Tournaments: same paper cash for everyone, ranked by live return, then drawdown. Bots never rank.", "top-right");
      await spotlight(alice, standings, Math.max(2_500, n.leftMs() - 2_500));
      still("leaderboard");
      await spotlight(alice, standings.locator('tr[aria-current="true"]'), 2_500);
    });

    await scene("outro", async () => {
      await card.setContent(outroCard());
      await caption([card], "");
      d.cut(card);
      await n.say("outro.1");
      await hold(1_500);
      still("outro");
      await n.say("outro.2");
      await n.wait(1.0);
    });
  } catch (error) {
    failed = error;
  } finally {
    await d.stopCameras();
    market.stop();
  }

  // ---- output ---------------------------------------------------------------------------------
  // The silent recording, stills and logs go to test-results/demo; the docs files are replaced only
  // after a complete full run and a successful mix.
  const encoded = join(OUT, "demo.webm");
  if (d.seconds() > 0) {
    await d.encode(encoded);
    for (const s of stills) await writePng(s.frame, join(OUT, `demo-${s.name}.png`));
    writeFileSync(join(OUT, "chapters.txt"), d.scenes.map((s) => `${s.start.toFixed(1)}\t${s.end.toFixed(1)}\t${s.name}`).join("\n") + "\n");
    writeFileSync(join(OUT, "captions.txt"), captionLog.join("\n") + "\n");
    writeFileSync(join(OUT, "narration-cues.json"), JSON.stringify({ fps: d.fps, seconds: d.seconds(), scenes: d.scenes, cues: n.cues }, null, 1));
    console.log(`silent video ${encoded}: ${d.seconds().toFixed(1)} s, ${(statSync(encoded).size / 1e6).toFixed(1)} MB`);
  }
  expect(await portOpen(GATEWAY_PORT), "the gateway port is free again").toBe(false);
  if (failed !== null) throw failed;
  if (SMOKE) {
    runNarration(["mix", "--mp4", join(OUT, "demo-smoke.mp4"), "--webm", join(OUT, "demo-smoke.webm")]);
  } else {
    expect(d.seconds()).toBeGreaterThan(150);
    expect(d.seconds()).toBeLessThan(260);
    runNarration(["mix"]);
    for (const s of stills) copyFileSync(join(OUT, `demo-${s.name}.png`), join(DOCS, `demo-${s.name}.png`));
  }
});
