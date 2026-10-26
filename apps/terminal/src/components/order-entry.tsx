import { instrumentKind, type Side } from "@ome/client";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { contractTerms, orderValue } from "@/lib/derivatives";
import { formatAmount, formatMoney, formatPrice, formatTime } from "@/lib/format";
import { buildOrder, phaseRefusal, type OrderForm, type OrderKind } from "@/lib/order-form";
import { useInstrument, useTerminal } from "@/lib/store";
import { Countdown } from "./countdown";

const KINDS: { kind: OrderKind; label: string }[] = [
  { kind: "limit", label: "Limit" },
  { kind: "market", label: "Market" },
  { kind: "stop", label: "Stop" },
];

const blank = (side: Side): OrderForm => ({
  kind: "limit",
  side,
  price: "",
  stopPrice: "",
  quantity: "",
  timeInForce: "GTC",
  display: "",
});

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[11px] text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

const inputClass = "num field w-full rounded-md px-2.5 py-1 text-sm";

export function OrderEntry() {
  const instrument = useInstrument();
  const { symbol, last, prefill, placeOrder, auction, underlyingInAuction, account } = useTerminal(
    useShallow((s) => {
      const underlying = s.instruments.find((i) => i.symbol === s.symbol)?.underlying;
      return {
        symbol: s.symbol,
        last: s.lastPrice[s.symbol],
        prefill: s.prefill,
        placeOrder: s.placeOrder,
        auction: s.statuses[s.symbol]?.phase === "auction",
        // Futures and options cannot trade while their underlying is in an auction.
        underlyingInAuction: underlying !== undefined && s.statuses[underlying]?.phase === "auction" ? underlying : null,
        account: s.account,
      };
    }),
  );
  // The parent remounts this form per symbol (key={symbol}), so a new
  // instrument always starts from a blank form.
  const [form, setForm] = useState<OrderForm>(() => blank("buy"));
  const [error, setError] = useState<string | null>(null);
  // Set when sending was stopped by the market's phase. The message is worked out
  // again on every render, so it goes away by itself when the symbol reopens.
  const [phaseChecked, setPhaseChecked] = useState(false);
  const [sending, setSending] = useState(false);

  // Clicking a row in the order book, or a quote in the option chain, fills in
  // its price; a confirmed typed order fills in the whole form. Adjusting state
  // while rendering (guarded by the last prefill used) avoids an extra effect
  // pass. A prefill names its symbol: one made while selecting a new contract
  // arrives together with this fresh form.
  const [usedPrefill, setUsedPrefill] = useState<number | undefined>(undefined);
  // Set while the form holds a typed order the user has not sent yet.
  const [fromText, setFromText] = useState(false);
  if (prefill !== null && prefill.symbol === symbol && prefill.nonce !== usedPrefill && instrument !== undefined) {
    setUsedPrefill(prefill.nonce);
    if (prefill.from === "text") {
      setForm(prefill.form);
      setFromText(true);
    } else {
      setForm((f) => ({ ...f, kind: f.kind === "market" ? "limit" : f.kind, side: prefill.side, price: formatPrice(instrument, prefill.price) }));
    }
    setError(null);
    setPhaseChecked(false);
  }
  // After a typed order fills the form, focus goes to the hint, never to the
  // submit button: a held Enter can then never read, fill in and send in one go.
  const hintRef = useRef<HTMLParagraphElement>(null);
  const textNonce = prefill?.from === "text" && prefill.symbol === symbol ? prefill.nonce : undefined;
  useEffect(() => {
    if (textNonce !== undefined) hintRef.current?.focus();
  }, [textNonce]);

  if (instrument === undefined) return null;
  const update = (patch: Partial<OrderForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setError(null);
    setPhaseChecked(false);
  };

  const built = buildOrder(instrument, form);
  const refusal = phaseRefusal(form, { auction, underlyingInAuction });
  // Once the phase allows the order, forget the refusal: a later auction must not bring it back unasked.
  if (phaseChecked && refusal === null) setPhaseChecked(false);
  const message = error ?? (phaseChecked ? refusal : null);
  let estimate: string | null = null;
  if (built.ok) {
    const o = built.order;
    // Market orders are estimated at the last trade price.
    const price = o.type === "limit" ? o.price : o.type === "stop" ? (o.limitPrice ?? o.stopPrice) : last;
    if (price !== undefined) estimate = formatMoney(instrument, orderValue(instrument, price, o.quantity));
  }
  const buy = form.side === "buy";
  const balance = account?.balances.find((b) => b.currency === instrument.currency);
  const kind = instrumentKind(instrument);
  const terms = contractTerms(instrument);
  // What the estimate means: an option buyer pays the premium; a future costs only margin, on this notional.
  const valueLabel = kind === "option" ? "Premium" : kind === "future" ? "Notional" : "Estimated value";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!built.ok) {
      setError(built.error);
      return;
    }
    // The exchange would refuse these in this phase; say why before sending.
    if (refusal !== null) {
      setPhaseChecked(true);
      return;
    }
    setSending(true);
    setFromText(false);
    await placeOrder(symbol, built.order);
    setSending(false);
  }

  return (
    <form onSubmit={submit} className="space-y-3 border-b border-line p-3" aria-label="Order entry">
      {terms !== null && instrument.expiry !== undefined && (
        <div className="rounded-md border-2 border-ink bg-raised px-2.5 py-1.5 text-[11px] text-muted">
          <p className="font-semibold text-text">{terms}</p>
          <p>
            Expires <span className="num">{formatTime(instrument.expiry)}</span> (<Countdown until={instrument.expiry} /> left), cash-settled on{" "}
            {instrument.underlying}&apos;s average price over its last minute.
          </p>
        </div>
      )}
      <div role="group" aria-label="Side" className="grid grid-cols-2 gap-1 rounded-md border-2 border-ink bg-raised p-1">
        {(["buy", "sell"] as const).map((side) => (
          <button
            key={side}
            type="button"
            aria-pressed={form.side === side}
            onClick={() => update({ side })}
            className={`rounded py-1 text-sm font-bold capitalize ${
              form.side === side ? `btn text-ink ${side === "buy" ? "bg-buy-fill" : "bg-sell-fill"}` : "border-2 border-transparent text-muted hover:text-text"
            }`}
          >
            {side}
          </button>
        ))}
      </div>

      <div role="tablist" aria-label="Order type" className="flex gap-3 text-xs">
        {KINDS.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={form.kind === kind}
            onClick={() => update({ kind })}
            className={`border-b-[3px] pb-0.5 ${form.kind === kind ? "border-ink font-bold text-text" : "border-transparent text-muted hover:text-text"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {form.kind === "stop" && (
        <Field label="Stop price (trigger)" id="stop-price">
          <input id="stop-price" inputMode="decimal" value={form.stopPrice} onChange={(e) => update({ stopPrice: e.target.value })} className={inputClass} />
        </Field>
      )}
      {form.kind !== "market" && (
        <Field label={form.kind === "stop" ? "Limit price (empty = market)" : "Price"} id="price">
          <input
            id="price"
            inputMode="decimal"
            value={form.price}
            placeholder={last === undefined ? "" : formatPrice(instrument, last)}
            onChange={(e) => update({ price: e.target.value })}
            className={inputClass}
          />
        </Field>
      )}
      <Field label="Quantity" id="quantity">
        <input id="quantity" inputMode="decimal" value={form.quantity} onChange={(e) => update({ quantity: e.target.value })} className={inputClass} />
      </Field>

      {form.kind !== "market" && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Time in force" id="tif">
            <select
              id="tif"
              value={form.timeInForce}
              onChange={(e) => update({ timeInForce: e.target.value as OrderForm["timeInForce"] })}
              className={inputClass}
            >
              <option value="GTC">GTC</option>
              <option value="IOC">IOC</option>
              <option value="FOK">FOK</option>
            </select>
          </Field>
          {form.kind === "limit" && (
            <Field label="Iceberg (show)" id="display">
              <input id="display" inputMode="decimal" placeholder="optional" value={form.display} onChange={(e) => update({ display: e.target.value })} className={inputClass} />
            </Field>
          )}
        </div>
      )}

      <div className="space-y-1 text-[11px] text-muted">
        <div className="flex justify-between">
          <span>{valueLabel}</span>
          <span className="num">{estimate ?? "—"}</span>
        </div>
        {balance !== undefined && (
          <div className="flex justify-between">
            <span>Buying power</span>
            <span className="num">{account?.unlimited ? "Unlimited" : `${formatAmount(balance.buyingPower)} ${balance.currency}`}</span>
          </div>
        )}
      </div>

      {message !== null && (
        <p role="alert" className="text-xs text-sell">
          {message}
        </p>
      )}

      {fromText && (
        <p id="ticket-from-text" ref={hintRef} tabIndex={-1} className="text-[11px] text-warn outline-none focus:underline">
          Filled in from your text: check every field, then press {buy ? "Buy" : "Sell"} {symbol} to send.
        </p>
      )}

      <button
        type="submit"
        disabled={sending}
        className={`btn w-full rounded-md py-2 text-sm text-ink disabled:opacity-60 ${buy ? "bg-buy-fill" : "bg-sell-fill"}`}
      >
        {sending ? "Sending…" : `${buy ? "Buy" : "Sell"} ${symbol}`}
      </button>
    </form>
  );
}
