// Layout primitive: a titled page section.
//
// Distinct from Card: a Card is a bounded object inside a layout, a Panel is a
// division OF the page. Panels carry the <h2> outline that screen readers and
// the e2e suite both navigate by.
//
// THE HEADING IS A CONTRACT. `app.spec.ts:70-71` asserts
// `getByRole("heading", { name: "Confirmed facts vs. inferences" })` and
// `"Publication gate"` by exact text. Panel therefore renders `title` verbatim
// into a real heading element and never decorates it — no eyebrow prefix, no
// appended count, no title-casing. If a retrofit needs extra words, they go in
// `detail`.

import type { ReactNode } from "react";

export default function Panel({
  title,
  detail,
  action,
  children,
  level = 2,
  "data-testid": testId,
}: {
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  /** 2 by default; 3 for a subsection. Never skip a level. */
  level?: 2 | 3;
  "data-testid"?: string;
}) {
  const Heading = level === 2 ? "h2" : "h3";

  return (
    <section data-testid={testId} className="mb-[calc(var(--stack)*1.5)]">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <Heading
            className={
              level === 2
                ? "text-lg font-semibold text-ink"
                : "text-base font-semibold text-ink"
            }
          >
            {title}
          </Heading>
          {detail ? (
            <p className="mt-1 max-w-[70ch] text-sm text-ink-muted">{detail}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}
