import { and, eq, sql } from "drizzle-orm";
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

/**
 * Triage (Batch3 #1): the queue arrives in pattern-shaped waves — e.g. a new
 * county source lands and 1,400+ fuzzy-without-support reviews point at a few
 * hundred candidate projects. Clustering by (rule, primary reason, candidate
 * project) turns per-row review into per-pattern review: a human looks at the
 * candidate once and decides all of its pending records together.
 */
export interface ReviewCluster {
  matchedRule: string;
  reasonKey: string;
  candidateProjectId: string | null;
  candidateName: string | null;
  candidateCounty: string | null;
  count: number;
  minScore: number;
  maxScore: number;
  /** Up to 3 record titles so the pattern is recognizable at a glance. */
  sampleTitles: string[];
}

export async function triageReviewQueue(db: Db): Promise<ReviewCluster[]> {
  const res = await db.execute(sql`
    SELECT rv.matched_rule,
      COALESCE(rv.reasons_json->>0, '') AS reason_key,
      rv.candidate_project_id,
      p.canonical_name AS candidate_name,
      p.county AS candidate_county,
      count(*) AS n,
      min(rv.score) AS min_score,
      max(rv.score) AS max_score,
      (array_agg(sr.normalized_json->>'title' ORDER BY rv.created_at))[1:3] AS samples
    FROM resolution_reviews rv
    JOIN source_records sr ON sr.id = rv.source_record_id
    LEFT JOIN projects p ON p.id = rv.candidate_project_id
    WHERE rv.status = 'pending'
    GROUP BY 1, 2, 3, 4, 5
    ORDER BY n DESC, 1, 2`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    matchedRule: r["matched_rule"] as string,
    reasonKey: r["reason_key"] as string,
    candidateProjectId: (r["candidate_project_id"] as string | null) ?? null,
    candidateName: (r["candidate_name"] as string | null) ?? null,
    candidateCounty: (r["candidate_county"] as string | null) ?? null,
    count: Number(r["n"]),
    minScore: Number(r["min_score"]),
    maxScore: Number(r["max_score"]),
    sampleTitles: ((r["samples"] as (string | null)[]) ?? []).filter((s): s is string =>
      Boolean(s),
    ),
  }));
}

export interface BulkDecisionSummary {
  matched: number;
  decided: number;
  merged: number;
  created: number;
  reviewAgain: number;
  skipped: number;
  errors: { reviewId: string; error: string }[];
}

/**
 * Decide every pending review in one triage cluster. Each row goes through
 * decideReview — identical per-row provenance (decidedBy/note/status audit,
 * reject-then-re-resolve semantics) as a one-at-a-time decision; bulk is a
 * loop, not a shortcut. Errors are collected per row and never abort the
 * batch (the queue must drain even if one record is malformed).
 */
export async function decideReviewCluster(
  db: Db,
  cluster: {
    matchedRule: string;
    reasonKey: string;
    candidateProjectId: string | null;
    decision: "merge" | "reject";
    decidedBy: string;
    note?: string;
    /** Safety cap per invocation; rerun to continue. */
    limit?: number;
  },
): Promise<BulkDecisionSummary> {
  const limit = cluster.limit ?? 2000;
  const candidateFilter =
    cluster.candidateProjectId === null
      ? sql`rv.candidate_project_id IS NULL`
      : sql`rv.candidate_project_id = ${cluster.candidateProjectId}`;
  const res = await db.execute(sql`
    SELECT rv.id FROM resolution_reviews rv
    WHERE rv.status = 'pending'
      AND rv.matched_rule = ${cluster.matchedRule}
      AND COALESCE(rv.reasons_json->>0, '') = ${cluster.reasonKey}
      AND ${candidateFilter}
    ORDER BY rv.created_at
    LIMIT ${limit}`);
  const ids = (res.rows as { id: string }[]).map((r) => r.id);

  const summary: BulkDecisionSummary = {
    matched: ids.length,
    decided: 0,
    merged: 0,
    created: 0,
    reviewAgain: 0,
    skipped: 0,
    errors: [],
  };
  for (const id of ids) {
    try {
      const outcome = await decideReview(db, id, cluster.decision, {
        decidedBy: cluster.decidedBy,
        ...(cluster.note ? { note: cluster.note } : {}),
      });
      summary.decided++;
      if (outcome.outcome === "merged") summary.merged++;
      else if (outcome.outcome === "created") summary.created++;
      else if (outcome.outcome === "review") summary.reviewAgain++;
      else summary.skipped++;
    } catch (err) {
      summary.errors.push({ reviewId: id, error: String(err) });
    }
  }
  return summary;
}
