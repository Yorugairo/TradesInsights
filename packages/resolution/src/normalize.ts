import type { NormalizedSourceRecord } from "@otn/domain";

/**
 * M2.1 — deterministic normalizers (spec §10). Everything here is pure and
 * conservative: normalization never invents data, it only canonicalizes what
 * a record explicitly states.
 */

// ── Address ──────────────────────────────────────────────────────────────────

/** USPS-style suffix canonicalization (subset that appears in pilot data). */
const STREET_SUFFIX: Record<string, string> = {
  STREET: "ST", STR: "ST", ST: "ST",
  AVENUE: "AVE", AVEN: "AVE", AV: "AVE", AVE: "AVE",
  ROAD: "RD", RD: "RD",
  DRIVE: "DR", DRV: "DR", DR: "DR",
  BOULEVARD: "BLVD", BLVD: "BLVD", BOUL: "BLVD",
  LANE: "LN", LN: "LN",
  COURT: "CT", CT: "CT",
  PLACE: "PL", PL: "PL",
  CIRCLE: "CIR", CIR: "CIR",
  HIGHWAY: "HWY", HWY: "HWY",
  PARKWAY: "PKWY", PKWY: "PKWY",
  TERRACE: "TER", TER: "TER",
  TRAIL: "TRL", TRL: "TRL",
  WAY: "WAY",
  LOOP: "LOOP",
};

const DIRECTIONAL: Record<string, string> = {
  NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W",
  NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE", SOUTHWEST: "SW",
  N: "N", S: "S", E: "E", W: "W", NE: "NE", NW: "NW", SE: "SE", SW: "SW",
};

export interface NormalizedAddress {
  /** Canonical single-line street address (no city/state/zip). */
  line: string;
  city: string | null;
  zip: string | null;
}

/**
 * Canonicalize a raw address string: uppercase, punctuation stripped,
 * directional + suffix abbreviations, city/zip split off when the string
 * carries comma-separated tail segments or a trailing ZIP.
 */
export function normalizeAddress(raw: string): NormalizedAddress {
  let s = raw.toUpperCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();

  let zip: string | null = null;
  const zipMatch = /\b(\d{5})(?:-\d{4})?$/.exec(s);
  if (zipMatch) {
    zip = zipMatch[1]!;
    s = s.slice(0, zipMatch.index).trim();
  }
  s = s.replace(/\bWA(SHINGTON)?$/g, "").trim();

  // Tail city detection: the segment after the street suffix token.
  const tokens = s.split(" ").filter(Boolean);
  const out: string[] = [];
  let suffixSeen = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (DIRECTIONAL[t]) {
      out.push(DIRECTIONAL[t]!);
      continue;
    }
    if (STREET_SUFFIX[t]) {
      out.push(STREET_SUFFIX[t]!);
      if (suffixSeen === -1 && i > 0) suffixSeen = out.length - 1;
      continue;
    }
    out.push(t);
  }

  // City = tokens after the last suffix+optional directional run, only when
  // there is a plausible street part before it.
  let line = out.join(" ");
  let city: string | null = null;
  if (suffixSeen >= 0) {
    let end = suffixSeen;
    while (end + 1 < out.length && DIRECTIONAL[out[end + 1]!]) end++;
    if (end + 1 < out.length && /^\d/.test(out[0]!)) {
      const cityTokens = out.slice(end + 1);
      // Unit designators are not a city.
      if (!/^(APT|STE|SUITE|UNIT|BLDG|FL|\d+[A-Z]?)$/.test(cityTokens[0]!)) {
        city = cityTokens.join(" ");
        line = out.slice(0, end + 1).join(" ");
      }
    }
  }
  return { line, city, zip };
}

// ── Parcels ──────────────────────────────────────────────────────────────────

/** Canonical parcel id: digits only (pilot counties use numeric APNs). */
export function normalizeParcel(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}

// ── Organizations ────────────────────────────────────────────────────────────

const LEGAL_SUFFIXES = new Set([
  "LLC", "L.L.C", "INC", "INCORPORATED", "CORP", "CORPORATION", "CO",
  "COMPANY", "LP", "LLP", "PLLC", "PC", "PS", "LTD",
]);

