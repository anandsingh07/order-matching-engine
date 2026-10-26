"use client";

import dynamic from "next/dynamic";

// The terminal lives on a WebSocket and draws charts on a canvas, so it only
// makes sense in the browser: skip prerendering it.
const Terminal = dynamic(() => import("@/components/terminal"), {
  ssr: false,
  loading: () => <p className="p-6 text-sm text-muted">Loading terminal…</p>,
});

export default function TerminalLoader() {
  return <Terminal />;
}
