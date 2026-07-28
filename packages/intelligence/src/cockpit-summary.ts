/**
 * Queue cockpit — one canonical count for every identity/enrichment review lane
 * across Insights and the Registry seam (queue-cockpit plan, Phase C).
 *
 * The cockpit is a FRONT DOOR, not a new source of truth: every number here is
 * read from the same place the individual queue pages read it, so the landing
 * page can never drift from the page it links to. `triageReviewQueue` is the
 * resolution-review count; a `registry_observations` group-by is the
 * registry-review count; `buildFamilies` + `matchPrincipalsToPeople` are the
 * family counts — the exact calls the corporate-families page makes.
 *
 * NULL, NEVER A FAKE ZERO. Two sections depend on the registry seam
 * (`REGISTRY_DATABASE_URL`): `families` (needs the identity contract view) and
 * `googlePlace` (needs a Place-queue view that only Phase D builds). When the
 * seam is offline — or, for Place, when the Phase D view does not exist yet —
 * the section is `null` so the UI can say "seam offline" instead of showing a
 * zero that reads as "nothing to do". This mirrors `createRegistryPool()`
 * returning null rather than crashing when the seam is unset.
 *
 * PRIVACY: the family counts are aggregate integers only; no principal name or
 * person name leaves this module. The page that renders them is still
 * admin-only, consistent with corporate-family.ts's contract.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import {
  buildPrincipalPersonIndex,
  classifyReviewTier,
  clustersToCover,
  fetchRegistryIdentityRows,
  matchPrincipalsToPeople,
  triageReviewQueue,
  type RegistryPoolLike,
  type ReviewCluster,
} from "@otn/resolution";
import { buildFamilies, loadPersonCandidates } from "./corporate-family.js";

/** Rule keys of the phone-match lane (queue 6). Phase A fuels this lane; until
 * then both rules are structurally unfueled (verified: 61 org phones, zero
 * overlap with any registry or L&I phone) and the count is an honest 0. */
const PHONE_LANE_RULE_KEYS = ["binding_phone_match", "binding_google_phone_match"] as const;

/** The registry_public view Phase D (Task D2) will expose for the Place queue.
 * It does not exist yet, so the probe below catches "relation does not exist"
 * and returns null. When Phase D ships the view with these three integer
 * columns, this section lights up with no change here. */
const GOOGLE_PLACE_VIEW = "registry_public.google_place_review_v1";

export interface CockpitResolutionReview {
  /** Every pending resolution review, summed across triage clusters. */
  total: number;
  /** Of those, the ones an operator can actually decide today. The rest are
   * waiting on parcel/org evidence, which is a pipeline job, not a review job —
   * counting them as "queue" overstates the work by roughly 3×. */
  actionable: number;
  /** Rows blocked on evidence. `actionable + awaitingEvidence === total`. */
  awaitingEvidence: number;
  /** Largest actionable clusters needed to clear 50% / 80% of the actionable
   * rows — what makes the queue feel finite. */
  clustersToHalf: number;
  clustersToEighty: number;
  /** The largest pattern-shaped clusters — review-per-pattern, not per-row. */
  clusters: ReviewCluster[];
}

export interface CockpitRegistryReview {
  total: number;
  byRule: { ruleKey: string; count: number }[];
  /** Evidence-defined confidence tiers (tier1 = exact name + a second checkable
   * fact). The mix is what says whether the queue is mostly easy or mostly hard. */
  byTier: { tier: string; label: string; count: number }[];
}

export interface CockpitFamilies {
  /** Derived families (entities under one L&I principal). */
  count: number;
  /** Principal↔person pairs that would ADD a company to a family (not already bound). */
  pairsNew: number;
  /** Of those, the corroborated ones (verdict strong | corroborated). */
  pairsStrong: number;
  /**
   * When these counts were derived, ISO-8601. Present when the caller supplied a
   * cached snapshot; absent when the derivation ran inline for this request.
   *
   * The UI is expected to RENDER it. Derived-on-a-schedule is a fine trade for a
   * dashboard, but a cached count presented as live is the never-fabricate rule
   * with extra steps.
   */
  derivedAt?: string;
  /** The snapshot is old enough that the UI should say so out loud. */
  stale?: boolean;
}

