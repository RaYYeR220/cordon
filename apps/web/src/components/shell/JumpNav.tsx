"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { SCREENS } from "@/lib/record/screens";

/**
 * The printed contents strip.
 *
 * It is the table of contents of a document rather than an app's navigation
 * bar, so it sits in the flow under the masthead and prints its own numbering.
 */
export function ContentsStrip() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Screens"
      className="grid grid-cols-2 gap-x-gut gap-y-tick py-tick sm:grid-cols-3 lg:grid-cols-5"
    >
      {SCREENS.map((screen) => {
        const current = pathname === screen.href;
        return (
          <Link
            key={screen.href}
            href={screen.href}
            aria-current={current ? "page" : undefined}
            className={`border-0 hover:bg-transparent group ${current ? "" : ""}`}
          >
            <span className="label">{screen.number}</span>
            <span
              className={`block font-display text-body tracking-[var(--tracking-label)] uppercase ${
                current ? "text-ink" : "text-ink-2 group-hover:text-ink"
              }`}
            >
              {screen.title}
            </span>
            <span
              aria-hidden="true"
              className={`mt-1 block h-[2px] ${current ? "bg-ink" : "bg-rule group-hover:bg-ink"}`}
            />
          </Link>
        );
      })}
    </nav>
  );
}
