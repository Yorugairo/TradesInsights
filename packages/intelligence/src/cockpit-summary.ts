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
  /** The largest pattern-shaped clusters — review-per-pattern, not per-row. */
  clusters: ReviewCluster[];
}

export interface CockpitRegistryReview {
  total: number;
  byRule: { ruleKey: string; count: number }[];
}

export interface CockpitFamilies {
  /** Derived families (entities under one L&I principal). */
  count: number;
  /** Principal↔person pairs that would ADD a company to a family (not already bound). */
  pairsNew: number;
  /** Of those, the corroborated ones (verdict strong | corroborated). */
  pairsStrong: number;
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
): Promise<QueueSummary> {
  const [resolutionReview, registryReview, lanes] = await Promise.all([
    resolutionReviewSummary(db),
    registryReviewSummary(db),
    laneSummary(db),
  ]);

  // Both need the seam. Compute in parallel only when the pool exists —
  // otherwise both stay null (a real "seam offline" state, not zero).
  const [families, googlePlace] = registryPool
    ? await Promise.all([familiesSummary(db, registryPool), googlePlaceSummary(registryPool)])
    : [null, null];

  return { resolutionReview, registryReview, families, googlePlace, lanes };
}

/** Canonical resolution-review count: the triage clusters, summed. */
async function resolutionReviewSummary(db: Db): Promise<CockpitResolutionReview> {
  const clusters = await triageReviewQueue(db); // ordered by count DESC
  const total = clusters.reduce((sum, c) => sum + c.count, 0);
  return { total, clusters: clusters.slice(0, 5) };
}

/** Canonical registry-review count: pending observations grouped by rule. */
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
  return { total, byRule };
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
