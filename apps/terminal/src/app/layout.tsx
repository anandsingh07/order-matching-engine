import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "OME Terminal",
  description: "Paper-trading terminal for the order matching engine: live order book, charts and order entry.",
};

export const viewport: Viewport = {
  themeColor: "#fff4d6",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
