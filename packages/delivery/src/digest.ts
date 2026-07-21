import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import {
  bidTrackFor,
  classify,
  decideInclusion,
  evaluateGate,
  latestBrief,
  latestExtraction,
  latestOutreach,
  latestVerification,
  relationshipTargets,
  suppressedProjectIds,
  tradeBidWindows,
  type BidWindowStatus,
  type GateResult,
  type InclusionDecision,
  type InteriorTrade,
  type ProjectFeatures,
} from "@otn/intelligence";

/**
 * Weekly digest (spec §18). Only opportunities that pass the full §15
 * publication gate may enter a digest; everything else is counted and
 * disclosed in the coverage/caveat section, never silently dropped. "New" is
 * a delivery-history fact, not a scoring fact: an opportunity is new only on
 * its first-ever inclusion for that account — an unchanged repeated project
 * is never labeled new (spec §18).
 */

export interface DigestItem {
  opportunityId: string;
  /** M4.3/M4.4 — auto items enter customer sections; review_required items
   * are withheld into the reviewQueue (count disclosed in section 5). */
  inclusion: InclusionDecision;
  projectId: string;
  projectName: string;
  stage: string;
  county: string;
  jurisdiction: string;
  score: number | null;
  route: string | null;
  isNew: boolean;
  /** Verified narrative brief (model prose over the memo), or null when none
   * has been generated. Every sentence traces to a verified fact/inference;
   * it never sets the score or a bid state. A one-line lead for the busy
   * owner — the structured fields below stay the audit trail. */
  brief: string | null;
  /** WS-E — a grounded, pre-drafted intro message the estimator can copy and
   * send to the GC. Composed from the same verified memo menu as the brief;
   * every claim traces to a cited fact. Null when none has been generated. It
   * is a draft only — the system never sends it. */
  outreachDraft: string | null;
  whatChanged: string;
  whyItFits: string;
  /** Verified facts as (path, value) pairs — render humanizes; the model keeps
   * the raw audit form so nothing is lost between the email and the record. */
  confirmedFacts: { path: string; value: unknown }[];
  inferences: string[];
  missingCriticalFacts: string[];
  /** Per-trade bid-window inferences (docs/domain-bid-timing.md; drywall then
   * paint) — only attached on interior-trades routes; display-only, never
   * sets bidding_confirmed. Empty for other routes. */
  bidWindows: { trade: InteriorTrade; status: BidWindowStatus; note: string }[];
  nextAction: string;
  sourceLinks: { url: string; label: string }[];
  /** M3.8 — when a project's sources report different unit counts, every
   * competing value is surfaced with its own citation; the brief never picks
   * one silently (that would fabricate certainty). Null when sources agree or
   * only one states a count. */
  unitCountDisagreement: { units: number; sources: { url: string; label: string }[] }[] | null;
  /** #1 — active-campus context: this project is one of `projectCount` on one
   * parcel block (derived campus_block). Null when not in an active campus. */
  campus: { block: string; projectCount: number } | null;
  /** P2.1 — deterministic "winnable now" cut (stage/age/valuation/GC/radius). */
  easyWin: boolean;
  /** WS-B — the project's general contractor (strongest role: primary_contractor
   * > applicant > owner) with its verified flag and global public-business phone,
   * so the owner sees "who to call". Null when the project has no such org. */
  generalContractor: { name: string; verified: boolean; phone: string | null } | null;
  eventIds: string[];
}

/** P2.2 — "GC worth meeting" digest entry (from the P1 target generator). */
export interface RelationshipPlay {
  organizationId: string;
  name: string;
  relevantProjects: number;
  counties: string[];
  statedValuationTotal: number | null;
  /** WS-B — verified registry binding drives the "✓ verified" badge; the global
   * public-business phone is the "who to call". Null phone/rating = not adopted. */
  verified: boolean;
  phone: string | null;
  rating: number | null;
}

