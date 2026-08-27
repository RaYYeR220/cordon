import type { ReactNode } from "react";

import { Colophon } from "@/components/shell/Colophon";
import { ContentsStrip } from "@/components/shell/JumpNav";
import { Masthead } from "@/components/shell/Masthead";
import { SourceStrip } from "@/components/shell/SourceStrip";
import { Rule } from "@/components/record/primitives";

/**
 * The record's chrome.
 *
 * A masthead, a strip saying which record is on the page, a printed contents,
 * and a colophon. Five screens sit between them, each numbered, so the whole
 * product reads as one document rather than five pages of an app.
 */
export default function RecordLayout({ children }: { children: ReactNode }) {
  return (
    <div className="sheet pt-gut">
      <Masthead />
      <Rule weight="thin" delay={60} />
      <SourceStrip />
      <ContentsStrip />
      <Rule weight="heavy" delay={120} />
      <main id="record">{children}</main>
      <Rule weight="heavy" />
      <Colophon />
    </div>
  );
}
