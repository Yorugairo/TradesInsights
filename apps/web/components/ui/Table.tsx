// Layout primitive: a data table.
//
// STRUCTURAL CONTRACT. `app.spec.ts:250` does
// `getByTestId("opportunities-table").locator("tbody tr")`. A card-grid rewrite
// breaks it, and the rule for this project is that the markup is wrong before
// the test is. So `Table` does not accept a `<tbody>` from the caller and hope
// they remembered — it renders `<table><thead>…</thead><tbody>{children}</tbody>`
// itself. Forgetting the tbody is not an available mistake.
//
// Rows may still be styled as cards (`display: grid` on the <tr>) when a page
// wants that look. The element stays a table; only the painting changes.
//
// Note globals.css sets `table { display: block; overflow-x: auto }` below
// 900px so wide tables scroll inside themselves rather than pushing the page
// into horizontal overflow. thead/tbody keep working under `display: block`.

import type { ReactNode } from "react";

export default function Table({
  head,
  children,
  caption,
  "data-testid": testId,
}: {
  /** The header row(s). Pass `<Tr>` of `<Th>`; omit for a headerless table. */
  head?: ReactNode;
  /** The body rows. Wrapped in <tbody> for you. */
  children: ReactNode;
  /** Visually hidden by default — a table with no caption is unlabelled to AT. */
  caption?: string;
  "data-testid"?: string;
}) {
  return (
    <table data-testid={testId} className="w-full border-collapse text-sm">
      {caption ? <caption className="sr-only">{caption}</caption> : null}
      {head ? <thead>{head}</thead> : null}
      <tbody>{children}</tbody>
    </table>
  );
}

export function Tr({
  children,
  className = "",
  "data-testid": testId,
}: {
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <tr data-testid={testId} className={`border-t border-line ${className}`.trim()}>
      {children}
    </tr>
  );
}

/** Header row: no top border, muted ink, left-aligned unless numeric. */
export function HeadTr({ children }: { children: ReactNode }) {
  return <tr className="text-left text-ink-muted">{children}</tr>;
}

export function Th({
  children,
  numeric = false,
  scope = "col",
}: {
  children: ReactNode;
  numeric?: boolean;
  scope?: "col" | "row";
}) {
  return (
    <th
      scope={scope}
      className={[
        "px-[var(--row-pad-x)] py-[var(--row-pad-y)] font-medium",
        numeric ? "text-right tabular-nums" : "",
      ]
        .join(" ")
        .trim()}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  numeric = false,
  className = "",
}: {
  children: ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <td
      className={[
        "px-[var(--row-pad-x)] py-[var(--row-pad-y)] align-top text-ink",
        numeric ? "text-right tabular-nums" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </td>
  );
}
