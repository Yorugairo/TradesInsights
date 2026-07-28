// Domain formatters, shared by every retrofitted page.
//
// Mirrors OneTradeNetwork/apps/registry/src/app/dashboard/insights/ui.tsx:7-34
// (`formatValuation` / `formatScore` / `bandLabel`), which is the same product
// vocabulary rendered by the other half of the seam. Same input, same string,
// both sides — a project that reads "Priority" in the registry cockpit must not
// read "priority_review" here.
//
// Every formatter maps absent to the em dash, never to zero and never to an
// empty string. `null` score means the scorer has not run; rendering it as `0`
// would place an unscored project at the bottom of a ranked list as though we
// had measured it and found nothing.

/** The em dash is the house rendering of "we do not have this". */
export const UNKNOWN = "—";

export function formatScore(score: number | null | undefined): string {
  return score === null || score === undefined ? UNKNOWN : String(Math.round(score));
}

export function formatValuation(value: number | null | undefined): string {
  if (value === null || value === undefined) return UNKNOWN;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

/**
 * Band labels. `o.state` is the stored band; `promoted` and `dismissed` are
 * MANUAL states an operator set by hand and are never written by the scorer, so
 * they are labelled as decisions rather than as tiers.
 */
const BAND_LABELS: Record<string, string> = {
  priority_review: "Priority review",
  weekly_digest: "Weekly digest",
  promoted: "Promoted",
  dismissed: "Dismissed",
  archive: "Archive",
  new: "New",
};

export function bandLabel(state: string): string {
  return BAND_LABELS[state] ?? state.replace(/_/g, " ");
}

/** Stage codes are stored snake_case; the operator reads prose. */
export function stageLabel(stage: string | null | undefined): string {
  return stage ? stage.replace(/_/g, " ") : UNKNOWN;
}

/** Route is the delivery lane the scorer chose, or null when it never ran. */
export function routeLabel(route: string | null | undefined): string {
  return route ? route.replace(/_/g, " ") : UNKNOWN;
}

/** Badge tone per band. Only `priority_review` earns the loud one. */
export function bandTone(state: string): "green" | "amber" | "red" | "gray" {
  if (state === "priority_review" || state === "promoted") return "green";
  if (state === "weekly_digest") return "amber";
  if (state === "dismissed") return "red";
  return "gray";
}