export interface CockpitGooglePlace {
  /** Human-ready today. */
  actionable: number;
  /** Waiting on the Phase D auto-resolver (never-built until D1). */
  awaitingAutoResolver: number;
  /** Waiting on evidence-gathering automation (a separate future workstream). */
  awaitingEvidence: number;
}

export interface CockpitLanes {
  /** Phone-lane candidates surfaced in the last 30 days (queue 6). */
  enrichmentPhoneCandidates30d: number;
  /** Domain lane (queue 5) is gated: 0/3,797 orgs carry a website today. */
  domainGated: true;
}

export interface QueueSummary {
  resolutionReview: CockpitResolutionReview;
  registryReview: CockpitRegistryReview;
  /** null when the registry seam is offline (no identity view to derive families). */
  families: CockpitFamilies | null;
  /** null when the seam is offline OR the Phase D Place view is not built yet. */
  googlePlace: CockpitGooglePlace | null;
  lanes: CockpitLanes;
}

/**
 * Assemble the cockpit summary. Insights-side sections always resolve;
 * seam-dependent sections are null when `registryPool` is null.
 */
export async function queueSummary(
  db: Db,
  registryPool: RegistryPoolLike | null,
  opts: {
    /**
     * Pre-derived family counts, normally from the web app's cached snapshot
     * (`apps/web/lib/registry-families.ts`).
     *
     * Deriving families inline means pulling 72,952 identity rows across the
     * seam — 5.2s warm, up to 79s cold, measured 2026-07-27. That is what made
     * this page a 9-21s render and tipped it past `statement_timeout` into a
     * 500. Pass the snapshot and this function never touches the seam for
     * families.
     *
     * `undefined` = derive inline (previous behaviour, kept for tests and the
     * worker). `null` = the caller knows there is nothing to show.
     */
    families?: CockpitFamilies | null;
  } = {},
): Promise<QueueSummary> {
  // SEQUENTIAL. The app pool max is 2; three concurrent reads meant this page
  // held both connections and starved every other in-flight request. Measured
  // twice during the Phase 3 retrofit: the same shape cost three e2e failures
  // on pages the change never touched.
  const resolutionReview = await resolutionReviewSummary(db);
  const registryReview = await registryReviewSummary(db);
  const lanes = await laneSummary(db);

  const families =
    opts.families !== undefined
      ? opts.families
      : registryPool
        ? await familiesSummary(db, registryPool)
        : null;
  // Seam-dependent, and cheap (a single aggregate over the contract view), so it
  // still runs inline. Null when the seam is offline — never a zero.
  const googlePlace = registryPool ? await googlePlaceSummary(registryPool) : null;

  return { resolutionReview, registryReview, families, googlePlace, lanes };
}

/**
 * Canonical resolution-review count: the triage clusters, summed — split by
 * whether a human can act on them. `clustersToCover` is the same function the
 * review page calls, so the two surfaces can never quote different numbers.
 */
async function resolutionReviewSummary(db: Db): Promise<CockpitResolutionReview> {
  const clusters = await triageReviewQueue(db); // ordered by count DESC
  const total = clusters.reduce((sum, c) => sum + c.count, 0);
  const decidable = clusters.filter((c) => c.reviewState === "actionable");
  const actionable = decidable.reduce((sum, c) => sum + c.count, 0);
  return {
    total,
    actionable,
    awaitingEvidence: total - actionable,
    clustersToHalf: clustersToCover(decidable, 0.5),
    clustersToEighty: clustersToCover(decidable, 0.8),
    clusters: decidable.slice(0, 5),
  };
}

/**
 * Canonical registry-review count: pending observations grouped by rule, plus
 * the evidence-tier mix.
 *
 * Tiers are computed in TS rather than SQL because `classifyReviewTier` is the
 * one authority on what a tier means — a parallel SQL definition is exactly how
 * two surfaces start disagreeing about the same queue.
 */