const ORG_NOISE = new Set(["THE", "OF", "AND", "&"]);

export interface NormalizedOrgName {
  /** Full canonical form, suffix retained: "COLE REMODELING & CONST LLC". */
  canonical: string;
  /** Comparison base without legal suffixes/noise: "COLE REMODELING CONST". */
  base: string;
  hasLegalSuffix: boolean;
}

export function normalizeOrgName(raw: string): NormalizedOrgName {
  const canonical = raw
    .toUpperCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = canonical.split(" ").filter(Boolean);
  let hasLegalSuffix = false;
  const baseTokens = tokens.filter((t) => {
    if (LEGAL_SUFFIXES.has(t)) {
      hasLegalSuffix = true;
      return false;
    }
    return !ORG_NOISE.has(t);
  });
  return { canonical, base: baseTokens.join(" "), hasLegalSuffix };
}

// ── Name compatibility ───────────────────────────────────────────────────────

/** Project names too generic to support a match on their own (spec §10). */
const GENERIC_NAME_PATTERNS = [
  /^TENANT IMPROVEMENTS?$/,
  /^(NEW )?(SFR|SINGLE FAMILY (RESIDENCE|HOME|DWELLING))$/,
  /^(RE-?ROOF|REROOF)$/,
  /^REMODEL$/,
  /^ADDITION$/,
  /^GARAGE$/,
  /^DEMOLITION$/,
  /^PERMIT$/,
  /^PROJECT$/,
];

export function isGenericName(name: string): boolean {
  const n = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return GENERIC_NAME_PATTERNS.some((p) => p.test(n));
}

function tokenSet(name: string): Set<string> {
  return new Set(
    name
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !ORG_NOISE.has(t) && !LEGAL_SUFFIXES.has(t)),
  );
}

/** Jaccard similarity over name tokens ∈ [0,1]. */
export function nameSimilarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// ── Stages ───────────────────────────────────────────────────────────────────

const STAGE_ORDER = [
  "concept",
  "preapplication",
  "entitlement",
  "approved",
  "construction_documents",
  "permit_applied",
  "permit_issued",
  "bidding_confirmed",
  "construction",
  "near_final",
  "complete",
] as const;

export type OrderedStage = (typeof STAGE_ORDER)[number];

/** Position in the lifecycle; -1 for unknown/withdrawn (non-ordered). */
export function stageOrder(stage: string): number {
  return STAGE_ORDER.indexOf(stage as OrderedStage);
}

/** The later of two stages; unknown/withdrawn never advance a project. */
export function laterStage(a: string, b: string): string {
  const ia = stageOrder(a);
  const ib = stageOrder(b);
  if (ia === -1) return ib === -1 ? a : b;
  if (ib === -1) return a;
  return ia >= ib ? a : b;
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/** Haversine distance in meters between two [lng, lat] points. */
export function distanceMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ── Record match features ────────────────────────────────────────────────────

/** Cross-source reference ids a record may carry in rawFields (spec §10 pass 2). */
const REFERENCE_FIELDS = [
  "fileNumbers",
  "permitNumbers",
  "relatedmup",
  "sepanumber",
  "leadagencyfilenumber",
  "postId", // Lacey WP post id links the REST listing to its project page
  "projectNumber",
] as const;

export interface MatchFeatures {
  externalId: string;
  referenceIds: string[];
  parcels: string[];
  address: NormalizedAddress | null;
  orgBases: string[];
  point: [number, number] | null;
  title: string;
  generic: boolean;
}

/** Extract deterministic match features from a normalized record + raw fields. */
export function extractFeatures(
  record: NormalizedSourceRecord,
  rawFields: Record<string, unknown>,
): MatchFeatures {
  const referenceIds = new Set<string>();
  for (const f of REFERENCE_FIELDS) {
    const v = rawFields[f];
    if (typeof v === "string" && v.trim()) referenceIds.add(v.trim());
    if (typeof v === "number") referenceIds.add(String(v));
    if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === "string" && x.trim()) referenceIds.add(x.trim());
        if (typeof x === "number") referenceIds.add(String(x));
      }
    }
  }
  referenceIds.delete(record.externalId);

  const parcels = record.parcelIds
    .map(normalizeParcel)
    .filter((p): p is string => p !== null);

  const point =
    record.geometry?.type === "Point"
      ? (record.geometry.coordinates as [number, number])
      : null;

  return {
    externalId: record.externalId,
    referenceIds: [...referenceIds],
    parcels,
    address: record.addressRaw ? normalizeAddress(record.addressRaw) : null,
    orgBases: record.organizations
      .filter((o) => o.role !== "lead_agency")
      .map((o) => normalizeOrgName(o.name).base)
      .filter(Boolean),
    point,
    title: record.title,
    generic: isGenericName(record.title.replace(/^[A-Z0-9-]+ – /, "")),
  };
}

