// Layout primitive: nothing to show, and WHY there is nothing to show.
//
// The distinction this component is built around: "no rows matched your filter"
// and "we have never collected data for this" are different facts, and an empty
// table renders them identically. `reason` is required for exactly that reason —
// you cannot construct a silent empty state with this component.
//
// TASTE-insights Core Move 3: unknown is a value, and it renders.

import type { ReactNode } from "react";

export default function EmptyState({
  title,
  reason,
  action,
  "data-testid": testId,
}: {
  /** What is empty. "No opportunities match these filters." */
  title: string;
  /** Why it is empty, in the operator's terms. Required — see above. */
  reason: ReactNode;
  action?: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-md border border-dashed border-line-strong bg-surface px-4 py-8 text-center"
    >
      <p className="font-semibold text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-[52ch] text-sm text-ink-muted">{reason}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
