import { TradingClient, type Instrument, type ParseOrderReply, type ParseOrderStatus } from "@ome/client";
import { useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { formatPrice, formatQuantity } from "@/lib/format";
import { coveredOrders, failureText, reduce, sentRows, sourceLine, ticketPlan, UI_TIMEOUT_MS } from "@/lib/nl-order";
import type { OrderForm } from "@/lib/order-form";
import type { MyOrder } from "@/lib/orders";
import { useTerminal } from "@/lib/store";

// "Type an order": plain English ("buy 10 tcs at 4100") read by the gateway
// into a proposal. It never sends an order. Confirming fills in the order
// ticket above, and the user still presses the ticket's own Buy or Sell; only
// a cancel acts from here, behind a button that lists the exact orders.
//
// Keyboard safety: after a reply, focus stays in the text box (never on Fill
// in or Cancel), a held Enter is ignored, and the action buttons wait 300 ms
// after a result appears, so no key or stray click can read, fill in and send
// in one go.

/** Under this, a reply needs no spinner (the rules answer in about 15 ms over HTTP)... */
const SPINNER_MS = 300;
/** ...and over this, the local model is reading: show the time, and offer the rules alone. */
const MODEL_MS = 1_500;
/** Action buttons ignore clicks for this long after a result appears. */
const ARM_MS = 300;
const EXAMPLES = "Try: buy 10 TCS at 4100 · sell 0.01 BTC at market · cancel my INFY orders";

const inputClass = "field w-full rounded-md px-2.5 py-1 text-sm";
const buttonClass = "btn rounded-md px-3 py-1 text-xs disabled:opacity-50";

export function TypeOrder() {
  const { client, url, instruments, orders, prefillTicket, cancelOrder } = useTerminal(
    useShallow((s) => ({
      client: s.client,
      url: s.url,
      instruments: s.instruments,
      orders: s.orders,
      prefillTicket: s.prefillTicket,
      cancelOrder: s.cancelOrder,
    })),
  );
  const [text, setText] = useState("");
  const [box, dispatch] = useReducer(reduce, { phase: "idle" });
  // undefined: not known yet; null: this gateway has no plain-English orders.
  const [status, setStatus] = useState<ParseOrderStatus | null | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);
  // The request whose result's action buttons take clicks: keyed to the id, so
  // an earlier result's arming timer can never arm a newer result early.
  const [armedFor, setArmedFor] = useState<number | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const request = useRef<{ id: number; controller: AbortController; timer: ReturnType<typeof setTimeout> } | null>(null);
  const nextId = useRef(1);

  useEffect(() => {
    let live = true;
    TradingClient.parseOrderStatus(url)
      .then((s) => live && setStatus(s))
      .catch(() => {}); // Unknown: keep the box, a request will say what is wrong.
    return () => {
      live = false;
    };
  }, [url]);

  // The elapsed-time ticker, only while a request is out.
  const reading = box.phase === "reading";
  const startedAt = reading ? box.startedAt : 0;
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => setElapsed(performance.now() - startedAt), 100);
    return () => clearInterval(timer);
  }, [reading, startedAt]);

  // Nothing may outlive the box.
  useEffect(
    () => () => {
      finish();
      disarm();
    },
    [],
  );

  if (status === null) return null;

  function disarm() {
    if (armTimer.current !== null) clearTimeout(armTimer.current);
    armTimer.current = null;
    setArmedFor(null);
  }

  /** Ends the current request, if any, without a reply. */
  function finish() {
    const r = request.current;
    if (r === null) return;
    clearTimeout(r.timer);
    r.controller.abort();
    request.current = null;
  }

  async function send(value: string, mode?: "rules") {
    if (client === null || value.trim() === "") return;
    finish();
    const id = nextId.current++;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      finish();
      dispatch({ type: "replied", id, reply: { kind: "failed", status: 408, message: "timed out" } });
    }, UI_TIMEOUT_MS);
    request.current = { id, controller, timer };
    setElapsed(0);
    disarm();
    dispatch({ type: "start", id, text: value, at: performance.now() });
    let reply: ParseOrderReply;
    try {
      reply = await client.parseOrder(value, { signal: controller.signal, ...(mode === undefined ? {} : { mode }) });
    } catch {
      return; // Stopped, replaced by a newer request, or timed out: that already shows.
    }
    if (request.current?.id !== id) return;
    clearTimeout(timer);
    request.current = null;
    if (reply.kind === "failed" && reply.status === 404) setStatus(null);
    else if (reply.kind !== "failed" && reply.kind !== "error" && status !== undefined && status !== null && status.mode !== "rules") {
      // The model's state as the last reply saw it.
      const state = reply.source === "llm" ? "ready" : reply.fallbackReason === "unreachable" || reply.fallbackReason === "http" ? "offline" : status.state;
      if (state !== status.state) setStatus({ ...status, state });
    }
    dispatch({ type: "replied", id, reply });
    armTimer.current = setTimeout(() => {
      armTimer.current = null;
      setArmedFor(id);
    }, ARM_MS);
  }

  function read(event: FormEvent) {
    event.preventDefault();
    void send(text);
  }

  function stop() {
    finish();
    dispatch({ type: "stopped" });
    inputRef.current?.focus();
  }

  function discard() {
    dispatch({ type: "cleared" });
    inputRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && event.repeat) event.preventDefault();
    if (event.key === "Escape") {
      event.preventDefault();
      if (reading) stop();
      else discard();
    }
  }

  const model = status?.model ?? "the local model";
  const help =
    status?.state === "rules_only"
      ? "Read by the built-in rules. Stocks and BTC. Nothing is sent until you press Buy or Sell in the ticket."
      : status?.state === "offline"
        ? "The local model is offline: simple phrasings like “buy 10 TCS at 4100” still work. Nothing is sent until you press Buy or Sell in the ticket."
        : `Read by built-in rules and ${model} on this computer. Stocks and BTC. Nothing is sent until you press Buy or Sell in the ticket.`;

  return (
    <form aria-label="Plain-English order" onSubmit={read} className="space-y-2 p-3">
      <label htmlFor="nl-text" className="block text-[11px] font-semibold text-text">
        Type an order
      </label>
      <div className="flex gap-2">
        <input
          id="nl-text"
          ref={inputRef}
          value={text}
          maxLength={status?.maxTextLength ?? 300}
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. buy 10 TCS at 4100"
          aria-describedby="nl-help"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className={inputClass}
        />
        {/* "Stop", not "Cancel": in a trading app, cancel means cancelling orders. */}
        {reading && elapsed >= SPINNER_MS ? (
          <button type="button" onClick={stop} className={`${buttonClass} bg-panel`}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={reading || text.trim() === "" || client === null} className={`${buttonClass} bg-cyan text-ink`}>
            Read
          </button>
        )}
      </div>
      <p id="nl-help" className="text-[11px] text-muted">
        {help}
      </p>
      <div aria-live="polite" aria-atomic="true" aria-busy={reading}>
        {reading && elapsed >= SPINNER_MS && (
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <p role="status" className="flex items-center gap-2">
              <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 animate-spin">
                <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="10" />
              </svg>
              {elapsed >= MODEL_MS ? `Reading with ${model} · ${Math.floor(elapsed / 1000)} s` : "Reading…"}
            </p>
            {elapsed >= MODEL_MS && (
              <button type="button" onClick={() => void send(box.text, "rules")} className={`${buttonClass} bg-panel`}>
                Use rules only
              </button>
            )}
          </div>
        )}
        {box.phase === "result" && (
          <Result
            reply={box.reply}
            armed={armedFor === box.id}
            instruments={instruments}
            orders={orders}
            onFill={(symbol, form) => {
              prefillTicket(symbol, form);
              dispatch({ type: "cleared" });
              setText("");
            }}
            onCancel={(list) => {
              for (const o of list) void cancelOrder(o);
              discard();
              setText("");
            }}
            onDiscard={discard}
          />
        )}
      </div>
    </form>
  );
}