/** P2.2 — upcoming bid-invitation deadline (the account's own private inbox). */
export interface DeadlineItem {
  title: string | null;
  generalContractor: string | null;
  /** WS-B — the GC's global public-business phone + verified flag, when the GC
   * org resolves and carries an adopted contact. Null/false otherwise. */
  generalContractorPhone: string | null;
  generalContractorVerified: boolean;
  bidDueAt: string;
  scope: string | null;
}

export interface CoverageCaveat {
  sourceKey: string;
  sourceName: string;
  freshnessState: string;
}

export interface DigestModel {
  accountProfileId: string;
  accountKey: string;
  accountName: string;
  periodStart: Date;
  periodEnd: Date;
  sections: {
    priorityNew: DigestItem[];
    stageChanges: DigestItem[];
    missingFacts: DigestItem[];
    monitoring: DigestItem[];
    coverage: CoverageCaveat[];
  };
  /** P2.2 — the 10-minute top block (caps enforced at assembly): */
  easyWins: DigestItem[]; // ≤3 — gate-passing auto items meeting the easy-win cut
  relationshipPlays: RelationshipPlay[]; // ≤2 — active relevant orgs, no relationship yet
  deadlines: DeadlineItem[]; // upcoming bid-invitation dues (private inbox)
  radar: DigestItem[]; // ≤2 — gate-passing early-stage (pre-app/entitlement)
  /** Gate-passing items withheld from automation for a human decision. */
  reviewQueue: DigestItem[];
  suppressed: { gateFailed: number; blockedOnVerifier: number; customerSuppressed: number };
  ruleVersions: Record<string, number>;
  candidateCount: number;
}

export interface CandidateRow {
  id: string;
  project_id: string;
  canonical_name: string;
  county: string;
  permitting_jurisdiction: string;
  current_stage: string;
  current_score: number | null;
  route: string | null;
  state: string;
  rationale_json: { signals?: string[]; route?: string } | null;
  text: string;
  max_valuation: number | null;
  /** Latest stated permit issue date among active records (null when unstated). */
  latest_issue_date: string | null;
  campus_block: string | null;
  last_material_change_at: string | null;
  has_org: boolean;
  dist_m: number | null;
}

/** P2.1 easy-win config (delivery_config_json.easy_win; provisional pre-calibration). */
export interface EasyWinConfig {
  home_lon: number | null;
  home_lat: number | null;
  radius_km: number;
  /** Owner 2026-07-20 — concentric proximity bands in miles (nearest-first).
   * When present, the OUTER band is the geo cutoff and easy wins are ordered
   * nearest-band-first; null/absent falls back to the flat radius_km. */
  radius_bands_mi: number[] | null;
  max_age_days: number;
  min_valuation_usd: number | null;
  max_valuation_usd: number | null;
}

/** Meters per statute mile (owner 2026-07-20 easy-win bands are stated in miles). */
const MILE_M = 1609.34;

/**
 * Owner 2026-07-20 — proximity band index for a candidate distance (meters):
 * the index of the first band (miles, ascending) that covers the distance.
 * Null distance, or a distance beyond the outer band, sorts last. With no
 * bands configured every candidate shares index 0 → pure score order (the
 * pre-band behavior).
 */
export function easyWinBandIndex(distM: number | null, bandsMi: number[] | null): number {
  if (distM === null) return Number.MAX_SAFE_INTEGER;
  if (!bandsMi || bandsMi.length === 0) return 0;
  const miles = distM / MILE_M;
  const sorted = [...bandsMi].sort((a, b) => a - b);
  const idx = sorted.findIndex((b) => b >= miles);
  return idx === -1 ? sorted.length : idx;
}

