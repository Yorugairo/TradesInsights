// Proof primitive, Insights-specific: a score placed against THIS ACCOUNT'S own
// band thresholds.
//
// Why this is not `RangeBar`. RangeBar renders low -> typical -> high, an
// estimate with a spread. A score has no spread; it is one number on a fixed
// 0-100 scale (packages/intelligence/src/scoring.ts:794-801 clamps it there).
// Feeding a score through RangeBar would draw a band that does not exist, which
// is the fabrication rule applied to a chart instead of a value.
//
// What the bar adds over the bare number is the thing the number cannot say on
// its own: WHY this row is in the band it is in, and how close it sits to the
// next one. The thresholds are the account's configured
// `delivery.priority_review_min` / `weekly_digest_min` — real stored config, not
// a design constant — so a 79 one point under the line is visible at a glance.

/** Scores are clamped to 0-100 by the scorer; the scale is fixed, not observed. */
export const SCORE_MIN = 0;
export const SCORE_MAX = 100;

/**
 * Threshold defaults MIRROR `band()` in packages/intelligence/src/scoring.ts:387-394.
 * An account whose delivery config omits them is banded by the scorer at 80/65,
 * so the bar must draw the same lines or it would explain the banding wrongly.
 */
export const DEFAULT_PRIORITY_MIN = 80;
export const DEFAULT_DIGEST_MIN = 65;

/** Position on the fixed 0-100 scale, clamped. */
export function scorePercent(score: number): number {
  return Math.min(100, Math.max(0, ((score - SCORE_MIN) / (SCORE_MAX - SCORE_MIN)) * 100));
}

export default function ScoreBar({
  score,
  priorityMin = DEFAULT_PRIORITY_MIN,
  digestMin = DEFAULT_DIGEST_MIN,
}: {
  /** `null` when the scorer has not run for this opportunity. */
  score: number | null | undefined;
  priorityMin?: number;
  digestMin?: number;
}) {
  if (score === null || score === undefined) {
    // Dashed and empty, same discipline as ConfidenceMeter's unknown state: a
    // solid track at zero would claim we measured this and got nothing.
    return (
      <div
        className="h-[5px] w-full rounded-[4px] border border-dashed border-line-strong"
        role="img"
        aria-label="Not scored — the scorer has not run for this opportunity"
        data-score="unscored"
      />
    );
  }

  const marker = scorePercent(score);
  const priorityTick = scorePercent(priorityMin);
  const digestTick = scorePercent(digestMin);

  return (
    <div
      className="relative h-[5px] w-full rounded-[4px] bg-track"
      role="img"
      aria-label={`Score ${Math.round(score)} of 100. Priority review at ${priorityMin}, weekly digest at ${digestMin}.`}
      data-score={Math.round(score)}
    >
      {/* Filled portion. */}
      <div
        className="absolute inset-y-0 left-0 rounded-[4px] bg-accent"
        // Legitimately dynamic: the width IS the datum.
        style={{ width: `${marker}%` }}
      />
      {[digestTick, priorityTick].map((tick, i) => (
        <span
          key={i}
          className="absolute inset-y-[-2px] w-px bg-ink-subtle"
          // Legitimately dynamic: the tick's position is the account's stored
          // threshold, which is data, not layout.
          style={{ left: `${tick}%` }}
        />
      ))}
    </div>
  );
}