interface Props {
  reply: ParseOrderReply;
  /** False for a moment after the result appears: the action buttons ignore stray clicks. */
  armed: boolean;
  instruments: Instrument[];
  orders: Record<string, MyOrder>;
  onFill: (symbol: string, form: OrderForm) => void;
  onCancel: (orders: MyOrder[]) => void;
  onDiscard: () => void;
}

function Result({ reply, armed, instruments, orders, onFill, onCancel, onDiscard }: Props) {
  if (reply.kind === "failed" || reply.kind === "error") {
    return (
      <p role="alert" className="text-xs text-sell">
        {reply.kind === "failed" ? failureText(reply) : `Could not read that: ${reply.message}.`}
      </p>
    );
  }
  const source = (
    <>
      <p className="text-[11px] text-muted">{sourceLine(reply)}</p>
      {reply.fallback !== undefined && <p className="text-[11px] text-muted">{reply.fallback}</p>}
    </>
  );
  const discard = (
    <button type="button" onClick={onDiscard} className={`${buttonClass} bg-panel`}>
      Discard
    </button>
  );

  if (reply.kind === "unclear") {
    return (
      <div className="space-y-1.5 text-xs">
        <p className="font-semibold">{reply.summary}</p>
        {reply.problems.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4 text-muted">
            {reply.problems.slice(0, 3).map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-muted">{EXAMPLES}</p>
        {source}
      </div>
    );
  }

  if (reply.kind === "cancel") {
    const covered = coveredOrders(reply, Object.values(orders));
    const where = reply.symbol === null ? "" : `${reply.symbol} `;
    return (
      <div className="space-y-1.5 text-xs">
        <p className="font-semibold">{reply.summary}</p>
        {covered.length === 0 ? (
          <p className="text-muted">You have no open {where}orders.</p>
        ) : (
          <ul aria-label="Orders to cancel" className="space-y-0.5">
            {covered.map((o) => {
              const instrument = instruments.find((i) => i.symbol === o.symbol);
              const qty = instrument === undefined ? String(o.quantity) : `${formatQuantity(instrument, o.filled)}/${formatQuantity(instrument, o.quantity)}`;
              const price = o.price === undefined ? (o.stopPrice === undefined ? "market" : `stop ${instrument === undefined ? o.stopPrice : formatPrice(instrument, o.stopPrice)}`) : instrument === undefined ? String(o.price) : formatPrice(instrument, o.price);
              return (
                <li key={o.clientOrderId} className="num flex justify-between gap-2">
                  <span>
                    {o.side === "buy" ? "Buy" : "Sell"} {o.symbol}
                  </span>
                  <span>{price}</span>
                  <span className="text-muted">{qty} filled</span>
                </li>
              );
            })}
          </ul>
        )}
        {source}
        <div className="flex gap-2">
          {covered.length > 0 && (
            <button type="button" disabled={!armed} onClick={() => onCancel(covered)} className={`${buttonClass} bg-sell-fill text-ink`}>
              Cancel {covered.length} open order{covered.length === 1 ? "" : "s"}
            </button>
          )}
          {discard}
        </div>
      </div>
    );
  }

  const instrument = instruments.find((i) => i.symbol === reply.symbol);
  const plan = instrument === undefined ? { error: `${reply.symbol} is no longer listed.` } : ticketPlan(instrument, reply.order);
  if ("error" in plan || instrument === undefined) {
    return (
      <div className="space-y-1.5 text-xs">
        <p className="font-semibold">{reply.summary}</p>
        <p role="alert" className="text-sell">
          {"error" in plan ? plan.error : ""}
        </p>
        {source}
        <div className="flex gap-2">{discard}</div>
      </div>
    );
  }
  const warnings = [...reply.warnings, ...plan.differences];
  return (
    <div className="space-y-1.5 text-xs">
      <p className="font-semibold">{reply.summary}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md border-2 border-ink bg-raised px-2.5 py-1.5">
        {sentRows(instrument, plan.sent).map((row) => (
          <div key={row.term} className="contents">
            <dt className="text-muted">{row.term}</dt>
            <dd className="num text-right">{row.value}</dd>
          </div>
        ))}
      </dl>
      {warnings.length > 0 && (
        <ul className="space-y-0.5 text-warn">
          {warnings.map((w, i) => (
            <li key={i}>Warning: {w}</li>
          ))}
        </ul>
      )}
      {source}
      <details className="text-[11px] text-muted">
        <summary className="cursor-pointer">How it was read</summary>
        <pre className="num mt-1 whitespace-pre-wrap break-all">{JSON.stringify(reply.fields, null, 1)}</pre>
      </details>
      <div className="flex gap-2">
        <button type="button" disabled={!armed} onClick={() => onFill(reply.symbol, plan.form)} className={`${buttonClass} bg-accent text-ink`}>
          Fill in the {reply.symbol} ticket
        </button>
        {discard}
      </div>
    </div>
  );
}