async function loadCandidates(
  db: Db,
  accountProfileId: string,
  easyWin: EasyWinConfig | null,
): Promise<CandidateRow[]> {
  const home =
    easyWin && easyWin.home_lon !== null && easyWin.home_lat !== null
      ? sql`ST_DistanceSphere(ST_Centroid(p.geometry),
          ST_SetSRID(ST_MakePoint(${easyWin.home_lon}, ${easyWin.home_lat}), 4326))`
      : sql`NULL::float`;
  const res = await db.execute(sql`
    SELECT o.id, o.project_id, p.canonical_name, p.county, p.permitting_jurisdiction,
      p.current_stage, o.current_score, o.route, o.state, o.rationale_json, p.campus_block,
      o.last_material_change_at,
      COALESCE(rec.text, lower(p.canonical_name)) AS text, rec.max_valuation,
      rec.latest_issue_date,
      EXISTS (SELECT 1 FROM project_roles pr WHERE pr.project_id = p.id
        AND pr.role IN ('applicant', 'owner', 'primary_contractor', 'contractor')) AS has_org,
      ${home} AS dist_m
    FROM opportunities o JOIN projects p ON p.id = o.project_id
    LEFT JOIN LATERAL (
      SELECT lower(string_agg(concat_ws(' ',
          sr.normalized_json->>'title', left(sr.normalized_json->>'description', 800)), ' ')) AS text,
        max((sr.normalized_json->>'valuationUsd')::numeric)::float AS max_valuation,
        max(sr.normalized_json->>'issueDate') AS latest_issue_date
      FROM record_resolutions rr JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE rr.project_id = p.id AND rr.status = 'active'
    ) rec ON true
    WHERE o.account_profile_id = ${accountProfileId}
      AND o.state IN ('priority_review', 'weekly_digest', 'promoted')
    ORDER BY o.current_score DESC NULLS LAST
    LIMIT 500`);
  return res.rows as unknown as CandidateRow[];
}

/**
 * P2.1 — "winnable now": right stage recently, a named org to call, package
 * size inside the band, and (when home is configured) inside the service
 * radius. Missing geometry or an unconfigured home fails the geo check
 * honestly — an easy win you can't locate isn't easy.
 */
export function isEasyWin(c: CandidateRow, cfg: EasyWinConfig | null): boolean {
  if (!cfg) return false;
  if (!["permit_issued", "approved"].includes(c.current_stage)) return false;
  const lastAt = c.last_material_change_at ? new Date(c.last_material_change_at).getTime() : null;
  if (lastAt === null || Date.now() - lastAt > cfg.max_age_days * 86_400_000) return false;
  if (!c.has_org) return false;
  const v = c.max_valuation === null ? null : Number(c.max_valuation);
  if (cfg.min_valuation_usd !== null && (v === null || v < cfg.min_valuation_usd)) return false;
  if (cfg.max_valuation_usd !== null && v !== null && v > cfg.max_valuation_usd) return false;
  if (cfg.home_lon !== null && cfg.home_lat !== null) {
    // Owner 2026-07-20 — when concentric bands are configured the OUTER band is
    // the qualification cutoff; otherwise the flat radius_km applies (unchanged).
    const outerM =
      cfg.radius_bands_mi && cfg.radius_bands_mi.length
        ? Math.max(...cfg.radius_bands_mi) * MILE_M
        : cfg.radius_km * 1000;
    if (c.dist_m === null || Number(c.dist_m) > outerM) return false;
  }
  return true;
}

/** Early-stage radar (pre-app/entitlement/SEPA-era stages). */
const RADAR_STAGES = new Set(["concept", "preapplication", "entitlement"]);

/**
 * Upcoming bid-invitation deadlines from the account's own private inbox.
 * Deduped on (title, gc, due date, scope): a re-forwarded invitation carries a
 * fresh Message-ID, and when the project name doesn't resolve it becomes a new
 * bid_invitations row — the same deadline must still render once.
 */
