import { useState, type FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTerminal } from "@/lib/store";

const NAME_KEY = "ome:name";

function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function Login() {
  const { status, error, url, connect } = useTerminal(
    useShallow((s) => ({ status: s.status, error: s.error, url: s.url, connect: s.connect })),
  );
  const [name, setName] = useState(savedName);
  const connecting = status === "connecting";

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    try {
      localStorage.setItem(NAME_KEY, trimmed);
    } catch {
      // Storage can be unavailable (private mode); the name just is not remembered.
    }
    void connect(trimmed);
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border-[3px] border-ink bg-panel p-6 shadow-brutal-lg">
        <h1 className="text-2xl">
          <span className="mr-1 rounded border-2 border-ink bg-accent px-1.5 shadow-brutal-sm">OME</span>.terminal
        </h1>
        <p className="mt-3 text-sm text-muted">Paper trading on a matching engine built from scratch.</p>

        <label htmlFor="trader-name" className="mt-6 block text-xs font-bold text-text">
          Trader name
        </label>
        <input
          id="trader-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={32}
          autoFocus
          autoComplete="nickname"
          placeholder="e.g. anand"
          className="field mt-1 w-full rounded-md px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={connecting || name.trim() === ""}
          className="btn mt-4 w-full rounded-md bg-accent py-2 text-sm text-ink disabled:opacity-50"
        >
          {connecting ? "Connecting…" : status === "closed" ? "Reconnect" : "Start trading"}
        </button>

        {error !== null && (
          <div role="alert" className="mt-4 rounded-md border-2 border-ink bg-sell-soft p-3 text-xs">
            <p className="font-medium text-sell">{error}</p>
            <p className="mt-1 text-muted">
              Is the gateway running? Start it with <code className="num text-text">pnpm gateway</code>, and{" "}
              <code className="num text-text">pnpm bots</code> for a live market.
            </p>
          </div>
        )}
        <p className="mt-4 text-[11px] text-muted">
          Gateway: <span className="num">{url}</span>
        </p>
      </form>
    </main>
  );
}
