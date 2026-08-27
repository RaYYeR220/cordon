import type { Metadata } from "next";

import { Providers } from "./providers";

import "./globals.css";

export const metadata: Metadata = {
  title: "Cordon — public record",
  description:
    "A gate the pool cannot settle around. Credential and policy enforcement for shielded STRK20 value on Starknet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <a
          href="#record"
          className="sr-only focus:not-sr-only focus:absolute focus:left-gut focus:top-gut focus:z-50 focus:border focus:border-ink focus:bg-paper focus:px-bl focus:py-tick focus:no-underline"
        >
          Skip to the record
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
