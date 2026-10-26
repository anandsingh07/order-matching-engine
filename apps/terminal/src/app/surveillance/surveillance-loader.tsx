"use client";

import dynamic from "next/dynamic";

// Reads the admin key from localStorage and polls the gateway: browser only.
const Surveillance = dynamic(() => import("@/components/surveillance"), {
  ssr: false,
  loading: () => <p className="p-6 text-sm text-muted">Loading surveillance…</p>,
});

export default function SurveillanceLoader() {
  return <Surveillance />;
}