async function upcomingDeadlines(db: Db, accountProfileId: string): Promise<DeadlineItem[]> {
  const res = await db.execute(sql`
    SELECT bi.bid_due_at, bi.scope_summary, o.canonical_name AS gc, im.subject AS title,
      (o.verified_at IS NOT NULL) AS gc_verified,
      (SELECT oc.phone FROM organization_contacts oc
         WHERE oc.organization_id = o.id
           AND oc.account_profile_id IS NULL
           AND oc.source_type = 'public_business'
           AND oc.phone IS NOT NULL
         ORDER BY oc.phone
         LIMIT 1) AS gc_phone
    FROM bid_invitations bi
    LEFT JOIN organizations o ON o.id = bi.gc_organization_id
    LEFT JOIN inbound_messages im ON im.id = bi.source_message_id
    WHERE bi.account_profile_id = ${accountProfileId}
      AND bi.bid_due_at IS NOT NULL AND bi.bid_due_at >= now()
    GROUP BY bi.bid_due_at, bi.scope_summary, o.canonical_name, im.subject,
      o.verified_at, o.id
    ORDER BY bi.bid_due_at ASC
    LIMIT 5`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    title: (r["title"] as string | null) ?? null,
    generalContractor: (r["gc"] as string | null) ?? null,
    generalContractorPhone: (r["gc_phone"] as string | null) ?? null,
    generalContractorVerified: Boolean(r["gc_verified"]),
    bidDueAt: r["bid_due_at"] as string,
    scope: (r["scope_summary"] as string | null) ?? null,
  }));
}

/** Opportunity IDs this account has ever been sent (any prior delivery). */
async function previouslyDelivered(db: Db, accountProfileId: string): Promise<Set<string>> {
  const res = await db.execute(sql`
    SELECT DISTINCT di.opportunity_id
    FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id
    WHERE d.account_profile_id = ${accountProfileId}`);
  return new Set((res.rows as { opportunity_id: string }[]).map((r) => r.opportunity_id));
}

async function materialEventsInPeriod(
  db: Db,
  projectId: string,
  start: Date,
  end: Date,
): Promise<{ id: string; eventType: string; at: string; resultingStage: string | null }[]> {
  const res = await db.execute(sql`
    SELECT id, event_type, COALESCE(event_date, observed_at) AS at, resulting_stage
    FROM project_events
    WHERE project_id = ${projectId} AND material_change = true
      AND COALESCE(event_date, observed_at) >= ${start.toISOString()}
      AND COALESCE(event_date, observed_at) < ${end.toISOString()}
    ORDER BY COALESCE(event_date, observed_at) DESC`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: r["id"] as string,
    eventType: r["event_type"] as string,
    at: r["at"] as string,
    resultingStage: (r["resulting_stage"] as string | null) ?? null,
  }));
}

/**
 * WS-B — the project's general contractor to surface on the opportunity: the
 * strongest-role org (primary_contractor > applicant > owner), its verified flag
 * (organizations.verified_at), and its GLOBAL public-business phone (account NULL,
 * source_type 'public_business' — L&I or, when absent, Google, per the adoption
 * loop). Read-only + deterministic (name tiebreak); the model never sets it.
 */
async function generalContractor(
  db: Db,
  projectId: string,
): Promise<{ name: string; verified: boolean; phone: string | null } | null> {
  const res = await db.execute(sql`
    SELECT o.canonical_name AS name,
      (o.verified_at IS NOT NULL) AS verified,
      (SELECT oc.phone FROM organization_contacts oc
         WHERE oc.organization_id = o.id
           AND oc.account_profile_id IS NULL
           AND oc.source_type = 'public_business'
           AND oc.phone IS NOT NULL
         ORDER BY oc.phone
         LIMIT 1) AS phone
    FROM project_roles pr
    JOIN organizations o ON o.id = pr.organization_id
    WHERE pr.project_id = ${projectId}
      AND pr.role IN ('primary_contractor', 'applicant', 'owner')
    ORDER BY CASE pr.role
        WHEN 'primary_contractor' THEN 1 WHEN 'applicant' THEN 2 ELSE 3 END,
      o.canonical_name
    LIMIT 1`);
  const row = res.rows[0] as { name: string; verified: boolean; phone: string | null } | undefined;
  if (!row) return null;
  return { name: row.name, verified: Boolean(row.verified), phone: row.phone ?? null };
}

