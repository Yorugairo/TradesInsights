import { stageOrder } from "@otn/resolution";
import { bidTrackFor, type BidTrack } from "./bid-window.js";

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
// 1.7.0 — Solis timing is bid-track-aware (docs/domain-bid-timing.md): an
// issued commercial-track project (buyout likely done) scores timing 0.5, and
// in-review commercial stages peak — the score now agrees with the 🔨 line.
// 1.8.0 — Solis routes residential NEW CONSTRUCTION in the home counties
// (Pierce/Lewis/Thurston; King deferred to calibration): every new home needs
// drywall + paint (trade_fit 0.7); clustered/subdivision new-builds route as
// ONE production-builder relationship play (gc_relationship_radar, 0.45),
// never per-house leads. Customer-approved 2026-07-17.
// 1.9.0 — four owner-directed, PROVISIONAL (§12.3) Solis-only tweaks
// (2026-07-20), all scoped to routeSolis so the Lacey Glass profiles stay
// byte-identical:
//   (1) geography TIERS — home metro Thurston 1.0 > Pierce/Lewis 0.9 >
//       other-in-territory 0.8 > distant King commercial 0.6 (was a flat 1.0).
//   (2) application-stage timing weighted ABOVE issued on the RESIDENTIAL
//       interior track (permit_applied 1.0, permit_issued 0.9) — earlier stage
//       buys lead time to get in before the GC locks its subs. The per-track
//       bid-window LINE (bid-window.ts) is unchanged and still reflects the
//       true clock.
//   (3) a SMALL (+3), clamped, additive warm-GC nudge when warm_gc_active
//       fires — relationship-first, and leaves every frozen eval example
//       (no warm set) byte-identical.
//   (4) layered easy-win proximity bands live in config/delivery, not here.
// 1.10.0 — Solis geography becomes a DISTANCE LADDER (owner directive
// 2026-07-23, still PROVISIONAL §12.3). Wave 3 put Snohomish/Kitsap/Clark/
// Spokane in the County enum, where they hit a flat 0.8 default — ABOVE King's
// calibrated 0.6 despite all being farther from Olympia, so a ~300-mile Spokane
// job outranked a ~60-mile Seattle job on geography. SOLIS_GEOGRAPHY_BANDS now
// grades by drive distance and the unknown-county default drops 0.8 → 0.3
// (unknown distance is not evidence of proximity). The four pilot counties keep
// their exact calibrated values, and the frozen eval set contains only those
// four — so this is eval byte-identical by construction.
// 1.12.0 — issued permits demoted hard on both tracks (owner 2026-07-26: an
// issued permit is mostly relationship-graph/job-history material, not a live
// bid) and a freshness gradient added INSIDE the application stage, which until
// now scored 496 Solis opportunities identically regardless of whether they were
// filed last week or last year. See timingInterior / appliedFreshness.
export const SCORING_ALGORITHM_VERSION = "1.12.0";

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
  orgs: {
    name: string;
    role: string | null;
    /** Canonical registry entity_id when the org is bound (null/absent otherwise). */
    registryRef?: string | null | undefined;
    /** True when the org carries a governed registry binding (strong-key or reviewed). */
    registryVerified?: boolean | undefined;
    /** WS-B — Google Business rating signal from the registry contract (cached on
     * the identity snapshot). Feeds the score-NEUTRAL `gc_quality` signal only;
     * absent on frozen eval examples → no signal, no score change. */
    googleRating?: number | null | undefined;
    googleReviewCount?: number | null | undefined;
    /** WS-B — the org's authoritative L&I trade codes (registry contract). Feeds
     * the score-NEUTRAL `trade_match` signal only; absent → no signal. */
    tradeCodes?: string[] | null | undefined;
  }[];
  aGradeEvidence: number;
  lastMaterialChangeAt: Date | null;
  /**
   * When the permit APPLICATION was filed — the earliest confirmed
   * `permit_applied` project event (same derivation as
   * migrations/0029_market_aggregates.sql). Drives `appliedFreshness`.
   *
   * Optional by design: absent on frozen eval examples, and `appliedFreshness`
   * returns 1 for a missing date, so the gates stay byte-identical. Absent is
   * "we don't know when this was filed", never "this is stale".
   */
  appliedAt?: Date | null;
  /** Phase 1 flywheel — derived corroboration (projects.corroboration).
   * Absent on frozen eval examples → no signal, no score change; feeds ONLY
   * the score-neutral corroborated_multi_source / lifecycle_progressing /
   * fact_contradiction signals appended AFTER each router computes its score
   * (§12.3 stays frozen by construction). */
  corroborationSourceCount?: number | null;
  corroborationStageDepth?: number | null;
  hasFactContradiction?: boolean;
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
  /**
   * SPECIALIST assemblies — the work that pays for a drive.
   *
   * `interior` above answers "is this a drywall job at all"; this answers "is it
   * the kind only a few crews can bid". The distinction is the point: a generic
   * Level 4 hang two counties away means driving past a dozen equivalent local
   * jobs, while a rated shaftwall or a data-centre assembly has no local
   * equivalent to pass up. Qualifying a drive by JOB TYPE beats de-rating a
   * county, which cannot tell those two cases apart.
   *
   * Terms are deliberately narrow — `\btype ?-?x\b` rather than `type x`, `stc`
   * only when followed by a rating — because a false positive claims specialist
   * work on an ordinary permit.
   */
  specialistAssembly: new RegExp(
    [
      // Data centre / industrial / controlled environments
      /data ?cent(er|re)|server room|clean ?room/,
      // Fire-rated assemblies
      /fire ?-?rated|fire ?stop|shaft ?wall|\btype ?-?[xc]\b|ul ?-?listed|\b\d ?-?hour rated\b/,
      // Acoustic / soundproofing
      /sound ?proof|acoustica?l|quiet ?rock|resilient channel|rock ?wool|mass ?-?loaded vinyl|\bstc[- ]?\d{2}\b/,
      // Light-gauge framing — the turnkey-package multiplier
      /metal stud|steel stud|light ?-?gauge/,
      // Level 5 and specialty finishes
      /\blevel ?-?5\b|\blevel ?five\b|smooth ?-?wall|skim ?coat|venetian plaster/,
    ]
      .map((r) => r.source)
      .join("|"),
  ),
  /** Restoration scope. Tracked mainly to MEASURE how little of it is permit-visible:
   * insurance patch work generally pulls no permit, so a low count here is the
   * expected finding rather than a broken matcher. */
  restorationWork:
    /\b(water damage|flood(ing|ed)?|burst pipe|freeze damage|mold remediation|smoke damage|restoration)\b/,
  /** Ordinary residential remodel cues — the CURRENT book for a smaller-ticket
   * finisher, kept separate from the specialist ladder so "where they are today"
   * never gets confused with "where they could go". */
  residentialRemodel:
    /\b(popcorn ceiling|basement finish|finished basement|re-?texture|knockdown texture|orange peel)\b/,
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
    // A specialist assembly IS interior work, whether or not the permit ever says
    // "drywall". A data-centre shaftwall reading "2-hour rated, shell and core",
    // or a luxury remodel reading "level 5 skim coat", contains no word in
    // RE.interior — so without this the specialist vocabulary could never fire on
    // exactly the records it was written to catch.
    hasInterior: RE.interior.test(f.text) || RE.specialistAssembly.test(f.text),
    isNonInteriorTrade: RE.notInteriorTrade.test(f.text),
    isPublicWork: RE.publicWork.test(f.text),
    isSubdivision: RE.subdivision.test(f.text) || f.clusterSize >= 3,
    isCluster: f.clusterSize >= 3 || f.hasVelocitySignal,
  };
}

