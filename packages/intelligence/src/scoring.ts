import { stageOrder } from "@otn/resolution";

/**
 * M3.2 — deterministic routing + scoring (spec §12). Pure functions: a
 * project's stored features in, per-account route + component scores out.
 * Final scores are arithmetic over stored components — model prose never
 * sets a score (spec §13).
 */
export const SCORING_ALGORITHM_VERSION = "1.0.0";

/** Aggregated, stored facts about a project — no inference beyond keywords. */
export interface ProjectFeatures {
  projectId: string;
  county: string;
  permittingJurisdiction: string;
  city: string | null;
  stage: string;
  /** Lowercased concatenation of titles/descriptions/types from records. */
  text: string;
  maxUnits: number | null;
  maxValuation: number | null;
  clusterSize: number;
  hasVelocitySignal: boolean;
  orgs: { name: string; role: string | null }[];
  aGradeEvidence: number;
  lastMaterialChangeAt: Date | null;
}

export interface RouteResult {
  accountKey: string;
  route: string;
  components: Record<string, number>;
  score: number;
  state: "priority_review" | "weekly_digest" | "archive";
  signals: string[];
}

// ── Deterministic classifications (keyword/threshold based) ──────────────────

const RE = {
  sfr: /\b(single family|sfr|townho|dwelling unit|detached dwelling|mobile home|manufactured home)\b/,
  multifamily: /\b(apartment|multifamily|multi-family|mixed-?use|live\/work)\b/,
  commercial:
    /\b(commercial|retail|office|warehouse|industrial|institutional|school|church|hotel|restaurant|storefront|clinic|hospital)\b/,
  tenantImprovement: /\b(tenant|t\.i\.|interior (remodel|alteration|improvement))\b/,
  glazing: /\b(glazing|curtain ?wall|storefront|window|glass|skylight|mirror|shower door)\b/,
  interior: /\b(drywall|gypsum|paint|interior|partition|ceiling)\b/,
  /** Work that mentions interiors but is not an interior-finishes package. */
  notInteriorTrade: /\b(re-?roof|fire (suppression|sprinkler|alarm)|hood suppression|mechanical only|plumbing only|electrical only|solar|antenna|cell tower)\b/,
  publicWork: /\b(school district|city of|county|wsdot|public works|port of|fire district)\b/,
  subdivision: /\b(plat|subdivision|lots?)\b/,
} as const;

export function classify(f: ProjectFeatures) {
  const units = f.maxUnits ?? 0;
  const isSfr = RE.sfr.test(f.text);
  const isMultifamily = RE.multifamily.test(f.text) || units >= 3;
  const lowRiseMultifamily = isMultifamily && (f.maxUnits === null || units <= 30);
  return {
    isSfr,
    isMultifamily,
    lowRiseMultifamily,
    isCommercial: RE.commercial.test(f.text),
    isTi: RE.tenantImprovement.test(f.text),
    hasGlazing: RE.glazing.test(f.text),
    hasInterior: RE.interior.test(f.text),
    isNonInteriorTrade: RE.notInteriorTrade.test(f.text),
    isPublicWork: RE.publicWork.test(f.text),
    isSubdivision: RE.subdivision.test(f.text) || f.clusterSize >= 3,
    isCluster: f.clusterSize >= 3 || f.hasVelocitySignal,
  };
}

function orgIdentified(f: ProjectFeatures, roles: string[]): number {
  const hits = f.orgs.filter((o) => o.role && roles.includes(o.role));
  if (hits.length === 0) return 0;
  // A legal-entity name is a stronger identification than a person name.
  return hits.some((o) => /\b(LLC|INC|CORP|COMPANY|LP|LLP|PLLC|LTD)\b/i.test(o.name)) ? 1 : 0.5;
}

function evidenceQuality(f: ProjectFeatures): number {
  return f.aGradeEvidence > 0 ? 1 : 0;
}

