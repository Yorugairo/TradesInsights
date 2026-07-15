import { desc, eq } from "drizzle-orm";
import type { Db } from "@otn/db";
import { coverageEntries, sourceRuns, sources } from "@otn/db";
import type { SourceHealthState } from "@otn/domain";

const CADENCE_MS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 31 * 24 * 60 * 60 * 1000,
};

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

  // Volume-drop check. unchangedCount counts hash-identical *artifacts*, not
  // records — an unchanged artifact means every record parsed from it before
  // is still current, so a run with unchanged content is never a volume drop.
  if (
    state === "green" &&
    previous &&
    previous.parsedCount > 0 &&
    latest &&
    latest.unchangedCount === 0
  ) {
    const usableLatest = latest.parsedCount + latest.duplicateCount;
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