async function sourceLinks(db: Db, projectId: string): Promise<{ url: string; label: string }[]> {
  const res = await db.execute(sql`
    SELECT DISTINCT ei.source_url, s.name
    FROM record_resolutions rr
    JOIN evidence_items ei ON ei.source_record_id = rr.source_record_id
    JOIN raw_artifacts ra ON ra.id = ei.raw_artifact_id
    JOIN sources s ON s.id = ra.source_id
    WHERE rr.project_id = ${projectId} AND rr.status = 'active'
    LIMIT 5`);
  return (res.rows as { source_url: string; name: string }[]).map((r) => ({
    url: r.source_url,
    label: r.name,
  }));
}

/**
 * Distinct non-null unit counts across a project's active resolved records,
 * each with the sources that state it. Deterministic — reads stored
 * `normalized_json`, no model. Returns null unless ≥2 records disagree.
 */
async function unitCountDisagreement(
  db: Db,
  projectId: string,
): Promise<{ units: number; sources: { url: string; label: string }[] }[] | null> {
  const res = await db.execute(sql`
    SELECT (sr.normalized_json->>'units')::int AS units,
      s.name AS label,
      sr.normalized_json->>'sourceUrl' AS url
    FROM record_resolutions rr
    JOIN source_records sr ON sr.id = rr.source_record_id
    JOIN sources s ON s.id = sr.source_id
    WHERE rr.project_id = ${projectId} AND rr.status = 'active'
      AND sr.normalized_json->>'units' IS NOT NULL
      AND (sr.normalized_json->>'units') ~ '^[0-9]+$'`);
  const rows = res.rows as { units: number; label: string; url: string | null }[];
  const byValue = new Map<number, { url: string; label: string }[]>();
  for (const r of rows) {
    const units = Number(r.units);
    if (!Number.isFinite(units)) continue;
    const cites = byValue.get(units) ?? [];
    // De-dupe identical (label,url) citations for the same value.
    if (!cites.some((c) => c.label === r.label && c.url === (r.url ?? ""))) {
      cites.push({ url: r.url ?? "", label: r.label });
    }
    byValue.set(units, cites);
  }
  if (byValue.size < 2) return null; // agreement (or a single count) is not a discrepancy
  return [...byValue.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([units, sources]) => ({ units, sources }));
}

function nextAction(item: { isNew: boolean; missing: string[]; state: string }): string {
  if (item.missing.length > 0) {
    // The "Still unknown" line lists WHAT is missing in plain words; this line
    // just says what to do about it.
    return "Confirm the unknowns above before reaching out.";
  }
  if (item.state === "priority_review" || item.state === "promoted") {
    return "Review the evidence and tap pursue or dismiss.";
  }
  return "Nothing to do yet — we're watching for changes.";
}

/** Plain-English "why it fits" — routes/signals are internals; the owner gets
 * one readable sentence. Unknown signals degrade to de-snake-cased words. */
const ROUTE_PHRASES: Record<string, string> = {
  interior_trades: "Matches your drywall + painting work",
  gc_relationship_radar: "Likely oversize for a direct bid — a GC-relationship play",
  residential_glass: "Matches your residential glass work",
  commercial_glazing: "Matches your commercial glazing work",
  division_08: "Matches your Division 08 scope",
  joint_review: "Mixed signals — worth a judgment call",
};
const SIGNAL_PHRASES: Record<string, string> = {
  tenant_improvement: "tenant-improvement scope",
  drywall_painting_keywords: "drywall/paint mentioned in the records",
  active_campus: "on an active multi-permit site",
  gc_relationship_radar: "GC relationship opportunity",
  division_08_keywords: "glazing scope in the records",
  glass_product_keywords: "glass products mentioned",
  public_work: "public-agency work",
  multifamily: "multifamily project",
  king_routes_commercial: "Seattle-area commercial",
  commercial_bid_window_likely_closed: "commercial buyout likely already done",
  new_home_construction: "new home construction — every home needs drywall + paint",
  production_builder_pipeline: "production builder pipeline — one relationship, many homes",
  subdivision: "part of a subdivision",
  clustered_sfr_townhome_permits: "part of a home-building cluster",
  low_rise_multifamily_joint_review: "low-rise multifamily",
  late_stage_shower_mirror: "late-stage finish work (showers/mirrors)",
};

