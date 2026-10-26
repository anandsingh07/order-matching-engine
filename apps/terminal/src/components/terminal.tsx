"use client";

import { useTerminal } from "@/lib/store";
import { AccountPanel } from "./account-panel";
import { DerivativesBar } from "./derivatives-bar";
import { Header } from "./header";
import { Login } from "./login";
import { Notices } from "./notices";
import { OptionChain } from "./option-chain";
import { OrderBook } from "./order-book";
import { OrderEntry } from "./order-entry";
import { PriceChart } from "./price-chart";
import { TradeTape } from "./trade-tape";
import { TypeOrder } from "./type-order";

export default function Terminal() {
  const connected = useTerminal((s) => s.status === "connected");
  const symbol = useTerminal((s) => s.symbol);
  if (!connected) return <Login />;

  return (
    <div className="flex h-dvh flex-col">
      <Header />
      <DerivativesBar />
      {/* Desktop: chart (with the option chain under it, for stocks with options) and account on the
          left, book in the middle, ticket and tape on the right. Narrow screens stack the panels and scroll. */}
      <main className="grid min-h-0 flex-1 grid-cols-1 gap-[3px] overflow-y-auto bg-line lg:grid-cols-[minmax(0,1fr)_300px_300px] lg:grid-rows-[minmax(0,1fr)_240px] lg:overflow-hidden">
        <div className="flex min-h-0 flex-col lg:col-start-1 lg:row-start-1">
          <PriceChart />
          <OptionChain />
        </div>
        <div className="flex min-h-0 flex-col lg:col-start-3 lg:row-span-2 lg:row-start-1">
          <section className="bg-panel">
            <OrderEntry key={symbol} />
          </section>
          {/* Below the ticket: a preview grows downwards into the tape, never moving the ticket's Buy/Sell button. */}
          <section className="border-b-2 border-line bg-panel">
            <TypeOrder />
          </section>
          <div className="hidden min-h-0 flex-1 flex-col lg:flex">
            <TradeTape />
          </div>
        </div>
        <div className="flex min-h-0 flex-col lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <OrderBook />
        </div>
        <div className="flex min-h-0 flex-col lg:col-start-1 lg:row-start-2">
          <AccountPanel />
        </div>
        <div className="flex min-h-[260px] flex-col lg:hidden">
          <TradeTape />
        </div>
      </main>
      <Notices />
    </div>
  );
}