function inCounties(f: ProjectFeatures, included: string[], excluded: string[]): boolean {
  return included.includes(f.county) && !excluded.includes(f.county);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function weighted(
  components: Record<string, number>,
  weights: Record<string, number>,
): number {
  let score = 0;
  for (const [k, w] of Object.entries(weights)) score += (components[k] ?? 0) * w;
  return Math.round(score * 10) / 10;
}

function band(
  score: number,
  delivery: { priority_review_min?: number; weekly_digest_min?: number },
): RouteResult["state"] {
  if (score >= (delivery.priority_review_min ?? 80)) return "priority_review";
  if (score >= (delivery.weekly_digest_min ?? 65)) return "weekly_digest";
  return "archive";
}

export interface AccountScoringInput {
  key: string;
  territory: { counties_included?: string[]; counties_excluded?: string[] };
  weights: Record<string, number>;
  delivery: { priority_review_min?: number; weekly_digest_min?: number };
}

/** Timing curves differ per trade: glass installs late; entitlement is early radar. */
function timingResidentialGlass(stage: string): number {
  const map: Record<string, number> = {
    approved: 1, construction_documents: 1, permit_applied: 1, permit_issued: 0.9,
    construction: 0.7, near_final: 0.6, entitlement: 0.5, preapplication: 0.3,
    concept: 0.2, bidding_confirmed: 1,
  };
  return map[stage] ?? 0.1;
}

function timingInterior(stage: string): number {
  const map: Record<string, number> = {
    permit_issued: 1, construction: 1, bidding_confirmed: 1, permit_applied: 0.7,
    approved: 0.6, construction_documents: 0.6, near_final: 0.5, entitlement: 0.4,
    preapplication: 0.2, concept: 0.2,
  };
  return map[stage] ?? 0.1;
}

/**
 * Spec §15: a record must be active/current for the relevant trade timing.
 * Signals older than 60 days decay; older than 180 days are radar-only.
 */
function recencyFactor(lastMaterialChangeAt: Date | null, now: Date): number {
  if (!lastMaterialChangeAt) return 0.5;
  const days = (now.getTime() - lastMaterialChangeAt.getTime()) / 86_400_000;
  if (days <= 60) return 1;
  if (days <= 180) return 0.6;
  return 0.3;
}

/** Route one project for the Lacey Glass at Home profile (spec §12.1). */
export function routeAtHome(
  f: ProjectFeatures,
  acct: AccountScoringInput,
  now: Date = new Date(),
): RouteResult | null {
  const included = acct.territory.counties_included ?? [];
  const excluded = acct.territory.counties_excluded ?? [];
  if (!inCounties(f, included, excluded)) return null;
  const c = classify(f);
  const residentialFit = c.isSfr || c.isSubdivision || c.isCluster;
  if (!residentialFit && !c.lowRiseMultifamily) return null;

  const signals: string[] = [];
  if (c.isSubdivision) signals.push("subdivision");
  if (c.isCluster) signals.push("clustered_sfr_townhome_permits");
  if (c.lowRiseMultifamily) signals.push("low_rise_multifamily_joint_review");
  if (c.hasGlazing) signals.push("glass_product_keywords");
  if (stageOrder(f.stage) >= stageOrder("construction")) signals.push("late_stage_shower_mirror");

  const components = {
    product_fit: clamp01(
      (residentialFit ? 0.7 : 0.4) + (c.hasGlazing ? 0.3 : 0) + (c.lowRiseMultifamily ? 0.1 : 0),
    ),
    repeatable_units_or_builder_value:
      f.clusterSize >= 5 || (f.maxUnits ?? 0) >= 10
        ? 1
        : f.clusterSize >= 3 || (f.maxUnits ?? 0) >= 4
          ? 0.6
          : 0.2,
    timing: timingResidentialGlass(f.stage) * recencyFactor(f.lastMaterialChangeAt, now),
    territory: 1,
    builder_developer_identified: orgIdentified(f, [
      "applicant", "owner", "proponent", "primary_contractor",
    ]),
    evidence_quality: evidenceQuality(f),
  };
  const score = weighted(components, acct.weights);
  return {
    accountKey: acct.key,
    route: c.lowRiseMultifamily && !residentialFit ? "joint_review" : "residential_glass",
    components,
    score,
    state: band(score, acct.delivery),
    signals,
  };
}

/** Route one project for the Lacey Glass Commercial profile (spec §12.2). */
export function routeCommercial(
  f: ProjectFeatures,
  acct: AccountScoringInput,
  now: Date = new Date(),
): RouteResult | null {
  const included = acct.territory.counties_included ?? [];
  const excluded = acct.territory.counties_excluded ?? [];
  if (!inCounties(f, included, excluded)) return null;
  const c = classify(f);
  const fits = c.isCommercial || c.isMultifamily || c.isPublicWork || c.hasGlazing;
  if (!fits) return null;

  const signals: string[] = [];
  if (c.hasGlazing) signals.push("division_08_keywords");
  if (c.isPublicWork) signals.push("public_work");
  if (c.isMultifamily) signals.push("multifamily");
  if (f.county === "King") signals.push("king_routes_commercial");

  const components = {
    division_08_system_fit: c.hasGlazing ? 1 : c.isCommercial ? 0.7 : c.isMultifamily ? 0.4 : 0.2,
    scale_value:
      (f.maxValuation ?? 0) >= 1_000_000 || (f.maxUnits ?? 0) >= 20
        ? 1
        : (f.maxValuation ?? 0) >= 250_000 || (f.maxUnits ?? 0) >= 5
          ? 0.6
          : f.maxValuation === null
            ? 0.3
            : 0.15,
    timing: timingResidentialGlass(f.stage) * recencyFactor(f.lastMaterialChangeAt, now),
    geography: 1,
    gc_developer_architect_known: orgIdentified(f, [
      "applicant", "owner", "primary_contractor", "proponent", "lead_agency",
    ]),
    evidence_quality: evidenceQuality(f),
  };
  const score = weighted(components, acct.weights);
  return {
    accountKey: acct.key,
    route: c.lowRiseMultifamily ? "joint_review" : "division_08",
    components,
    score,
    state: band(score, acct.delivery),
    signals,
  };
}

/** Route one project for the Solis Interiors profile (spec §12.3, provisional). */
export function routeSolis(
  f: ProjectFeatures,
  acct: AccountScoringInput,
  now: Date = new Date(),
): RouteResult | null {
  const included = acct.territory.counties_included ?? [];
  const excluded = acct.territory.counties_excluded ?? [];
  if (!inCounties(f, included, excluded)) return null;
  const c = classify(f);
  const fits = c.isTi || c.isCommercial || c.isMultifamily || c.hasInterior;
  if (!fits) return null;

  const overCapacity = (f.maxValuation ?? 0) > 2_000_000 && c.isMultifamily;
  const signals: string[] = [];
  if (c.isTi) signals.push("tenant_improvement");
  if (c.hasInterior) signals.push("drywall_painting_keywords");
  if (overCapacity) signals.push("gc_relationship_radar");

  const components = {
    // Priority-band trade fit needs BOTH an explicit TI signal and interior
    // vocabulary; either alone is digest-grade. Keeps the review queue usable
    // while Solis's scope is provisional (spec §12.3).
    trade_fit: c.isNonInteriorTrade
      ? 0.2
      : c.isTi && c.hasInterior
        ? 1
        : c.isTi || c.hasInterior
          ? 0.8
          : c.isCommercial
            ? 0.6
            : 0.5,
    package_size_fit:
      f.maxValuation === null
        ? 0.4 // unknown package size is never priority evidence
        : f.maxValuation >= 50_000 && f.maxValuation <= 2_000_000
          ? 1
          : 0.3,
    timing: timingInterior(f.stage) * recencyFactor(f.lastMaterialChangeAt, now),
    geography: 1,
    evidence_quality: evidenceQuality(f),
  };
  const score = weighted(components, acct.weights);
  return {
    accountKey: acct.key,
    route: overCapacity ? "gc_relationship_radar" : "interior_trades",
    components,
    score,
    state: band(score, acct.delivery),
    signals,
  };
}

const ROUTERS: Record<
  string,
  (f: ProjectFeatures, acct: AccountScoringInput, now?: Date) => RouteResult | null
> = {
  lacey_glass_at_home: routeAtHome,
  lacey_glass_commercial: routeCommercial,
  solis_interiors: routeSolis,
};

/** Route a project against every active account. */
export function routeProject(
  f: ProjectFeatures,
  accounts: AccountScoringInput[],
  // Injectable clock so frozen eval examples score identically forever.
  now: Date = new Date(),
): RouteResult[] {
  const out: RouteResult[] = [];
  for (const acct of accounts) {
    const router = ROUTERS[acct.key];
    if (!router) continue;
    const result = router(f, acct, now);
    if (result) out.push(result);
  }
  return out;
}
