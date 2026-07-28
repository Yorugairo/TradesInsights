import { bandLabel, stageLabel } from "../../../lib/format.js";

/** The subset of the list page's URL state that can make a table empty. */
export type EmptyScope = {
  state?: string;
  county?: string;
  stage?: string;
  q?: string;
  campus?: string;
};

/**
 * Why the opportunities table is empty, in terms of what is actually known.
 *
 * `scopedTotal` comes from `opportunityBandSummary`, which honours the county /
 * stage / search / campus filters but NOT the band. It is therefore not a count
 * of the account's whole book, and reading `scopedTotal === 0` as "this account
 * has nothing" is wrong the moment the search box has text in it — the first
 * version of this page told an operator who mistyped a search that their account
 * had never been scored.
 *
 * `EmptyState` requires a reason so an empty table cannot be silent. A
 * confidently wrong reason is worse than the silence it replaced, which is why
 * this lives in its own module with its own tests.
 */
export function emptyReason(params: EmptyScope, scopedTotal: number): string {
  // Band is deliberately NOT in this list: `scopedTotal` ignores the band, so a
  // sentence about scopedTotal may not name the band as one of its terms.
  const scope: string[] = [];
  if (params.q) scope.push(`search “${params.q}”`);
  if (params.county) scope.push(`county ${params.county}`);
  if (params.stage) scope.push(`stage ${stageLabel(params.stage)}`);
  if (params.campus === "1") scope.push("active campus only");

  if (scopedTotal === 0) {
    return scope.length === 0
      ? // No constraint at all, and the summary counts every band including
        // archive — the account genuinely has no opportunity rows.
        "This account has no opportunity rows at all — the scorer has not produced any for it yet, which is not the same as every project having been rejected."
      : `Nothing matches ${scope.join(", ")}. Widen or clear the filters to see what is there.`;
  }

  // The scope matched rows; the band is what excluded them.
  const matched =
    scope.length === 0
      ? `${scopedTotal} opportunities exist for this account`
      : `${scopedTotal} opportunities match ${scope.join(", ")}`;
  return params.state
    ? `${matched}, but none of them are in ${bandLabel(params.state)}.`
    : `${matched}, but all of them are archived — the default view excludes archive.`;
}
