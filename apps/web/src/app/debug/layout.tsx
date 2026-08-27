import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The debug console keeps its own skin.
 *
 * It is an engineering tool, not part of the record: a dark console where raw
 * JSON, revert traces and wallet capability probes are easier to read than they
 * would be on paper. Giving it its own layout is what lets the five product
 * screens be a document without this page having to pretend to be one too.
 */
export const metadata = {
  title: "Cordon · debug console",
};

export default function DebugLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
      <header className="border-b border-neutral-800">
        <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4 text-sm">
          <Link href="/" className="font-semibold tracking-tight no-underline">
            Cordon
          </Link>
          <span className="text-neutral-500">Debug console</span>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10 [&_a]:border-0">{children}</main>
    </div>
  );
}
