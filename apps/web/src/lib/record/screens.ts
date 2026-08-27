/**
 * The five screens, in the order the record prints them.
 *
 * Plain data in a plain module: it is read by a server component (the cover)
 * and by a client one (the contents strip), and a `"use client"` module's
 * exports arrive on the server as client references rather than as values.
 */
export const SCREENS = [
  { number: "01", href: "/pay", title: "Pay", blurb: "Compose a gated private payment" },
  {
    number: "02",
    href: "/passport",
    title: "Passport",
    blurb: "The credential, and what it is good for",
  },
  { number: "03", href: "/issuer", title: "Issuer console", blurb: "Issue, revoke, publish" },
  {
    number: "04",
    href: "/monitor",
    title: "Gate monitor",
    blurb: "The public record of decisions",
  },
  { number: "05", href: "/auditor", title: "Auditor", blurb: "Verify a scoped disclosure" },
] as const;
