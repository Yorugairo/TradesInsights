import { desc, eq } from "drizzle-orm";
import type { Db } from "@otn/db";
import { coverageEntries, sourceRuns, sources } from "@otn/db";
import type { SourceHealthState } from "@otn/domain";

const CADENCE_MS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 31 * 24 * 60 * 60 * 1000,
};

/**
 * D2 — normalized fields whose per-run fill rate is tracked so a source that
 * silently stops emitting a column (spec §14 "required-field drop >20%") turns
 * red. The comparison is self-referential (this source's latest parsed run vs
 * its previous parsed run), so a field that is structurally null for a source
 * (e.g. valuation on a SEPA notice) never trips — only a field that WAS
 * reliably present and dropped does.
 */
export const MONITORED_FILL_FIELDS = [
  "addressRaw",
  "applicationDate",
  "issueDate",
  "valuationUsd",
  "units",
  "geometry",
  "organizations",
] as const;

/** A field counts as "reliably present" before a drop is meaningful. */
const FILL_BASELINE_MIN = 0.5;
/** Spec §14: a drop of more than 20% (relative) of a required field. */
const FILL_DROP_RATIO = 0.8;

export interface HealthReport {
  sourceKey: string;
  state: SourceHealthState;
  reasons: string[];
  lastSuccessAt: Date | null;
}

/**
 * Spec §14. Red: two consecutive failures, stale beyond twice cadence,
 * required-field/volume collapse, or unexpected zero usable records.
 * Amber: single failure, no history yet, or an unexpected volume drop.
 */
export async function evaluateSourceHealth(
  db: Db,
  sourceKey: string,
  now = new Date(),
): Promise<HealthReport> {
  const [source] = await db.select().from(sources).where(eq(sources.key, sourceKey));
  if (!source) throw new Error(`unknown source: ${sourceKey}`);

  const runs = await db
    .select()
    .from(sourceRuns)
    .where(eq(sourceRuns.sourceId, source.id))
    .orderBy(desc(sourceRuns.startedAt))
    .limit(5);

  const reasons: string[] = [];
  let state: SourceHealthState = "green";

  const completed = runs.filter((r) => r.status !== "running");
  const successes = completed.filter(
    (r) => r.status === "succeeded" || r.status === "completed_with_errors",
  );
  const lastSuccessAt = successes[0]?.completedAt ?? null;

  if (completed.length === 0) {
    return { sourceKey, state: "amber", reasons: ["no completed runs yet"], lastSuccessAt };
  }

  const [latest, previous] = completed;
  if (latest?.status === "failed" && previous?.status === "failed") {
    state = "red";
    reasons.push("two consecutive failed runs");
  } else if (latest?.status === "failed") {
    state = "amber";
    reasons.push("latest run failed");
  }

  const cadenceMs = CADENCE_MS[source.cadence];
  if (cadenceMs && lastSuccessAt && now.getTime() - lastSuccessAt.getTime() > 2 * cadenceMs) {
    state = "red";
    reasons.push(`stale: no success within 2x ${source.cadence} cadence`);
  }

  if (
    latest &&
    latest.status !== "failed" &&
    latest.discoveredCount > 0 &&
    latest.parsedCount === 0 &&
    latest.unchangedCount === 0 &&
    latest.duplicateCount === 0
  ) {
    state = "red";
    reasons.push("unexpected zero usable records");
  }

  // D1 — a parser that failed self-reconciliation (printed-total mismatch,
  // out-of-range value, column-shape break) is producing values we cannot
  // trust. This is the one health signal that catches a silent positional
  // mis-parse — volume, zero-record, and fingerprint checks all stay green
  // through it. Red so the publication gate suppresses deliveries built on it.
  const invariantViolations =
    (latest?.metricsJson as { invariantViolations?: number } | null)?.invariantViolations ?? 0;
  if (invariantViolations > 0) {
    state = "red";
    reasons.push(`parser invariant violation (${invariantViolations}) — possible layout drift`);
  }

  // D2 — required-field drop (spec §14). Compare the two most recent runs that
  // actually parsed records; a monitored field that was reliably present and
  // then dropped >20% relative means the source silently stopped emitting it.
  const fills = completed
    .map((r) => (r.metricsJson as { fieldFill?: Record<string, number> } | null)?.fieldFill)
    .filter((f): f is Record<string, number> => !!f && Object.keys(f).length > 0);
  if (fills.length >= 2) {
    const [latestFill, prevFill] = fills;
    for (const field of MONITORED_FILL_FIELDS) {
      const prev = prevFill![field];
      const cur = latestFill![field];
      if (prev !== undefined && cur !== undefined && prev >= FILL_BASELINE_MIN && cur < prev * FILL_DROP_RATIO) {
        state = "red";
        reasons.push(
          `required-field '${field}' fill dropped ${Math.round(prev * 100)}%→${Math.round(cur * 100)}% (>20% drop)`,
        );
      }
    }
  }

  // Volume-drop check (spec §14 "unexpected volume drop"). Two expected,
  // healthy cases are exempt:
  //  - unchangedCount > 0: hash-identical artifacts — every previously parsed
  //    record is still current (unchanged counts artifacts, not records);
  //  - duplicateCount > 0: checkpoint/overlap windows legitimately shrink the
  //    fetched window after a wide first run; duplicates prove the source is
  //    still serving consistent records rather than collapsing.
  // A genuine collapse (zero usable records) is caught red above.
  if (
    state === "green" &&
    previous &&
    previous.parsedCount > 0 &&
    latest &&
    latest.unchangedCount === 0 &&
    latest.duplicateCount === 0
  ) {
    const usableLatest = latest.parsedCount;
    const usablePrev = previous.parsedCount + previous.duplicateCount;
    if (usablePrev > 0 && usableLatest < usablePrev * 0.5) {
      state = "amber";
      reasons.push("usable record volume dropped more than 50% vs previous run");
    }
  }

  if (state === "green") reasons.push("healthy");

  await db
    .update(coverageEntries)
    .set({ freshnessState: state, lastSuccessAt })
    .where(eq(coverageEntries.sourceId, source.id));

  return { sourceKey, state, reasons, lastSuccessAt };
}
