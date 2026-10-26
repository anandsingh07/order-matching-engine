"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { formatTime, humanize } from "@/lib/format";
import { flaggedInOrder, watchKey } from "@/lib/surveillance";

// The compliance view of the gateway's market-abuse surveillance (GET /api/surveillance).

interface Reason {
  feature: string;
  text: string;
  deviation: number;
}

interface Assessment {
  label: string;
  suspicion: number;
  probabilities: Record<string, number>;
  flagged: boolean;
  flaggedBy: ("classifier" | "anomaly")[];
  reasons: Reason[];
}

interface AlertView {
  traderId: string;
  traderName: string;
  symbol: string;
  time: number;
  assessment: Assessment;
}

interface Thresholds {
  classifier: number;
  anomaly: number;
}

interface Report {
  model: {
    trainedAt: string;
    metrics: {
      manipulation_detected: number;
      honest_false_positive_rate: number;
      unseen_manipulation?: { detected: number };
    };
    thresholds: Thresholds;
  };
  mode: "shadow" | "live";
  calibration: { symbol: string; windows: number; thresholds: Thresholds }[];
  current: AlertView[];
  alerts: AlertView[];
}

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:8080";
const KEY_STORAGE = "ome:admin-key";
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function storedKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

function useReport(key: string): { report: Report | null; flagged: AlertView[]; error: string | null } {
  const [state, setState] = useState<{ report: Report; flagged: AlertView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (key === "") return;
    let cancelled = false;
    // When each flagged trader was first seen flagged: keeps the cards in place from poll to poll.
    const since = new Map<string, number>();
    const load = async () => {
      try {
        const response = await fetch(`${GATEWAY_URL}/api/surveillance?key=${encodeURIComponent(key)}`);
        if (cancelled) return;
        if (response.status === 403) setError("That admin key was not accepted.");
        else if (response.status === 404) setError("Surveillance is not enabled on this gateway: the trained models were not found.");
        else if (!response.ok) setError(`The gateway answered ${response.status}.`);
        else {
          const report = (await response.json()) as Report;
          setState({ report, flagged: flaggedInOrder(report.current, report.alerts, since) });
          setError(null);
        }
      } catch {
        if (!cancelled) setError(`Cannot reach the gateway at ${GATEWAY_URL}. Start it with pnpm gateway.`);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key]);
  return { report: state?.report ?? null, flagged: state?.flagged ?? [], error };
}

function Card({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="brutal rounded-md bg-panel p-3">
      <p className="text-[11px] font-semibold text-muted">{label}</p>
      <p className="num mt-1 text-xl font-bold">{value}</p>
      <p className="mt-1 text-[11px] text-muted">{hint}</p>
    </div>
  );
}

function FlaggedTrader({ alert }: { alert: AlertView }) {
  const a = alert.assessment;
  const known = a.flaggedBy.includes("classifier");
  return (
    <article className="rounded-md border-2 border-l-[10px] border-ink border-l-pink bg-panel p-3 shadow-brutal">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3>
          {alert.traderName} <span className="num text-xs text-muted">({alert.traderId}) · {alert.symbol}</span>
        </h3>
        <div className="flex gap-1 text-[10px] font-semibold">
          {a.flaggedBy.map((by) => (
            <span key={by} className={`rounded border-2 border-ink px-1.5 py-px text-ink ${by === "classifier" ? "bg-pink" : "bg-cyan"}`}>
              {by === "classifier" ? "KNOWN PATTERN" : "UNUSUAL BEHAVIOUR"}
            </span>
          ))}
        </div>
      </header>
      <p className="mt-1 text-sm">
        {known ? (
          <>
            Looks like <strong>{humanize(a.label).toLowerCase()}</strong> ({pct(a.probabilities[a.label] ?? 0)} likely)
          </>
        ) : (
          <>Unlike any honest trading the model has seen</>
        )}
      </p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted">
        {a.reasons.map((r) => (
          <li key={r.feature}>{r.text}</li>
        ))}
      </ul>
    </article>
  );
}

export default function Surveillance() {
  const [draft, setDraft] = useState(storedKey);
  const [key, setKey] = useState(storedKey);
  const { report, flagged, error } = useReport(key);

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      localStorage.setItem(KEY_STORAGE, draft);
    } catch {
      // Not remembered in private mode; still used for this visit.
    }
    setKey(draft);
  }

  const watched = report?.current.length ?? 0;
  const m = report?.model.metrics;

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl">Market surveillance</h1>
          <p className="mt-1 text-xs text-muted">Live detection of spoofing, layering, wash trading and pump-and-dump, with the reasons for every flag.</p>
        </div>
        <Link href="/" className="btn rounded bg-panel px-3 py-1.5 text-xs text-ink">
          Back to the terminal
        </Link>
      </header>

      <form onSubmit={submit} className="flex flex-wrap items-end gap-2" aria-label="Open surveillance">
        <div>
          <label htmlFor="admin-key" className="block text-[11px] font-bold text-text">
            Admin key
          </label>
          <input
            id="admin-key"
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="local-dev-admin-key"
            className="field mt-1 w-64 rounded-md px-2.5 py-1.5 text-sm"
          />
        </div>
        <button type="submit" className="btn rounded-md bg-accent px-3 py-1.5 text-sm text-ink">
          Open
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="rounded-md border-2 border-ink bg-sell-soft p-3 text-sm">
          {error}
        </p>
      )}

      {report !== null && m !== undefined && (
        <>
          <section aria-label="Model" className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Card label="Traders watched now" value={String(watched)} hint={`${flagged.length} flagged`} />
            <Card label="Manipulation caught (offline test)" value={pct(m.manipulation_detected)} hint="markets the model never saw" />
            <Card label="Honest traders flagged (offline test)" value={pct(m.honest_false_positive_rate)} hint="false-positive rate" />
            <Card
              label="Unseen manipulation caught"
              value={m.unseen_manipulation === undefined ? "—" : pct(m.unseen_manipulation.detected)}
              hint={`a pattern held out of training · model trained ${new Date(report.model.trainedAt).toLocaleDateString()}`}
            />
          </section>

          {report.mode === "shadow" ? (
            <p role="status" className="rounded-md border-2 border-ink bg-accent/40 p-3 text-sm">
              <strong>Shadow mode.</strong> Every trader is scored but nothing alerts, while the system learns what honest trading looks
              like in each market. When the shadow period ends, each symbol gets its own thresholds.
            </p>
          ) : (
            report.calibration.length > 0 && (
              <section aria-label="Calibration" className="brutal rounded-md bg-panel p-3 text-xs">
                <h2 className="text-sm">Calibrated on this market&apos;s honest traffic</h2>
                <ul className="num mt-1 space-y-0.5 text-muted">
                  {report.calibration.map((c) => (
                    <li key={c.symbol}>
                      <span className="text-text">{c.symbol}</span> ({c.windows} windows): known-pattern threshold{" "}
                      {report.model.thresholds.classifier.toFixed(2)} → {c.thresholds.classifier.toFixed(2)}, unusual-behaviour threshold{" "}
                      {report.model.thresholds.anomaly.toFixed(1)} → {c.thresholds.anomaly.toFixed(1)}
                    </li>
                  ))}
                </ul>
              </section>
            )
          )}

          <section aria-label="Flagged traders" className="space-y-2">
            <h2 className="text-sm">Flagged now</h2>
            {flagged.length === 0 ? (
              <p className="brutal rounded-md bg-panel p-4 text-sm text-muted">
                Nobody is flagged. To see detections, run manipulator bots: <code className="num text-text">pnpm bots -- --cheaters</code>
              </p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {flagged.map((a) => (
                  <FlaggedTrader key={watchKey(a)} alert={a} />
                ))}
              </div>
            )}
          </section>

          <section aria-label="Alert log" className="brutal rounded-md bg-panel">
            <h2 className="border-b-2 border-line px-3 py-2 text-sm">Alert log</h2>
            <table className="w-full text-xs">
              <thead className="text-[11px] text-muted">
                <tr>
                  {["Time", "Trader", "Symbol", "Pattern", "Suspicion", "Main reason"].map((h) => (
                    <th key={h} className="px-3 py-1.5 text-left font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.alerts.slice(0, 40).map((a) => (
                  <tr key={`${watchKey(a)}|${a.time}`} className="border-t border-line/15">
                    <td className="num px-3 py-1.5">{formatTime(a.time)}</td>
                    <td className="px-3 py-1.5">{a.traderName}</td>
                    <td className="px-3 py-1.5">{a.symbol}</td>
                    <td className="px-3 py-1.5">{a.assessment.flaggedBy.includes("classifier") ? humanize(a.assessment.label) : "Unusual"}</td>
                    <td className="num px-3 py-1.5">{pct(a.assessment.suspicion)}</td>
                    <td className="px-3 py-1.5 text-muted">{a.assessment.reasons[0]?.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}
