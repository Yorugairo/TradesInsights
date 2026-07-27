import { and, eq, inArray, sql } from "drizzle-orm";
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
  previewResolution,
  resolveRecord,
  type ResolutionOutcome,
} from "./resolver.js";
import { extractFeatures } from "./normalize.js";
import { classifyNameAgreement, type NameAgreementBasis } from "./registry-identifiers.js";

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

/** Machine identity on reviews cleared by re-evaluation rather than by a person. */
export const REEVALUATION_DECIDED_BY = "system/reevaluation";

/**
 * Rules strong enough to overturn a parked review with no human involved.
 *
 * This set is the whole safety argument, so it is deliberately tiny. Both
 * members are an AUTHORITATIVE IDENTIFIER match — the same permit number in the
 * same jurisdiction, or an explicit cross-source reference. Neither is a guess.
 *
 * A parcel or fuzzy verdict is excluded even though re-evaluation would happily
 * produce one, because those are precisely the guesses the review exists to
 * question; auto-accepting them would not be "new evidence arrived", it would be
 * "we got bored of asking". That distinction is what keeps this from becoming a
 * lowered threshold in disguise.
 */
const STRONG_REEVALUATION_RULES = new Set(["official_id", "explicit_reference"]);

export interface ReevaluateSummary {
  scanned: number;
  /** Reviews a strong verdict clears — or WOULD clear, when `apply` is false. */
  resolved: number;
  /** Still needs a human (or still needs evidence). Left untouched. */
  stillAmbiguous: number;
  /** Strong rule that cleared each: `official_id` / `explicit_reference`. */
  byRule: Record<string, number>;
  /**
   * Applied decisions that landed on a project other than the one previewed.
   * MUST be 0. Anything else means preview and apply disagree, which is the
   * failure mode this design exists to prevent.
   */
  mismatched: number;
  /** False ⇒ nothing was written. */
  apply: boolean;
  errors: { reviewId: string; error: string }[];
}

/**
 * Re-ask the resolver about every parked review, and clear the ones that are no
 * longer ambiguous.
 *
 * A review is a verdict on the evidence available WHEN IT WAS PARKED. Evidence
 * keeps arriving — a licence lands from a PALS capture, a parcel gets geocoded,
 * a twin permit finally gets a project — but nothing ever re-asked the question,
 * so the queue only grew: 2,505 rows, the oldest from 2026-07-21. Pass 1b makes
 * that worse before it makes it better, because it deliberately routes records
 * with an undecided authoritative id INTO the queue; without this pass those
 * holds accumulate instead of clearing.
 *
 * The 46 split permits repaired by hand on 2026-07-27 are the design reference
 * case: every one of them already carried an authoritative permit id pointing at
 * a real project, and all that was needed was to ask again. This is that, on a
 * schedule, instead of a one-off script.
 *
 * DRY-RUN BY DEFAULT — `apply` must be opted into, matching `strict-bind:preview`
 * and `google-place-rescore:preview`.
 */
