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
    sourceId: rec.sourceId,
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
    // `adjudicating` — this record is the one being decided, so it must not be
    // parked behind a sibling whose review is only waiting on this decision.
    // See ResolveOptions.adjudicating for the deadlock it prevents.
    outcome = await resolveRecord(db, row, {
      excludeProjectIds: review.candidateProjectId ? [review.candidateProjectId] : [],
      adjudicating: true,
    });
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
/**
 * Whether a pending review is something a HUMAN can decide, or something that
 * needs machine evidence gathered first.
 *
 * The distinction matters because the queue is mostly the second kind. Measured
 * 2026-07-24: of 2,278 pending rows, 1,518 are `proximity_org` — a fuzzy name
 * near a location with, in the resolver's own words,
 * `fuzzy_without_parcel_or_org_support`. All 1,518 carry the identical score of
 * 0.600 because there is nothing to score. Put in front of an operator they are
 * not a decision, they are 1,518 shrugs; what they need is a parcel or org
 * signal, which is a pipeline job, not a review job.
 */
export type ResolutionReviewState = "actionable" | "awaiting_evidence";

export const RESOLUTION_REVIEW_STATES: readonly ResolutionReviewState[] = [
  "actionable",
  "awaiting_evidence",
];

/**
 * Reasons that leave a human with nothing to check. Everything else — a shared
 * address, an overlapping parcel, a set of candidates to choose between — gives
 * the reviewer a concrete fact to work from.
 *
 * FAIL CLOSED, mirroring `google_place_review_v1`: this is an INCLUDE-list of
 * "nothing to decide", inverted below so an unrecognised reason lands in
 * `awaiting_evidence` rather than in the operator's queue. A new resolver rule
 * therefore goes quiet and visible instead of quietly padding the queue with
 * rows nobody can act on.
 */
const NO_HUMAN_SIGNAL_REASONS = new Set<string>([
  "fuzzy_without_parcel_or_org_support",
  "proximity_only",
]);

/** Reasons that DO give a reviewer something concrete to adjudicate. */
const HUMAN_DECIDABLE_REASONS = new Set<string>([
  "same_address_name_mismatch",
  "same_address",
  "conflicting_jurisdiction",
  "multiple_address_candidates",
  "multiple_parcel_candidates",
]);

/**
 * Pure — unit-tested, and reused by both the queue view and the cockpit so the
 * two can never disagree about how big the real queue is.
 *
 * A row is actionable only when at least one of its reasons is known-decidable
 * AND none of them is a known no-signal reason. `generic_name` appears alongside
 * both kinds and is deliberately in neither set: it qualifies the OTHER reason
 * rather than standing alone.
 */
export function classifyResolutionReviewState(input: {
  matchedRule: string;
  reasons: readonly string[];
}): ResolutionReviewState {
  if (input.reasons.some((r) => NO_HUMAN_SIGNAL_REASONS.has(r))) return "awaiting_evidence";
  return input.reasons.some((r) => HUMAN_DECIDABLE_REASONS.has(r))
    ? "actionable"
    : "awaiting_evidence";
}

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
  /** Whether an operator can decide this cluster today. */
  reviewState: ResolutionReviewState;
  /** Every reason on the cluster — `reasonKey` is only the first. */
  reasons: string[];
}

/**
 * How many clusters, largest first, it takes to cover `fraction` of the rows.
 *
 * This is the number that makes the queue feel finite: 2,278 rows across 826
 * clusters sounds endless, but the largest 91 clusters are half of it. Pure so
 * the page and the cockpit quote the same figure.
 */
export function clustersToCover(clusters: readonly ReviewCluster[], fraction: number): number {
  const total = clusters.reduce((n, c) => n + c.count, 0);
  if (total === 0) return 0;
  const target = total * fraction;
  let seen = 0;
  let used = 0;
  for (const c of [...clusters].sort((a, b) => b.count - a.count)) {
    seen += c.count;
    used += 1;
    if (seen >= target) break;
  }
  return used;
}

export async function triageReviewQueue(db: Db): Promise<ReviewCluster[]> {
  const res = await db.execute(sql`
    SELECT rv.matched_rule,
      COALESCE(rv.reasons_json->>0, '') AS reason_key,
      COALESCE(
        (SELECT array_agg(value::text) FROM jsonb_array_elements_text(rv.reasons_json) AS value),
        ARRAY[]::text[]
      ) AS reasons,
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
    GROUP BY 1, 2, 3, 4, 5, 6
    ORDER BY n DESC, 1, 2`);
  return (res.rows as Record<string, unknown>[]).map((r) => {
    const matchedRule = r["matched_rule"] as string;
    const reasons = ((r["reasons"] as (string | null)[] | null) ?? []).filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    return {
      matchedRule,
      reasonKey: r["reason_key"] as string,
      reasons,
      reviewState: classifyResolutionReviewState({ matchedRule, reasons }),
      candidateProjectId: (r["candidate_project_id"] as string | null) ?? null,
      candidateName: (r["candidate_name"] as string | null) ?? null,
      candidateCounty: (r["candidate_county"] as string | null) ?? null,
      count: Number(r["n"]),
      minScore: Number(r["min_score"]),
      maxScore: Number(r["max_score"]),
      sampleTitles: ((r["samples"] as (string | null)[]) ?? []).filter((s): s is string =>
        Boolean(s),
      ),
    };
  });
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
