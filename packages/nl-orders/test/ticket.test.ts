import type { ClientOrder, Instrument } from "@ome/client";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWithRules, toProposal, toTicket, type MarketInstrument, type TicketForm } from "../src/index.ts";

// The terminal's real ticket logic: a proposal prefilled into the ticket must
// build back into exactly the order the user confirmed. Imported through a
// variable so tsc does not type-check the app's source under this package's
// settings (the app is not an ES module package); the round trip below is the
// contract.
const orderForm = new URL("../../../apps/terminal/src/lib/order-form.ts", import.meta.url).href;
const { buildOrder } = (await import(orderForm)) as {
  buildOrder: (instrument: Instrument, form: TicketForm) => { ok: true; order: ClientOrder } | { ok: false; error: string };
};

const instruments = JSON.parse(readFileSync(new URL("./fixtures/instruments.json", import.meta.url), "utf8")) as MarketInstrument[];
const phrasings = ["dev.json", "holdout.json", "fresh.json"].flatMap((name) => (JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as { cases: { text: string }[] }).cases);

describe("prefilling the terminal's order ticket", () => {
  it("writes display strings the ticket shows as typed", () => {
    const tcs = instruments.find((i) => i.symbol === "TCS")!;
    expect(toTicket(tcs, { type: "limit", side: "buy", price: 410050, quantity: 10, timeInForce: "GTC", displayQuantity: 2 })).toEqual({
      kind: "limit", side: "buy", price: "4100.50", stopPrice: "", quantity: "10", timeInForce: "GTC", display: "2",
    });
    const btc = instruments.find((i) => i.symbol === "BTCUSDT")!;
    expect(toTicket(btc, { type: "stop", side: "sell", quantity: 5000, stopPrice: 7_900_000 })).toMatchObject({ kind: "stop", quantity: "0.05000", stopPrice: "79000.00", price: "" });
  });

  it("every order the rules propose for the labelled phrasings survives the round trip through the real ticket", () => {
    let checked = 0;
    for (const { text } of phrasings) {
      const p = toProposal(parseWithRules(text, instruments).fields, instruments);
      if (p.kind !== "order") continue;
      const instrument = instruments.find((i) => i.symbol === p.symbol)!;
      const built = buildOrder(instrument, toTicket(instrument, p.order));
      // The ticket never sends a time in force on market or stop-market
      // orders, so an IOC/FOK typed for one is lost there (see the README).
      const { timeInForce: _dropped, ...withoutTif } = p.order;
      const marketLike = p.order.type === "market" || (p.order.type === "stop" && p.order.limitPrice === undefined);
      const expected = marketLike ? withoutTif : p.order;
      expect(built, text).toEqual({ ok: true, order: expected });
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });
});