function orgIdentified(f: ProjectFeatures, roles: string[]): number {
  const hits = f.orgs.filter((o) => o.role && roles.includes(o.role));
  if (hits.length === 0) return 0;
  // A registry-bound entity (an ALREADY-governed binding — strong-key or
  // human-reviewed; never auto-bound in the scorer) or a legal-entity name is a
  // full identification; a registry binding lifts even a bare person-name sole
  // proprietor to full. Purely additive over the prior name-only rule — orgs
  // with no `registryVerified` (e.g. frozen eval examples) score exactly as before.
  return hits.some(
    (o) => o.registryVerified || /\b(LLC|INC|CORP|COMPANY|LP|LLP|PLLC|LTD)\b/i.test(o.name),
  )
    ? 1
    : 0.5;
}

function evidenceQuality(f: ProjectFeatures): number {
  return f.aGradeEvidence > 0 ? 1 : 0;
}

/**
 * Solis geography fit as a DISTANCE gradient from the home metro (owner
 * directive 2026-07-23, PROVISIONAL §12.3). Solis Interiors works out of
 * Lacey/Olympia (Thurston); an interior-finishes crew's willingness to travel
 * falls off with drive time, so the band is a distance ladder — not a flat
 * in-territory/out flag.
 *
 * WHY THIS CHANGED: Wave 3 added Snohomish/Kitsap/Clark/Spokane to the County
 * enum. Until now they all fell through to a flat 0.8 default — HIGHER than
 * King's calibrated 0.6, even though every one of them is FARTHER from Olympia
 * than King is. That inverted the ranking (a ~300-mile Spokane job outscored a
 * ~60-mile Seattle job on geography). These bands remove the inversion.
 *
 * The four PILOT counties keep their calibrated values EXACTLY (Thurston 1.0,
 * Pierce/Lewis 0.9, King 0.6). The frozen eval set contains only those four
 * counties, so this change is eval byte-identical by construction; only the
 * Wave-3 counties and the unknown-county default move.
 *
 * Distances are approximate one-way drive from Olympia and are documented so a
 * calibration session can move a band with the reason visible.
 */