// ── Development grouping (M2.4, spec §10 pass 6) ─────────────────────────────

const PHASE_TOKEN_RE =
  /\b(?:PHASE|PH|DIVISION|DIV|LOT|LOTS|TRACT|BLDG|BUILDING|UNIT)\s*#?\s*([A-Z0-9-]+)\b/gi;
const PLAT_PREFIX_RE = /^(?:PLAT OF|SHORT PLAT OF|SUBDIVISION OF)\s+/i;

/**
 * Permit-type vocabulary: a development base name made ONLY of these tokens
 * is a work description, not a project identity — grouping on it would weld
 * unrelated permits together (live example: 1,395 King "ADDITION ALTERATION"
 * permits are not one development).
 */
const PERMIT_VOCAB = new Set([
  "ADDITION", "ALTERATION", "IMPROVEMENT", "RESIDENTIAL", "COMMERCIAL",
  "INDUSTRIAL", "MASTER", "USE", "PERMIT", "PERMITS", "SINGLE", "FAMILY",
  "RESIDENCE", "HOME", "HOUSE", "DWELLING", "NEW", "CONSTRUCTION", "SFR",
  "MOBILE", "PLACEMENT", "UTILITY", "STRUCTURE", "REROOF", "ROOF",
  "DEMOLITION", "DEMO", "GARAGE", "CARPORT", "SHOP", "BARN", "DECK",
  "REMODEL", "REPAIR", "REPLACEMENT", "INSTALL", "INSTALLATION", "TENANT",
  "GRADING", "CLEARING", "PLAN", "REVIEW", "APPLICATION", "PROJECT", "SITE",
  "WORK", "MISC", "OTHER", "DETACHED", "ATTACHED", "ACCESSORY", "ADU",
  "AT", "THE", "OF", "AND", "FOR", "TO", "A", "AN", "ON", "IN", "WITH",
]);

export interface DevelopmentName {
  /** Shared base name with phase/lot/division tokens stripped. */
  base: string;
  /** The phase-ish label found, e.g. "PHASE 2", "DIV 5", "LOT 23"; null for the base project. */
  phaseLabel: string | null;
  /** True when the title is the plat/subdivision record itself. */
  isPlat: boolean;
}

/**
 * Extract a development grouping key from a project title. Returns null when
 * the remaining base name is generic or too short to group on safely.
 */
export function developmentName(title: string): DevelopmentName | null {
  let s = title
    .toUpperCase()
    .replace(/^.{1,40}?\s[–—]\s/, "") // strip id prefix
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const isPlat = PLAT_PREFIX_RE.test(s);
  s = s.replace(PLAT_PREFIX_RE, "");

  const labels: string[] = [];
  s = s
    .replace(PHASE_TOKEN_RE, (m) => {
      labels.push(m.replace(/\s+/g, " ").trim());
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();

  if (!s || s.split(" ").length < 2 || isGenericName(s)) return null;
  // Require at least one distinctive (non-permit-vocabulary, non-numeric)
  // token so work descriptions never become development identities.
  const distinctive = s
    .split(" ")
    .filter((t) => !PERMIT_VOCAB.has(t) && !/^\d+$/.test(t));
  if (distinctive.length === 0) return null;
  return { base: s, phaseLabel: labels[0] ?? null, isPlat };
}
