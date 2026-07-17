import { stageOrder } from "@otn/resolution";

/**
 * M3.2 — deterministic routing + scoring (spec §12). Pure functions: a
 * project's stored features in, per-account route + component scores out.
 * Final scores are arithmetic over stored components — model prose never
 * sets a score (spec §13).
 */
// 1.5.0 — Solis package_size_fit: removed the $50k lower floor (Solis takes
// small jobs; no minimum job size by default). Only oversize work scores down.
// 1.6.0 — Solis: King-county jobs under $10k are digest-band, not priority
// (valid but lower — a distant secondary market; home counties unaffected).
export const SCORING_ALGORITHM_VERSION = "1.6.0";

/** Aggregated, stored facts about a project — no inference beyond keywords. */
export interface ProjectFeatures {
  projectId: string;
  county: string;
  permittingJurisdiction: string;
  city: string | null;
  stage: string;
  /** Lowercased concatenation of titles/descriptions/types from records. */
  text: string;
  /**
   * Per-source-record lowercased texts. When present, scope classification runs
   * PER RECORD and aggregates — so a glazing keyword in a demolition record no
   * longer inherits a sibling record's construction scope (the campus-cluster
   * false positive). Absent (e.g. frozen eval examples) → the whole `text` blob
   * is treated as one record, i.e. exactly the prior behavior.
   */
  records?: string[];
  maxUnits: number | null;
  maxValuation: number | null;
  clusterSize: number;
  hasVelocitySignal: boolean;
  /**
   * Derived active-campus membership ('<county>:<block>'; #1). A campus is a
   * commercial/institutional site with many DISTINCT-named permits on one
   * parcel block — deliberately NOT folded into hasVelocitySignal, which
   * feeds the residential cluster concept (routeAtHome's residentialFit).
   * Absent on frozen eval examples → prior behavior, gates hold unchanged.
   */
  campusBlock?: string | null;
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
  notInteriorTrade:
    /\b(re-?roof|fire (suppression|sprinkler|alarm)|hood suppression|mechanical (only|replacement)|boiler|furnace|heat pump|freezer|condenser|ductless|rooftop unit|water heater|plumbing only|electrical only|solar|antenna|cell tower)\b/,
  publicWork: /\b(school district|city of|county|wsdot|public works|port of|fire district)\b/,
  subdivision: /\b(plat|subdivision|lots?)\b/,
  /** Outdoor field/site scope with no building envelope (M3.8 turf-field finding). */
  fieldWork: /\b(synthetic turf|athletic field|ball ?fields?|playground|sports? court|track resurfac\w*)\b/,
  /** Demolition/removal scope — nothing to glaze (S6 SpaceX-demo finding). */
  demolition: /\b(demolition|demolish|\bdemo\b|wrecking|tear-?down|razing)\b/,
  /** New-work intent where glazing actually applies; distinguishes a demo+rebuild
   * (real glazing) from a bare demolition (no glazing). */
  buildingScope: /\b(new construction|construct|addition|alter(ation)?|tenant improvement|\bt\.?i\.?\b|remodel|build-?out|install|new building)\b/,
  /** A bare entitlement action (no construction scope yet) — early radar, not a
   * priority glazing bid (S6 SpaceX-CUP finding). */
  entitlementOnly: /\b(conditional use permit|\bcup\b|rezone|zoning variance|\bvariance\b|comprehensive plan amendment|shoreline (substantial|conditional))\b/,
  /** The record disclaims exterior/envelope work — so a glazing noun in it (a
   * "window" referenced as a duct penetration point) is not glazing scope.
   * High-precision negative: real glazing IS exterior work (SpaceX HVAC finding). */
  noEnvelope: /\bno (?:change|work|alteration|modification)s? to (?:the )?exterior\b|no exterior (?:change|work|alteration)/,
  /** "73 single-family lots", "24 lot townhome", "65-unit apartment" — deterministic text parse. */
  lotCount:
    /(\d{1,4})[- ](?:(?:single|multi)[- ]?family |townho\w+ |residential |detached |apartment )?(?:lots?\b|units?\b|dwellings?\b|homes?\b)/g,
} as const;

/** Largest lot/unit count stated in stored text; null when none stated. */
export function derivedUnitsFromText(text: string): number | null {
  let max: number | null = null;
  for (const m of text.matchAll(RE.lotCount)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && n <= 5000 && (max === null || n > max)) max = n;
  }
  return max;
}

/**
 * Division-08 glazing fit for a single record's text (the §12.2 ladder). Kept as
 * a per-record function so a demolition/entitlement record cannot borrow a
 * sibling record's construction scope. Aggregated by max across a project's
 * records (the strongest genuine glazing scope wins).
 */
function segmentDiv08Fit(seg: string, units: number): number {
  // A glazing noun does not indicate glazing scope in a record that disclaims
  // exterior/envelope work.
  const glaz = RE.glazing.test(seg) && !RE.noEnvelope.test(seg);
  const build = RE.buildingScope.test(seg);
  if ((RE.demolition.test(seg) && !build) || (RE.fieldWork.test(seg) && !glaz)) return 0.2;
  if (RE.entitlementOnly.test(seg) && !build) return 0.4;
  if (glaz) return 1;
  if (RE.commercial.test(seg)) return 0.7;
  if (RE.multifamily.test(seg) || units >= 3) return 0.4;
  return 0.2;
}

/** A record where a glazing keyword genuinely co-occurs with buildable scope
 * (not a bare demolition or field-only record). Drives the honest
 * `division_08_keywords` signal. */
