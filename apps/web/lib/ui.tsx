import type { CSSProperties, ReactNode } from "react";

/**
 * The pre-Tailwind shared UI. Kept, because 24 pages import `table`/`cell` as
 * inline styles and `Badge` by name — rewriting all of them is Phase 3, one page
 * at a time.
 *
 * What changed in Phase 2 is only the COLOUR VALUES, from hardcoded light-mode
 * hexes to the token layer. That is a one-line-per-value edit here and it fixes
 * every page at once. It is not cosmetic: `#ddd` grid lines and pastel badge
 * fills were authored for a white page, and against the dark register the
 * badges rendered as near-white pills with pale text — a real contrast failure
 * that shipped the moment the register went dark. Inline styles can reference
 * custom properties, so the values re-theme with everything else.
 */
export const table: CSSProperties = { borderCollapse: "collapse", width: "100%", fontSize: "0.9rem" };
export const cell: CSSProperties = {
  border: "1px solid var(--line-strong)",
  padding: "var(--row-pad-y) var(--row-pad-x)",
  textAlign: "left",
  verticalAlign: "top",
};

export function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

export function fmtMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `$${value.toLocaleString("en-US")}`;
}

/**
 * Same API, same four tones, same call sites — only the treatment moved from a
 * pastel fill to an outline, matching `components/proof/GateBadge`. Outline
 * rather than fill because the status colours are legible as TEXT in both
 * registers (measured: ok 8.1:1, warn 10.4:1, bad 7.1:1 on the dark canvas;
 * 5.0 / 5.1 / 6.6:1 on the light one), whereas a tinted fill would need a
 * separate foreground per register to stay above AA.
 */
const BADGE_TONES: Record<string, string> = {
  green: "border-ok text-ok",
  amber: "border-warn text-warn",
  red: "border-bad text-bad",
  gray: "border-line-strong text-ink-muted",
};

export function Badge({ children, tone }: { children: ReactNode; tone?: "green" | "amber" | "red" | "gray" }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-sm border px-1.5 py-px text-xs ${
        BADGE_TONES[tone ?? "gray"]
      }`}
    >
      {children}
    </span>
  );
}

export function healthTone(state: string): "green" | "amber" | "red" | "gray" {
  return state === "green" ? "green" : state === "amber" ? "amber" : state === "red" ? "red" : "gray";
}