const SOLIS_GEOGRAPHY_BANDS: Record<string, number> = {
  Thurston: 1,     // home metro (Lacey/Olympia) — 0 mi
  Pierce: 0.9,     // adjacent north — ~30 mi
  Lewis: 0.9,      // adjacent south — ~30 mi
  King: 0.6,       // distant secondary (Seattle/Bellevue commercial) — ~60 mi
  Kitsap: 0.5,     // ~60 mi but across the Sound: ferry or Narrows detour
  Snohomish: 0.4,  // beyond the Seattle crossing — ~90-110 mi
  Clark: 0.3,      // far south — ~100 mi, effectively the Portland market
  Spokane: 0.15,   // cross-state — ~300 mi; corpus data, not a serviceable market
};

/** A county with no calibrated band is treated as FAR, not as a middling
 * default: unknown distance is not evidence of proximity. (This is the value
 * that used to be 0.8 and caused the inversion above.) */
const SOLIS_GEOGRAPHY_UNKNOWN = 0.3;

function solisGeography(county: string): number {
  return SOLIS_GEOGRAPHY_BANDS[county] ?? SOLIS_GEOGRAPHY_UNKNOWN;
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
  /** WS-W — registry refs of the account's active, bound GC warm network in
   * territory (from the digest league table). Absent for accounts that don't
   * compute it; used only to emit a score-neutral `warm_gc_active` signal. */
  warmGcRefs?: ReadonlySet<string>;
  /** WS-B — the account's configured trade codes (Solis: drywall/painting, from
   * the account `capabilities`). Used ONLY to emit the score-neutral `trade_match`
   * signal when a project GC's registry trade codes intersect these. Absent ⇒ the
   * signal never fires (frozen eval accounts are unaffected). */
  trades?: readonly string[];
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

/**
 * Freshness INSIDE the application stage (v1.12.0).
 *
 * The stage maps below treat every `permit_applied` record identically, which
 * was the single largest distortion in the model: on 2026-07-26 Solis held 496
 * application-stage opportunities — 147 filed within four weeks and 124 filed
 * more than twelve weeks earlier — and all 496 scored timing 1.0. At the
 * priority band that put 46 fresh leads and 44 cold ones side by side.
 *
 * `appliedAt === null` returns 1 deliberately. An unstated filing date is not
 * evidence of staleness (the `recencyFactor` discipline), and it is also what
 * keeps every frozen eval example byte-identical — none carries the field.
 *
 * The curve is DELIBERATELY GENTLE and is an owner-directed starting point, not
 * a fitted result: `pursuits`, `opportunity_outcomes`, `decision_labels`,
 * `feedback` and `pursuit_transitions` were all empty when it was set, so there
 * is no conversion evidence behind any specific number. It also has to survive
 * the open tension in docs/domain-bid-timing.md — WA commercial land-use runs
 * 4–12+ months, so a long review can be a LIVE extended bid window rather than
 * a dead lead. Hence a stale application still scores 0.55, well above an
 * issued one; it is de-prioritised, never buried. Revisit against real outcomes.
 */
export function appliedFreshness(appliedAt: Date | null | undefined, now: Date): number {
  if (!appliedAt) return 1;
  const weeks = (now.getTime() - appliedAt.getTime()) / (7 * 86_400_000);
  if (weeks <= 4) return 1; // ITBs typically going out — the strike zone
  if (weeks <= 8) return 0.9; // bids being levelled — still live, you're on time
  if (weeks <= 12) return 0.75; // closing; expect to be a backup number
  return 0.55; // cold, but WA reviews run long — de-prioritised, not dead
}

/**
 * Interior-trades timing, per bid track (docs/domain-bid-timing.md).
 *
 * v1.7.0 established the inversion: residential drywall bids run 4–8 wks AFTER
 * issuance, commercial drywall is bought out during plan review BEFORE the
 * permit. v1.12.0 acts on it much harder, per owner directive 2026-07-26:
 *
 *   "issued vs applied should be treated very differently … it should be shaved
 *    at least 60% to start, we're primarily using it to build the relationship
 *    graph and job history at this point."
 *
 * So an issued permit is now scored as what it mostly is — a record of who built
 * what, feeding the relationship graph — rather than as a live bid. Commercial
 * issued 0.5 → 0.2 (a 60% shave; still not 0, because plan-check addendum
 * re-pricing is real). Residential issued 0.9 → 0.55: shaved, but by less,
 * because the customer's own 2026-07-17 model says a framed, dried-in house
 * genuinely is when a homebuilder walks the site to measure — that window is
 * real, it is just usually already spoken for by a standing sub.
 *
 * Residential `approved`/`construction_documents` drop 0.6 → 0.5 to preserve the
 * model's ordering: those are PRE-permit residential stages ("not biddable yet,
 * watch for issuance"), so they must stay below issued rather than leapfrog it
 * as a side effect of the shave.
 */
function timingInterior(
  stage: string,
  track: BidTrack,
  appliedAt: Date | null | undefined,
  now: Date,
): number {
  // Freshness applies to the filed-application stage only — it is the one stage
  // with a filing date behind it (99.8% coverage) and the one the gradient is
  // about. Other pre-permit stages have no equivalent clock.
  const fresh = stage === "permit_applied" ? appliedFreshness(appliedAt, now) : 1;
  if (track === "commercial") {
    const map: Record<string, number> = {
      bidding_confirmed: 1, permit_applied: 1, construction_documents: 1, approved: 1,
      entitlement: 0.9, preapplication: 0.7, permit_issued: 0.2, construction: 0.16,
      near_final: 0.08, complete: 0.05, concept: 0.2,
    };
    return (map[stage] ?? (stage === "unknown" ? 0.5 : 0.1)) * fresh;
  }
  // owner 2026-07-20 directive — earlier stage = more lead time to get in before
  // the GC locks its subs, so permit_applied is weighted ABOVE permit_issued on
  // the residential interior track. The per-track bid-window LINE (bid-window.ts)
  // is unchanged and still reflects the true clock.
  const map: Record<string, number> = {
    permit_issued: 0.55, construction: 0.6, bidding_confirmed: 1, permit_applied: 1,
    approved: 0.5, construction_documents: 0.5, near_final: 0.3, entitlement: 0.4,
    preapplication: 0.2, concept: 0.2,
  };
  return (map[stage] ?? (stage === "unknown" ? 0.5 : 0.1)) * fresh;
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

/** Roles that make an org the project's GC/decision-maker for Solis's signals. */
const SOLIS_GC_ROLES = ["primary_contractor", "applicant", "owner"] as const;
/** WS-B `gc_quality` bar: a well-rated Google Business profile with enough
 * reviews to be credible. Signal-only under §12.3 — never a score input. */
const GC_QUALITY_MIN_RATING = 4.0;
const GC_QUALITY_MIN_REVIEWS = 5;

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
  // v1.8.0 — every new home needs drywall AND paint: residential new
  // construction is an intrinsic trade fit (customer-approved 2026-07-17),
  // routed in the HOME counties (Pierce/Lewis/Thurston). King new-builds stay
  // out until calibration (distant secondary market); demolition, field work,
  // and entitlement-only records never ride in on the SFR flag.
  const sfrNewBuild =
    c.isSfr && !c.isDemolition && !c.isFieldWork && !c.isEntitlementOnly && f.county !== "King";
  const fits = c.isTi || c.isCommercial || c.isMultifamily || c.hasInterior || sfrNewBuild;
  if (!fits) return null;

  // A clustered/subdivision new-build is a production BUILDER pipeline: one
  // relationship play, never N house-leads (the §10 forty-permit rule).
  const productionCluster = sfrNewBuild && (c.isCluster || c.isSubdivision);
  const overCapacity = (f.maxValuation ?? 0) > 2_000_000 && c.isMultifamily;
  const track = bidTrackFor(c);
  const signals: string[] = [];
  if (c.isTi) signals.push("tenant_improvement");
  if (c.hasInterior) signals.push("drywall_painting_keywords");
  if (sfrNewBuild) signals.push("new_home_construction");
  if (productionCluster) signals.push("production_builder_pipeline");
  // Signal-only while Solis's profile is provisional (§12.3) — visible in the
  // rationale/digest but score-neutral until customer calibration.
  if (f.campusBlock) signals.push("active_campus");
  if (overCapacity) signals.push("gc_relationship_radar");
  // A registry-verified GC/owner on the project — score-neutral SIGNAL while
  // §12.3 provisional (the weighted lift lands at Solis calibration).
  // `registryVerified` reads an already-governed binding, not a new auto-bind.
  if (
    f.orgs.some(
      (o) => o.registryVerified && SOLIS_GC_ROLES.includes((o.role ?? "") as (typeof SOLIS_GC_ROLES)[number]),
    )
  ) {
    signals.push("verified_gc_on_project");
  }
  // Scope-vocabulary SIGNALS (§12.3 score-neutral): which BOOK of business a
  // record belongs to. No weight until Solis confirms scope at calibration —
  // these exist now so the evidence accumulates from today rather than starting
  // at zero the day someone decides to weight them.
  if (RE.specialistAssembly.test(f.text)) signals.push("specialist_assembly");
  if (RE.restorationWork.test(f.text)) signals.push("restoration_scope");
  if (RE.residentialRemodel.test(f.text)) signals.push("residential_remodel_scope");
  // WS-B — score-NEUTRAL SIGNALS (§12.3): pushed for rationale/digest only, with
  // NO account weight and NO `components` entry, so `weighted()` leaves the score
  // byte-identical (the neutrality invariant in scoring.test.ts). Both read the
  // registry contract fields cached on the org; absent on frozen eval examples.
  const isGcRole = (o: ProjectFeatures["orgs"][number]): boolean =>
    SOLIS_GC_ROLES.includes((o.role ?? "") as (typeof SOLIS_GC_ROLES)[number]);
  // gc_quality — a GC/owner whose Google Business profile clears the rating +
  // review-count bar (a credibility cue for the estimator, not a score lever).
  if (
    f.orgs.some(
      (o) =>
        isGcRole(o) &&
        (o.googleRating ?? 0) >= GC_QUALITY_MIN_RATING &&
        (o.googleReviewCount ?? 0) >= GC_QUALITY_MIN_REVIEWS,
    )
  ) {
    signals.push("gc_quality");
  }
  // trade_match — a GC/owner whose authoritative L&I trade codes intersect the
  // account's configured trades (Solis: drywall/painting). Case-insensitive; the
  // registry and the account config share the L&I trade vocabulary.
  const acctTrades = acct.trades;
  if (acctTrades && acctTrades.length > 0) {
    const wanted = new Set(acctTrades.map((t) => t.toLowerCase()));
    if (
      f.orgs.some(
        (o) => isGcRole(o) && (o.tradeCodes ?? []).some((code) => wanted.has(code.toLowerCase())),
      )
    ) {
      signals.push("trade_match");
    }
  }
  // WS-W — a project whose GC/owner is a WARM, registry-bound relationship in the
  // account's territory (from the digest league table). Score-neutral SIGNAL
  // under §12.3 — the relationship-warmth lift lands at Solis calibration. Reads
  // an already-governed binding (registry_ref), introduces no new auto-bind.
  const warmSet = acct.warmGcRefs;
  if (warmSet && warmSet.size > 0 && f.orgs.some((o) => o.registryRef && warmSet.has(o.registryRef))) {
    signals.push("warm_gc_active");
  }
  // v1.7.0 — why an issued commercial project ranks lower (auditability).
  // bidding_confirmed sorts after issuance but is a CONFIRMED-open window.
  if (
    track === "commercial" &&
    f.stage !== "bidding_confirmed" &&
    stageOrder(f.stage) >= stageOrder("permit_issued")
  ) {
    signals.push("commercial_bid_window_likely_closed");
  }

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
          : productionCluster
            ? 0.45 // digest-band relationship play, not a per-house lead
            : sfrNewBuild
              ? 0.7 // every new home needs drywall + paint
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
    timing: timingInterior(f.stage, track, f.appliedAt, now) * recencyFactor(f.lastMaterialChangeAt, now),
    geography: solisGeography(f.county),
    // Registry-backed GC/owner identification (spec §12.3 — SIGNAL-ONLY while
    // Solis is provisional: present here for auditability/rationale but absent
    // from Solis's account weights, so `weighted()` leaves the score unchanged
    // until calibration adds a weight). Reads an already-bound registry_ref —
    // introduces no new auto-binding.
    gc_identified: orgIdentified(f, ["primary_contractor", "applicant", "owner"]),
    evidence_quality: evidenceQuality(f),
  };
  const score = weighted(components, acct.weights);
  // Owner 2026-07-20 (PROVISIONAL §12.3): a SMALL relationship-first nudge when the GC is a
  // warm, registry-bound relationship — additive + clamped so it nudges rather than reorders,
  // and leaves the weight vector and every frozen eval example (no warm set) byte-identical.
  const WARM_GC_BONUS = 3;
  const finalScore = signals.includes("warm_gc_active")
    ? Math.min(100, Math.round((score + WARM_GC_BONUS) * 10) / 10)
    : score;
  return {
    accountKey: acct.key,
    route: overCapacity || productionCluster ? "gc_relationship_radar" : "interior_trades",
    components,
    score: finalScore,
    state: band(finalScore, acct.delivery),
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

/** Phase 1 flywheel — account-agnostic corroboration signals, appended AFTER a
 * router has computed its score so they are score-neutral BY CONSTRUCTION
 * (§12.3: rationale/digest disclosure only, never a weight). */
function appendCorroborationSignals(signals: string[], f: ProjectFeatures): void {
  if ((f.corroborationSourceCount ?? 0) >= 2) signals.push("corroborated_multi_source");
  if ((f.corroborationStageDepth ?? 0) >= 2) signals.push("lifecycle_progressing");
  if (f.hasFactContradiction) signals.push("fact_contradiction");
}

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
    if (result) {
      appendCorroborationSignals(result.signals, f);
      out.push(result);
    }
  }
  return out;
}