export async function reevaluatePendingReviews(
  db: Db,
  opts: {
    apply?: boolean;
    limit?: number;
    /** Restrict to specific reviews (targeted re-runs; test isolation) — the
     * same escape hatch `applyRecordUpdates` provides via `sourceRecordIds`. */
    reviewIds?: string[];
    logger?: { info(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
  } = {},
): Promise<ReevaluateSummary> {
  const apply = opts.apply ?? false;
  const limit = opts.limit ?? 2000;

  const pending = await db
    .select({
      id: resolutionReviews.id,
      sourceRecordId: resolutionReviews.sourceRecordId,
      candidateProjectId: resolutionReviews.candidateProjectId,
    })
    .from(resolutionReviews)
    .where(
      opts.reviewIds && opts.reviewIds.length > 0
        ? and(
            eq(resolutionReviews.status, "pending"),
            inArray(resolutionReviews.id, opts.reviewIds),
          )
        : eq(resolutionReviews.status, "pending"),
    )
    .orderBy(resolutionReviews.createdAt)
    .limit(limit);

  const summary: ReevaluateSummary = {
    scanned: 0,
    resolved: 0,
    stillAmbiguous: 0,
    byRule: {},
    mismatched: 0,
    apply,
    errors: [],
  };

  for (const review of pending) {
    summary.scanned++;
    try {
      const row = await loadRecordRow(db, review.sourceRecordId);
      const preview = await previewResolution(db, row);
      const rule = preview.rule;

      // Only a would-be MERGE counts. A would-be review (including pass 1b
      // parking this record behind a twin) means the question is still open,
      // and a would-be create means there is still nothing to attach to.
      if (
        preview.outcome !== "merged" ||
        rule === null ||
        !STRONG_REEVALUATION_RULES.has(rule) ||
        preview.projectId === null
      ) {
        summary.stillAmbiguous++;
        continue;
      }

      if (!apply) {
        summary.resolved++;
        summary.byRule[rule] = (summary.byRule[rule] ?? 0) + 1;
        continue;
      }

      // WHICH decision reproduces the strong verdict depends on whether it
      // agrees with the candidate this review was parked against, and getting
      // this backwards would bind the record to the wrong project.
      //
      //   agrees   → "merge": join the candidate, recorded as review_approved.
      //   disagrees → "reject": close the review and re-resolve. `decideReview`
      //               excludes the rejected candidate, which is safe precisely
      //               BECAUSE the strong match is a different project — the id
      //               pass then lands on it. Using "merge" here would bind the
      //               record to the stale candidate the evidence just overruled.
      //
      // The 46 were all the second kind, which is why rejecting them was the
      // repair rather than a discard.
      const decision = preview.projectId === review.candidateProjectId ? "merge" : "reject";
      const outcome = await decideReview(db, review.id, decision, {
        decidedBy: REEVALUATION_DECIDED_BY,
        note: `re-evaluated: ${rule} → project ${preview.projectId}`,
      });

      if (outcome.projectId === preview.projectId) {
        summary.resolved++;
        summary.byRule[rule] = (summary.byRule[rule] ?? 0) + 1;
      } else {
        summary.mismatched++;
        opts.logger?.error(
          {
            reviewId: review.id,
            sourceRecordId: review.sourceRecordId,
            decision,
            previewedProjectId: preview.projectId,
            actualProjectId: outcome.projectId,
            rule,
          },
          "re-evaluation landed on a different project than previewed",
        );
      }
    } catch (err) {
      // Never abort the batch — one malformed record must not stop the drain.
      // A review decided concurrently by a human lands here too, as
      // "already decided", which is the correct outcome: theirs wins.
      summary.errors.push({ reviewId: review.id, error: String(err) });
    }
  }

  opts.logger?.info(summary, "pending review re-evaluation complete");
  return summary;
}

export interface NameMismatchAudit {
  total: number;
  byBasis: Record<NameAgreementBasis, number>;
  /** A few of each basis, so the buckets can be sanity-checked by eye. */
  samples: { basis: NameAgreementBasis; recordTitle: string; candidateName: string }[];
}

/**
 * MEASUREMENT ONLY — changes nothing, decides nothing.
 *
 * `same_address_name_mismatch` is 784 of the 2,505 pending reviews. They were
 * parked because the fuzzy pass compared the record title to the candidate
 * project's canonical name with `nameSimilarity` and fell short of the
 * threshold. Since then the registry work has produced a more forgiving
 * comparison — `crossNameKeyLoose` (which strips truncated legal suffixes)
 * feeding `classifyNameAgreement`, which also recognises token containment.
 *
 * The open question is how much of that 784 is genuinely two different
 * businesses at one address (separate tenant improvements — the exact thing
 * spec §10 wants a human for) versus one business whose name was written two
 * ways. This answers it with a number instead of an intuition.
 *
 * DELIBERATELY NOT WIRED TO ANY BEHAVIOUR. Whether `contained` should be
 * allowed to auto-resolve a same-address mismatch is an owner decision with a
 * real false-bind cost: at one address, "Smith Electric" containing "Smith"
 * is not evidence of anything. Ship the measurement, argue from it later.
 */
export async function auditAddressNameMismatch(
  db: Db,
  opts: { limit?: number; samplesPerBasis?: number } = {},
): Promise<NameMismatchAudit> {
  const limit = opts.limit ?? 5000;
  const samplesPerBasis = opts.samplesPerBasis ?? 3;
  const res = await db.execute(sql`
    SELECT sr.normalized_json->>'title' AS record_title,
           p.canonical_name AS candidate_name
    FROM resolution_reviews rv
    JOIN source_records sr ON sr.id = rv.source_record_id
    JOIN projects p ON p.id = rv.candidate_project_id
    WHERE rv.status = 'pending'
      AND rv.matched_rule = 'address_name'
      AND rv.reasons_json ? 'same_address_name_mismatch'
    ORDER BY rv.created_at
    LIMIT ${limit}`);

  const audit: NameMismatchAudit = {
    total: 0,
    byBasis: { exact: 0, close: 0, contained: 0, none: 0 },
    samples: [],
  };
  const sampled: Record<string, number> = {};
  for (const r of res.rows as { record_title: string | null; candidate_name: string | null }[]) {
    audit.total++;
    const basis = classifyNameAgreement(r.candidate_name, r.record_title);
    audit.byBasis[basis]++;
    if ((sampled[basis] ?? 0) < samplesPerBasis) {
      sampled[basis] = (sampled[basis] ?? 0) + 1;
      audit.samples.push({
        basis,
        recordTitle: r.record_title ?? "",
        candidateName: r.candidate_name ?? "",
      });
    }
  }
  return audit;
}
