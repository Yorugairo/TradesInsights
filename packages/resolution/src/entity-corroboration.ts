/**
 * Entity↔entity corroboration — "what links these two companies, BESIDES the
 * shared person's name?"
 *
 * Distinct from `corroboration.ts`, which cross-references SOURCES describing one
 * PROJECT. This compares the identity fields of two registry ENTITIES, purely in
 * memory.
 *
 * A reviewer looking at `Michael Moore → Moore Furniture Inc + Gill Group Inc`
 * cannot act on the claim without knowing whether anything else agrees. Live
 * data (2026-07-23) says nothing does: Moore Furniture is in Ephrata WA on a 509
 * number; Gill Group is in Crofton, Maryland on a 410 number; and L&I's own
 * records spell `MOORE, MICHAEL F` and `MOORE, MICHAEL L`. One evidence point (a
 * coarse name), actively contradicted by two others.
 *
 * Every signal is computed from contract columns we ALREADY fetch — no new
 * registry read, no model call. Determinism matters more than fluency in a
 * review queue: the reviewer is checking facts, and a generated paraphrase can
 * be wrong in ways a field comparison cannot.
 *
 * Measured across all 912 entity pairs the principal lane produces:
 *   middle-initial conflict 463 · shared trade 245 · same city 148 ·
 *   same postal 129 · same address 95 · same phone 61 · same domain 0 ·
 *   nothing-but-the-name 165.
 */
import type { RegistryIdentityRow } from "./registry-link.js";

/** One agreeing or disagreeing field between two entities. */
export interface CorroborationSignal {
  /** Stable machine name, e.g. `phone`, `middle_initial`. */
  key: string;
  /** What a reviewer reads, e.g. `same L&I phone 5097543231`. */
  label: string;
  /** True when the field AGREES; false when it actively disagrees. */
  agrees: boolean;
}

export type CorroborationVerdict =
  /** A field actively says these are different people. */
  | "contradicted"
  /** Nothing but the name links them. */
  | "name_only"
  /** One or two independent fields agree. */
  | "corroborated"
  /** Three or more independent fields agree. */
  | "strong";

export interface EntityCorroboration {
  /** Count of independently agreeing fields — the number the reviewer asked for. */
  points: number;
  signals: CorroborationSignal[];
  verdict: CorroborationVerdict;
  /** One plain sentence assembled from the signals above (never generated prose). */
  explanation: string;
}

/** The middle initial inside a registry principal key (`SURNAME, GIVEN M`). */
export function middleInitial(registryKey: string | null | undefined): string | null {
  if (registryKey == null) return null;
  const commaAt = registryKey.indexOf(",");
  if (commaAt < 0) return null;
  const parts = registryKey.slice(commaAt + 1).trim().split(" ").filter((t) => t !== "");
  const mid = parts[1];
  return mid && mid.length > 0 ? mid[0]!.toUpperCase() : null;
}

const norm = (v: string | null | undefined): string | null => {
  if (v == null) return null;
  const t = String(v).trim().toUpperCase();
  return t === "" ? null : t;
};
/** Phones compare on digits alone — L&I stores `5097543231`, Google `(509) 754-3231`. */
const digits = (v: string | null | undefined): string | null => {
  if (v == null) return null;
  const d = String(v).replace(/\D/g, "");
  return d.length >= 7 ? d : null;
};

/**
 * Compare two registry entities that a shared principal has linked.
 *
 * `principalKeyA`/`principalKeyB` are the FULL registry keys those entities carry
 * for this person. When both spell a middle initial and the two differ, L&I is
 * telling us these are two different humans — the single most decisive signal
 * available, and the one that separates `Moore Furniture` from `Gill Group`.
 */