function humanWhyItFits(route: string | null, signals: string[]): string {
  const base = route ? (ROUTE_PHRASES[route] ?? "Matched your routing rules") : "";
  const parts = signals
    .map((s) => SIGNAL_PHRASES[s] ?? s.replace(/_/g, " "))
    .filter((p, i, a) => a.indexOf(p) === i);
  if (base && parts.length > 0) return `${base} — ${parts.join(", ")}`;
  return base || (parts.length > 0 ? parts.join(", ") : "");
}

async function buildItem(
  db: Db,
  c: CandidateRow,
  opts: {
    isNew: boolean;
    periodStart: Date;
    periodEnd: Date;
    gate: GateResult;
    easyWinConfig: EasyWinConfig | null;
    accountProfileId: string;
  },
): Promise<DigestItem> {
  const [events, links, extraction, verification, unitDisagreement, campus, brief, outreach, gc] =
    await Promise.all([
      materialEventsInPeriod(db, c.project_id, opts.periodStart, opts.periodEnd),
      sourceLinks(db, c.project_id),
      latestExtraction(db, c.project_id),
      latestVerification(db, c.project_id),
      unitCountDisagreement(db, c.project_id),
      campusContext(db, c.campus_block),
      latestBrief(db, c.id, opts.accountProfileId, c.project_id),
      latestOutreach(db, c.id, opts.accountProfileId, c.project_id),
      generalContractor(db, c.project_id),
    ]);
  const inclusion = decideInclusion({
    gate: opts.gate,
    extraction: extraction?.extraction ?? null,
    verification: verification
      ? { status: verification.status, result: verification.result }
      : null,
    route: c.route,
    state: c.state,
    maxValuation: c.max_valuation === null ? null : Number(c.max_valuation),
    stage: c.current_stage,
    text: c.text ?? "",
  });
  const facts = extraction?.extraction.facts ?? [];
  const inferences = extraction?.extraction.inferences ?? [];
  const missing = extraction?.extraction.missingCriticalFacts ?? [];

  const whatChanged =
    events.length > 0
      ? events
          .map((e) => `${e.eventType}${e.resultingStage ? ` → ${e.resultingStage}` : ""} (${e.at.slice(0, 10)})`)
          .join("; ")
      : opts.isNew
        ? "first time in your digest"
        : "no change since your last digest";

  const signals = c.rationale_json?.signals ?? [];
  const whyItFits = humanWhyItFits(c.route, signals);

  // Per-trade bid-window inferences (drywall + paint) — interior-trades
  // routes only (glass sequencing differs). classify() runs on the stored
  // record text with honest nulls for unavailable aggregates.
  let bidWindows: DigestItem["bidWindows"] = [];
  if (c.route === "interior_trades" || c.route === "gc_relationship_radar") {
    const cls = classify({
      projectId: c.project_id,
      county: c.county,
      permittingJurisdiction: c.permitting_jurisdiction,
      city: null,
      stage: c.current_stage,
      text: c.text ?? "",
      maxUnits: null,
      maxValuation: c.max_valuation === null ? null : Number(c.max_valuation),
      clusterSize: 0,
      hasVelocitySignal: false,
      orgs: [],
      aGradeEvidence: 0,
      lastMaterialChangeAt: null,
    } satisfies ProjectFeatures);
    bidWindows = tradeBidWindows({
      stage: c.current_stage,
      track: bidTrackFor(cls),
      issuedAt: c.latest_issue_date ? new Date(c.latest_issue_date) : null,
    }).map((w) => ({ trade: w.trade, status: w.status, note: w.note }));
  }

  return {
    opportunityId: c.id,
    inclusion,
    projectId: c.project_id,
    projectName: c.canonical_name,
    stage: c.current_stage,
    county: c.county,
    jurisdiction: c.permitting_jurisdiction,
    score: c.current_score,
    route: c.route,
    isNew: opts.isNew,
    brief: brief?.narrative ?? null,
    outreachDraft: outreach?.message ?? null,
    whatChanged,
    whyItFits: whyItFits || "Matched your routing rules",
    confirmedFacts: facts.map((f) => ({ path: f.path, value: f.value })),
    inferences: inferences.map((i) => `[inference] ${i.type} = ${JSON.stringify(i.value)} (${i.reason})`),
    missingCriticalFacts: missing,
    bidWindows,
    nextAction: nextAction({ isNew: opts.isNew, missing, state: c.state }),
    sourceLinks: links,
    unitCountDisagreement: unitDisagreement,
    campus,
    // v1.7.0 consistency: a "⚡ Winnable now" item needs at least one trade
    // window that isn't likely-closed (empty windows = non-interior route,
    // where the cut applies unchanged).
    easyWin:
      isEasyWin(c, opts.easyWinConfig) &&
      (bidWindows.length === 0 || !bidWindows.every((w) => w.status === "likely_closed")),
    generalContractor: gc,
    eventIds: events.map((e) => e.id),
  };
}

