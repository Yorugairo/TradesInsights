// Layout primitive: the top of a page — what this screen is, and the one thing
// to do about it.
//
// TASTE-insights Core Move 2 ("one screen, one next action") lives here. The
// `action` slot is singular on purpose. A page with four equally-weighted
// buttons has not decided what it is for, and the cockpit's whole complaint is
// that it reads as a data dump.

import type { ReactNode } from "react";

export default function PageHeader({
  title,
  titleTestId,
  description,
  action,
  meta,
  "data-testid": testId,
}: {
  title: string;
  /**
   * Testid for the <h1> itself, not the wrapper.
   *
   * `app.spec.ts:65` asserts `opportunity-title` is visible, and that hook names
   * the title — not the header block that also contains the description and the
   * action. Putting it on the wrapper would keep the test passing while quietly
   * changing what it points at, which is the kind of drift that makes a suite
   * stop meaning anything.
   */
  titleTestId?: string;
  description?: ReactNode;
  /** The primary action for this screen. One. */
  action?: ReactNode;
  /** Provenance line — SourceChips, last-refreshed, row counts. */
  meta?: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <header data-testid={testId} className="mb-[calc(var(--stack)*1.5)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 data-testid={titleTestId} className="text-2xl font-semibold text-ink">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-[70ch] text-ink-muted">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {meta ? <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div> : null}
    </header>
  );
}