function segmentHasGlazingScope(seg: string): boolean {
  return (
    RE.glazing.test(seg) &&
    !RE.noEnvelope.test(seg) &&
    !(RE.demolition.test(seg) && !RE.buildingScope.test(seg)) &&
    !(RE.fieldWork.test(seg) && !RE.glazing.test(seg))
  );
}

export function classify(f: ProjectFeatures) {
  const units = f.maxUnits ?? 0;
  // Per-record segments when available; else the whole blob is one segment
  // (frozen eval examples → byte-identical prior behavior).
  const segments = f.records && f.records.length > 0 ? f.records : [f.text];
  const isSfr = RE.sfr.test(f.text);
  const isMultifamily = RE.multifamily.test(f.text) || units >= 3;
  const lowRiseMultifamily = isMultifamily && (f.maxUnits === null || units <= 30);
  // Repeatable-units evidence: parsed units field OR a lot/unit count stated
  // in the stored text ("73 single-family lots"). Deterministic parse, not a
  // guess — null stays null when nothing is stated.
  const derivedUnits = derivedUnitsFromText(f.text);
  const effectiveUnits = Math.max(units, derivedUnits ?? 0);
  return {
    isSfr,
    effectiveUnits,
    isFieldWork: RE.fieldWork.test(f.text),
    isDemolition: RE.demolition.test(f.text),
    hasBuildingScope: RE.buildingScope.test(f.text),
    isEntitlementOnly: RE.entitlementOnly.test(f.text),
    // Per-record Division-08 fit (max across records) + honest glazing signal.
    division08Fit: Math.max(...segments.map((s) => segmentDiv08Fit(s, units))),
    hasGlazingScope: segments.some(segmentHasGlazingScope),
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
  // Unknown stage is unknown, not dead: several sources (SEPA, project pages)
  // publish no mappable stage. A 0.1 there was an implicit worst-case guess.
  return map[stage] ?? (stage === "unknown" ? 0.5 : 0.1);
}

function timingInterior(stage: string): number {
  const map: Record<string, number> = {
    permit_issued: 1, construction: 1, bidding_confirmed: 1, permit_applied: 0.7,
    approved: 0.6, construction_documents: 0.6, near_final: 0.5, entitlement: 0.4,
    preapplication: 0.2, concept: 0.2,
  };
  return map[stage] ?? (stage === "unknown" ? 0.5 : 0.1);
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

/**
 * Residential glass installs months AFTER the permit: windows/doors go in
 * mid-construction, showers/mirrors near finish (§12.1 "late-stage shower/
 * mirror opportunities"). A permit issued 4 months ago is prime window, not
 * stale — the generic 60-day decay was mis-timed for this trade.
 */
function recencyResidentialGlass(lastMaterialChangeAt: Date | null, now: Date): number {
  if (!lastMaterialChangeAt) return 0.5;
  const days = (now.getTime() - lastMaterialChangeAt.getTime()) / 86_400_000;
  if (days <= 180) return 1;
  if (days <= 365) return 0.6;
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
      f.clusterSize >= 5 || c.effectiveUnits >= 10
        ? 1
        : f.clusterSize >= 3 || c.effectiveUnits >= 4
          ? 0.6
          : 0.2,
    timing: timingResidentialGlass(f.stage) * recencyResidentialGlass(f.lastMaterialChangeAt, now),
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

  // Active-campus membership (#1): many distinct permits on one parcel block
  // means repeat commercial work at a single site — one relationship, many
  // packages. Deterministic floor on scale_value, never a fabricated valuation.
  const inCampus = Boolean(f.campusBlock);
  const signals: string[] = [];
  if (c.hasGlazingScope) signals.push("division_08_keywords");
  if (c.isPublicWork) signals.push("public_work");
  if (c.isMultifamily) signals.push("multifamily");
  if (inCampus) signals.push("active_campus");
  if (f.county === "King") signals.push("king_routes_commercial");

  const components = {
    // Per-record Division-08 fit (§12.2): the demolition/field/entitlement
    // negative filters are evaluated on each record's own text and aggregated by
    // max, so a glazing keyword in a demolition record cannot borrow a sibling
    // record's construction scope (M3.8 turf field; S6 SpaceX campus cluster).
    division_08_system_fit: c.division08Fit,
    scale_value: Math.max(
      (f.maxValuation ?? 0) >= 1_000_000 || c.effectiveUnits >= 20
        ? 1
        : (f.maxValuation ?? 0) >= 250_000 || c.effectiveUnits >= 5
          ? 0.6
          : f.maxValuation === null
            ? 0.3
            : 0.15,
      // A member of an active campus carries at least mid-scale value even when
      // its own permit is small — the site aggregates many packages (#1).
      inCampus ? 0.6 : 0,
    ),
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
  // Signal-only while Solis's profile is provisional (§12.3) — visible in the
  // rationale/digest but score-neutral until customer calibration.
  if (f.campusBlock) signals.push("active_campus");
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
    // No minimum job size by default — Solis takes small jobs, so a small
    // package is a full fit, not a penalty. Only OVERSIZE work (a different
    // sales motion / over capacity) scores down. A floor is added only if
    // Solis asks for one at calibration (§12.3).
    // Exception (2026-07-17 calibration): in KING county — a distant secondary
    // market — jobs under $10k are "valid but lower" (digest band, not
    // priority). Home counties (Thurston/Lewis/Pierce) keep small jobs at full
    // fit; this narrow rule only de-prioritizes tiny far-market work.
    package_size_fit:
      f.maxValuation === null
        ? 0.4 // unknown package size is never priority evidence
        : f.county === "King" && f.maxValuation < 10_000
          ? 0.3
          : f.maxValuation <= 2_000_000
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