/** #1 — sibling count for an active campus (derived campus_block). */
async function campusContext(
  db: Db,
  campusBlock: string | null,
): Promise<{ block: string; projectCount: number } | null> {
  if (!campusBlock) return null;
  const res = await db.execute(
    sql`SELECT count(*) AS n FROM projects WHERE campus_block = ${campusBlock}`,
  );
  const n = Number((res.rows[0] as { n: string } | undefined)?.n ?? 0);
  // The parcel block, without the internal county prefix, for display.
  const block = campusBlock.includes(":") ? campusBlock.split(":")[1]! : campusBlock;
  return { block, projectCount: n };
}

async function coverageCaveats(db: Db): Promise<CoverageCaveat[]> {
  const res = await db.execute(sql`
    SELECT s.key, s.name, ce.freshness_state
    FROM coverage_entries ce JOIN sources s ON s.id = ce.source_id
    WHERE ce.freshness_state != 'green' AND ce.status = 'enabled'
      AND s.access_class != 'fixture'
    ORDER BY s.key`);
  return (res.rows as { key: string; name: string; freshness_state: string }[]).map((r) => ({
    sourceKey: r.key,
    sourceName: r.name,
    freshnessState: r.freshness_state,
  }));
}

async function accountInfo(
  db: Db,
  accountProfileId: string,
): Promise<{
  key: string;
  name: string;
  ruleVersions: Record<string, number>;
  easyWin: EasyWinConfig | null;
}> {
  const res = await db.execute(
    sql`SELECT key, name, delivery_config_json FROM account_profiles WHERE id = ${accountProfileId}`,
  );
  const row = res.rows[0] as
    | { key: string; name: string; delivery_config_json: { easy_win?: EasyWinConfig } | null }
    | undefined;
  if (!row) throw new Error(`account ${accountProfileId} not found`);
  const easyWin = row.delivery_config_json?.easy_win ?? null;
  const rules = await db.execute(sql`
    SELECT rule_type, max(version) AS version FROM account_rules
    WHERE account_profile_id = ${accountProfileId} GROUP BY rule_type`);
  const ruleVersions: Record<string, number> = {};
  for (const r of rules.rows as { rule_type: string; version: number }[]) {
    ruleVersions[r.rule_type] = Number(r.version);
  }
  return { key: row.key, name: row.name, ruleVersions, easyWin };
}

