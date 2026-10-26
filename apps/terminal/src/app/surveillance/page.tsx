import type { Metadata } from "next";
import SurveillanceLoader from "./surveillance-loader";

export const metadata: Metadata = {
  title: "Market surveillance",
  description: "Live market-abuse detection for the order matching engine.",
};

export default function Page() {
  return <SurveillanceLoader />;
}
