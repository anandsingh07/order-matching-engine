import type { Metadata } from "next";
import LeaderboardLoader from "./leaderboard-loader";

export const metadata: Metadata = {
  title: "Tournaments",
  description: "Trading tournaments and live leaderboards for the order matching engine.",
};

export default function Page() {
  return <LeaderboardLoader />;
}