export function corroborateEntities(
  a: RegistryIdentityRow,
  b: RegistryIdentityRow,
  principalKeyA?: string | null,
  principalKeyB?: string | null,
): EntityCorroboration {
  const signals: CorroborationSignal[] = [];
  const agree = (key: string, label: string) => signals.push({ key, label, agrees: true });
  const conflict = (key: string, label: string) => signals.push({ key, label, agrees: false });

  const midA = middleInitial(principalKeyA);
  const midB = middleInitial(principalKeyB);
  if (midA && midB) {
    if (midA === midB) agree("middle_initial", `L&I spells the same middle initial (${midA}) on both`);
    else conflict("middle_initial", `L&I spells DIFFERENT middle initials — ${midA} vs ${midB}`);
  }

  // State is conflict-only: two WA-registered entities agreeing on "WA" says
  // nothing, but a WA/MD disagreement is real evidence of different people.
  const stA = norm(a.stateCode);
  const stB = norm(b.stateCode);
  if (stA && stB && stA !== stB) conflict("state", `registered in different states — ${stA} vs ${stB}`);

  const phoneA = digits(a.phone);
  if (phoneA && phoneA === digits(b.phone)) agree("phone", `same L&I phone ${phoneA}`);
  const gA = digits(a.googlePhone);
  // Counted only when it is NOT a restatement of the L&I phone already credited.
  if (gA && gA === digits(b.googlePhone) && gA !== phoneA) agree("google_phone", `same Google phone ${gA}`);

  const addrA = norm(a.registeredAddress);
  if (addrA && addrA === norm(b.registeredAddress)) agree("address", `same registered address — ${addrA}`);
  const zipA = norm(a.registeredPostalCode);
  if (zipA && zipA === norm(b.registeredPostalCode)) agree("postal_code", `same postal code ${zipA}`);
  const cityA = norm(a.cityToken);
  if (cityA && cityA === norm(b.cityToken)) agree("city", `same registered city — ${cityA.toLowerCase()}`);

  const domA = norm(a.rootDomain);
  if (domA && domA === norm(b.rootDomain)) agree("root_domain", `same website domain ${domA.toLowerCase()}`);

  const ubiA = norm(a.ubi);
  if (ubiA && ubiA === norm(b.ubi)) agree("ubi", `same UBI ${ubiA} (already one legal entity)`);

  const tradesA = new Set((a.tradeCodes ?? []).map((t) => t.toLowerCase()));
  const shared = (b.tradeCodes ?? []).map((t) => t.toLowerCase()).filter((t) => tradesA.has(t));
  if (shared.length > 0) agree("trade", `shared trade — ${shared.join(", ")}`);

  const points = signals.filter((s) => s.agrees).length;
  const contradicted = signals.some((s) => !s.agrees && s.key === "middle_initial");
  const verdict: CorroborationVerdict = contradicted
    ? "contradicted"
    : points === 0
      ? "name_only"
      : points >= 3
        ? "strong"
        : "corroborated";

  return { points, signals, verdict, explanation: explain(verdict, points, signals) };
}

function explain(
  verdict: CorroborationVerdict,
  points: number,
  signals: CorroborationSignal[],
): string {
  const agreed = signals.filter((s) => s.agrees).map((s) => s.label);
  const against = signals.filter((s) => !s.agrees).map((s) => s.label);
  if (verdict === "contradicted") {
    return `Almost certainly two different people: ${against.join("; ")}.` +
      (points > 0 ? ` (${points} field(s) do agree: ${agreed.join("; ")}.)` : "");
  }
  if (verdict === "name_only") {
    return "Nothing links these two companies except the person's name — no shared phone, address, city, or trade. Unproven.";
  }
  const head = verdict === "strong" ? "Well corroborated" : "Partly corroborated";
  return `${head} — ${points} independent field(s) agree: ${agreed.join("; ")}.` +
    (against.length > 0 ? ` Against: ${against.join("; ")}.` : "");
}

/**
 * Citation for a registry entity: WA L&I's public contractor-verification page,
 * the authoritative source for the principal claim under review. Null when we
 * have no UBI — a link we cannot build is omitted, never guessed.
 */
export function lniVerifyUrl(row: {
  ubi?: string | null;
  contractorNumbers?: string[] | null;
}): string | null {
  const ubi = (row.ubi ?? "").replace(/\D/g, "");
  if (!ubi) return null;
  const lic = row.contractorNumbers?.[0];
  const q = new URLSearchParams({ UBI: ubi, ...(lic ? { LIC: lic } : {}), SAW: "false" });
  return `https://secure.lni.wa.gov/verify/Detail.aspx?${q.toString()}`;
}
