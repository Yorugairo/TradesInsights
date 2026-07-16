import { and, eq } from "drizzle-orm";
import {
  projectEvents,
  projectRoles,
  recordResolutions,
  resolutionReviews,
  sourceRecords,
  type Db,
} from "@otn/db";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import {
  RESOLVER_VERSION,
  mergeIntoProjectForReview,
  resolveRecord,
  type ResolutionOutcome,
} from "./resolver.js";
import { extractFeatures } from "./normalize.js";

/**
 * M2.5 — merge-review / split workflow (spec §10): humans decide ambiguous
 * matches; every decision is recorded; undo never deletes source records.
 */

export interface PendingReview {
  id: string;
  sourceRecordId: string;
  candidateProjectId: string | null;
  matchedRule: string;
  score: number;
  reasons: unknown;
  createdAt: Date;
  recordTitle: string | null;
  recordSourceUrl: string | null;
}

export async function listPendingReviews(db: Db, limit = 100): Promise<PendingReview[]> {
  const rows = await db
    .select({
      id: resolutionReviews.id,
      sourceRecordId: resolutionReviews.sourceRecordId,
      candidateProjectId: resolutionReviews.candidateProjectId,
      matchedRule: resolutionReviews.matchedRule,
      score: resolutionReviews.score,
      reasons: resolutionReviews.reasonsJson,
      createdAt: resolutionReviews.createdAt,
      normalizedJson: sourceRecords.normalizedJson,
    })
    .from(resolutionReviews)
    .innerJoin(sourceRecords, eq(sourceRecords.id, resolutionReviews.sourceRecordId))
    .where(eq(resolutionReviews.status, "pending"))
    .orderBy(resolutionReviews.createdAt)
    .limit(limit);
  return rows.map((r) => {
    const rec = r.normalizedJson as { title?: string; sourceUrl?: string } | null;
    return {
      id: r.id,
      sourceRecordId: r.sourceRecordId,
      candidateProjectId: r.candidateProjectId,
      matchedRule: r.matchedRule,
      score: r.score,
      reasons: r.reasons,
      createdAt: r.createdAt,
      recordTitle: rec?.title ?? null,
      recordSourceUrl: rec?.sourceUrl ?? null,
    };
  });
}

async function loadRecordRow(db: Db, sourceRecordId: string) {
  const [rec] = await db
    .select()
    .from(sourceRecords)
    .where(eq(sourceRecords.id, sourceRecordId));
  if (!rec) throw new Error(`source record ${sourceRecordId} not found`);
  return {
    id: rec.id,
    normalized: NormalizedSourceRecordSchema.parse(rec.normalizedJson),
    rawFields: (rec.rawFieldsJson ?? {}) as Record<string, unknown>,
    firstSeenAt: rec.firstSeenAt,
  };
}

/**
 * Decide a pending review. "merge" joins the record to the candidate project
 * with decision=review_approved; "reject" closes the review and re-resolves
 * the record with the candidate excluded from consideration (in practice the
 * exact passes have already failed, so rejection yields a new project unless
 * another candidate has appeared since).
 */
export async function decideReview(
  db: Db,
  reviewId: string,
  decision: "merge" | "reject",
  opts: { decidedBy: string; note?: string },
): Promise<ResolutionOutcome> {
  const [review] = await db
    .select()
    .from(resolutionReviews)
    .where(eq(resolutionReviews.id, reviewId));
  if (!review) throw new Error(`review ${reviewId} not found`);
  if (review.status !== "pending") {
    throw new Error(`review ${reviewId} already decided (${review.status})`);
  }
  const row = await loadRecordRow(db, review.sourceRecordId);

  let outcome: ResolutionOutcome;
  if (decision === "merge") {
    if (!review.candidateProjectId) {
      throw new Error(`review ${reviewId} has no candidate project to merge into`);
    }
    await mergeIntoProjectForReview(db, review.candidateProjectId, row);
    await db.insert(recordResolutions).values({
      sourceRecordId: row.id,
      projectId: review.candidateProjectId,
      resolverVersion: RESOLVER_VERSION,
      matchedRule: review.matchedRule,
      featuresJson: extractFeatures(row.normalized, row.rawFields),
      score: review.score,
      decision: "review_approved",
    });
    outcome = {
      sourceRecordId: row.id,
      outcome: "merged",
      rule: null,
      projectId: review.candidateProjectId,
    };
  } else {
    // Rejected candidate: close the review first (so re-resolution does not
    // skip the record for having a pending review), then resolve normally.
    await db
      .update(resolutionReviews)
      .set({
        status: "rejected",
        decidedAt: new Date(),
        decidedBy: opts.decidedBy,
        decisionNote: opts.note ?? null,
      })
      .where(eq(resolutionReviews.id, reviewId));
    outcome = await resolveRecord(db, row, { excludeProjectIds: review.candidateProjectId ? [review.candidateProjectId] : [] });
  }

  if (decision === "merge") {
    await db
      .update(resolutionReviews)
      .set({
        status: "merged",
        decidedAt: new Date(),
        decidedBy: opts.decidedBy,
        decisionNote: opts.note ?? null,
      })
      .where(eq(resolutionReviews.id, reviewId));
  }
  return outcome;
}

/**
 * Split/undo (spec §10): mark the record's active resolution undone and
 * remove the rows *derived from that record* (events, roles). The source
 * record itself and the resolution history row are never deleted; the record
 * becomes unresolved and re-enters the next resolve run.
 */
export async function undoResolution(
  db: Db,
  sourceRecordId: string,
  opts: { reason: string },
): Promise<void> {
  const [active] = await db
    .select()
    .from(recordResolutions)
    .where(
      and(
        eq(recordResolutions.sourceRecordId, sourceRecordId),
        eq(recordResolutions.status, "active"),
      ),
    );
  if (!active) throw new Error(`no active resolution for record ${sourceRecordId}`);

  await db
    .delete(projectEvents)
    .where(eq(projectEvents.sourceRecordId, sourceRecordId));
  await db
    .delete(projectRoles)
    .where(eq(projectRoles.sourceRecordId, sourceRecordId));
  await db
    .update(recordResolutions)
    .set({ status: "undone", undoneAt: new Date(), undoneReason: opts.reason })
    .where(eq(recordResolutions.id, active.id));
}