async function registryReviewSummary(db: Db): Promise<CockpitRegistryReview> {
  const res = await db.execute(sql`
    SELECT rule_key, count(*)::int AS n
    FROM registry_observations
    WHERE status = 'pending'
    GROUP BY rule_key
    ORDER BY n DESC`);
  const byRule = (res.rows as Record<string, unknown>[]).map((r) => ({
    ruleKey: r["rule_key"] as string,
    count: Number(r["n"]),
  }));
  const total = byRule.reduce((sum, r) => sum + r.count, 0);

  const rowsRes = await db.execute(sql`
    SELECT observation_type, rule_key, trust_score, trust_components_json, payload_json
    FROM registry_observations
    WHERE status = 'pending'`);
  const counts = new Map<string, { label: string; count: number }>();
  for (const r of rowsRes.rows as Record<string, unknown>[]) {
    const info = classifyReviewTier({
      observationType: r["observation_type"] as string,
      ruleKey: r["rule_key"] as string,
      trustScore: Number(r["trust_score"] ?? 0),
      trustComponents: (r["trust_components_json"] ?? {}) as Record<string, number>,
      payload: (r["payload_json"] ?? {}) as Record<string, unknown>,
    });
    const seen = counts.get(info.tier);
    if (seen) seen.count += 1;
    else counts.set(info.tier, { label: info.label, count: 1 });
  }
  const byTier = [...counts.entries()]
    .map(([tier, v]) => ({ tier, label: v.label, count: v.count }))
    .sort((a, b) => a.tier.localeCompare(b.tier));

  return { total, byRule, byTier };
}

/** Phone-lane candidates in the last 30 days (0 until Phase A fuels the lane). */
async function laneSummary(db: Db): Promise<CockpitLanes> {
  const res = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM registry_observations
    WHERE rule_key IN (${sql.join(
      PHONE_LANE_RULE_KEYS.map((k) => sql`${k}`),
      sql`, `,
    )})
      AND created_at >= now() - interval '30 days'`);
  const enrichmentPhoneCandidates30d = Number((res.rows[0] as { n?: unknown })?.n ?? 0);
  return { enrichmentPhoneCandidates30d, domainGated: true };
}

/** Family + principal↔person counts — the same derivation the families page runs. */
async function familiesSummary(db: Db, pool: RegistryPoolLike): Promise<CockpitFamilies> {
  const rows = await fetchRegistryIdentityRows(pool);
  const { families } = buildFamilies(rows);
  const candidates = await loadPersonCandidates(db);
  const pairs = matchPrincipalsToPeople(candidates, buildPrincipalPersonIndex(rows));
  const newPairs = pairs.filter((p) => !p.alreadyBound);
  const strong = newPairs.filter((p) => p.verdict === "strong" || p.verdict === "corroborated");
  return { count: families.length, pairsNew: newPairs.length, pairsStrong: strong.length };
}

/**
 * Google Place queue counts, read from the Phase D contract view. The view does
 * not exist until Phase D, so any error (missing relation, missing column) means
 * "not built yet" → null. Never invent a zero for a queue we cannot see.
 */
async function googlePlaceSummary(pool: RegistryPoolLike): Promise<CockpitGooglePlace | null> {
  try {
    const res = await pool.query(`
      SELECT
        count(*) FILTER (WHERE review_state = 'actionable')::int AS actionable,
        count(*) FILTER (WHERE review_state = 'awaiting_auto_resolver')::int AS awaiting_auto_resolver,
        count(*) FILTER (WHERE review_state = 'awaiting_evidence')::int AS awaiting_evidence
      FROM ${GOOGLE_PLACE_VIEW}`);
    const r = (res.rows[0] ?? {}) as Record<string, unknown>;
    return {
      actionable: Number(r["actionable"] ?? 0),
      awaitingAutoResolver: Number(r["awaiting_auto_resolver"] ?? 0),
      awaitingEvidence: Number(r["awaiting_evidence"] ?? 0),
    };
  } catch {
    // Phase D view absent (or shape drift): the queue is real but unreadable
    // from the seam today. Null, not zero — the UI says "arrives with Phase D".
    return null;
  }
}
