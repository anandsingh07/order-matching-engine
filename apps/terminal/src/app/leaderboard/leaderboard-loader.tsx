"use client";

import dynamic from "next/dynamic";

// Shares the terminal's WebSocket session (the store) and polls the gateway: browser only.
const Leaderboard = dynamic(() => import("@/components/leaderboard"), {
  ssr: false,
  loading: () => <p className="p-6 text-sm text-muted">Loading tournaments…</p>,
});

export default function LeaderboardLoader() {
  return <Leaderboard />;
}