export async function buildDigest(
  db: Db,
  accountProfileId: string,
  period: { start: Date; end: Date },
): Promise<DigestModel> {
  const account = await accountInfo(db, accountProfileId);
  const [candidates, delivered, coverage, suppressedProjects, deadlines, plays] =
    await Promise.all([
      loadCandidates(db, accountProfileId, account.easyWin),
      previouslyDelivered(db, accountProfileId),
      coverageCaveats(db),
      suppressedProjectIds(db, accountProfileId),
      upcomingDeadlines(db, accountProfileId),
      relationshipTargets(db, accountProfileId, { minRelevantProjects: 2, limit: 2 }),
    ]);

  const sections: DigestModel["sections"] = {
    priorityNew: [],
    stageChanges: [],
    missingFacts: [],
    monitoring: [],
    coverage,
  };
  const reviewQueue: DigestItem[] = [];
  // Owner 2026-07-20 — collect every qualifying easy win with its distance, then
  // select nearest-band-first AFTER the pass (score order alone no longer decides).
  const easyWinCandidates: { item: DigestItem; distM: number | null }[] = [];
  const radar: DigestItem[] = [];
  const suppressed = { gateFailed: 0, blockedOnVerifier: 0, customerSuppressed: 0 };

  for (const c of candidates) {
    // §9: suppression is applied BEFORE assembly — a suppressed project/org
    // never reaches gate evaluation or an item build.
    if (suppressedProjects.has(c.project_id)) {
      suppressed.customerSuppressed++;
      continue;
    }
    const gate: GateResult | null = await evaluateGate(db, c.id);
    if (!gate || gate.status !== "pass") {
      if (gate?.status === "blocked_on_verifier") suppressed.blockedOnVerifier++;
      else suppressed.gateFailed++;
      continue;
    }
    const isNew = !delivered.has(c.id);
    const item = await buildItem(db, c, {
      isNew,
      periodStart: period.start,
      periodEnd: period.end,
      gate,
      easyWinConfig: account.easyWin,
      accountProfileId,
    });

    // M4.3/M4.4 — controlled automation: only independently verified,
    // high-confidence, non-high-risk items enter customer sections; the rest
    // wait for a human (promote to include, dismiss to drop).
    if (item.inclusion.mode === "review_required") {
      reviewQueue.push(item);
      continue;
    }

    // P2.2 — the 10-minute top block (auto items only). Easy-win stages
    // (permit_issued/approved) and radar stages (concept/preapplication/
    // entitlement) are disjoint, so these two picks are independent. Easy wins
    // are gathered here and ordered nearest-band-first after the pass (owner
    // 2026-07-20); radar stays score-ordered and capped at 2.
    if (item.easyWin) {
      easyWinCandidates.push({ item, distM: c.dist_m === null ? null : Number(c.dist_m) });
    }
    if (RADAR_STAGES.has(c.current_stage) && radar.length < 2) radar.push(item);

    // Exclusive section order (spec §18): priority-new > stage change >
    // missing-fact queue > monitoring.
    if (isNew && (c.state === "priority_review" || c.state === "promoted")) {
      sections.priorityNew.push(item);
    } else if (item.eventIds.length > 0) {
      sections.stageChanges.push(item);
    } else if (item.missingCriticalFacts.length > 0) {
      sections.missingFacts.push(item);
    } else {
      sections.monitoring.push(item);
    }
  }

  // Owner 2026-07-20 — nearest-band-first easy wins: order by proximity band,
  // then score, then cap at 3, so the closest winnable jobs lead even when a
  // farther project scored a touch higher. With no bands configured every
  // candidate shares band 0 → pure score order (the pre-band behavior).
  const bandsMi = account.easyWin?.radius_bands_mi ?? null;
  const easyWins = easyWinCandidates
    .sort(
      (a, b) =>
        easyWinBandIndex(a.distM, bandsMi) - easyWinBandIndex(b.distM, bandsMi) ||
        (b.item.score ?? -Infinity) - (a.item.score ?? -Infinity),
    )
    .slice(0, 3)
    .map((e) => e.item);

  return {
    accountProfileId,
    accountKey: account.key,
    accountName: account.name,
    periodStart: period.start,
    periodEnd: period.end,
    sections,
    easyWins,
    relationshipPlays: plays.map((p) => ({
      organizationId: p.organizationId,
      name: p.name,
      relevantProjects: p.relevantProjects,
      counties: p.counties,
      statedValuationTotal: p.statedValuationTotal,
      verified: p.verified,
      phone: p.phone,
      rating: p.rating,
    })),
    deadlines,
    radar,
    reviewQueue,
    suppressed,
    ruleVersions: account.ruleVersions,
    candidateCount: candidates.length,
  };
}
