import { useEffect, useState } from "react";
import { formatCountdown } from "@/lib/derivatives";

/** The current time, refreshed every `intervalMs`. */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Time left until `until` ("12:05"), ticking once a second. A component of
 * its own so only this text re-renders, not the panel around it.
 */
export function Countdown({ until }: { until: number }) {
  const now = useNow();
  return <span className="num">{formatCountdown(until - now)}</span>;
}
