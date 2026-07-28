import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/**
 * Takeoff scaffold (deck appendix A6: "estimate, then measure yourself
 * against it"). Deterministic — no model calls, no network. The derivation
 * reads the SAME evidence text the scorer reads and turns it into editable
 * assembly lines; the estimator keeps the pen.
 *
 * EVERYTHING DERIVED HERE IS AN ESTIMATE. Quantities come from permit text,
 * not measured drawings; dollar figures come from owner-editable unit costs.
 * The UI renders them with a `~` for the same reason the Solis deck labels its
 * margin figures: telling a contractor what his numbers are is how you lose
 * the room. Every derived line carries `provenance` — the matched snippet —
 * so "why does this sheet say 4,200 sqft" stays answerable.
 */

export class TakeoffError extends Error {
  constructor(
    public code:
      | "not_found"
      | "line_not_found"
      | "unknown_assembly"
      | "invalid_value"
      | "sheet_final",
    message: string,
  ) {
    super(message);
    this.name = "TakeoffError";
  }
}

export type AssemblyUnit = "sqft" | "lf" | "each" | "allowance";

export interface AssemblyDef {
  key: string;
  description: string;
  unit: AssemblyUnit;
  /**
   * Starting unit costs are round placeholder figures in the OWNER-ASSUMED
   * tradition — obviously-editable defaults, not market data, and never to be
   * presented as measured. The customer's own numbers win; confirming these
   * belongs in the next calibration session, NOT in account-profiles.yaml
   * until Solis has actually spoken to them.
   */
  defaultUnitCost: number;
}

export const TAKEOFF_ASSEMBLIES: readonly AssemblyDef[] = [
  { key: "hang_finish", description: "Hang, tape & finish (Level 4)", unit: "sqft", defaultUnitCost: 2.5 },
  { key: "level5_skim", description: "Level 5 skim coat", unit: "sqft", defaultUnitCost: 1.2 },
  { key: "metal_stud_framing", description: "Metal stud framing", unit: "lf", defaultUnitCost: 14 },
  { key: "act_grid", description: "Acoustic ceiling grid & tile", unit: "sqft", defaultUnitCost: 4 },
  { key: "insulation", description: "Batt insulation", unit: "sqft", defaultUnitCost: 0.9 },
  { key: "fire_rated_assembly", description: "Fire-rated / shaftwall assembly", unit: "sqft", defaultUnitCost: 5.5 },
  { key: "paint_walls", description: "Paint — walls (2 coats)", unit: "sqft", defaultUnitCost: 1.1 },
  { key: "paint_ceilings", description: "Paint — ceilings", unit: "sqft", defaultUnitCost: 1.3 },
  { key: "doors_frames", description: "Doors & frames (paint/patch)", unit: "each", defaultUnitCost: 85 },
  { key: "scope_allowance", description: "Interior scope allowance (from valuation)", unit: "allowance", defaultUnitCost: 1 },
] as const;

const ASSEMBLY_BY_KEY = new Map(TAKEOFF_ASSEMBLIES.map((a) => [a.key, a]));

/**
 * Extraction patterns over permit evidence text.
 *
 * The assembly triggers are ADAPTED from scoring.ts `RE` (lines ~156-200),
 * which is deliberately unexported and must not be touched — the eval gates
 * are byte-frozen against it. Duplicating four small regexes and accepting
 * drift beats coupling the takeoff to the scorer. Drift here mis-suggests a
 * worksheet line; drift there mis-ranks a customer's week.
 */
const EXTRACT = {
  sqft: /(\d{1,3}(?:,\d{3})+|\d{3,7})\s*(?:sq\.?\s?ft\.?|sf\b|square\s+feet)/i,
  linearFeet: /(\d{1,3}(?:,\d{3})+|\d{2,6})\s*(?:lf\b|lin\.?\s?ft\.?|linear\s+feet)/i,
  level5: /\b(level\s*5|skim\s*coat|smooth\s*wall)\b/i,
  fireRated: /\b(\d\s*-?\s*(?:hr|hour)\s+rated|fire[- ]?rated|shaftwall|shaft\s+wall|firestop)\b/i,
  acoustic: /\b(stc\s*\d{2}|acoustic|sound\s*(?:proof|attenuation)|quietrock)\b/i,
  actGrid: /\b(acoustical?\s+ceiling|ceiling\s+grid|act\b|t-bar)\b/i,
  commercialTi: /\b(tenant|t\.i\.|interior (?:remodel|alteration|improvement))\b/i,
} as const;

/**
 * Interior-trade share of stated valuation used for the allowance fallback.
 * OWNER JUDGEMENT, not measurement — all outcome tables were empty when these
 * were set (same situation as scoring v1.12.0's issued shave). Surfaced to the
 * customer with a `~` and the word "estimate"; revisit against real bid
 * outcomes once pursuit_outcomes accumulate.
 */
const VALUATION_SHARE = { commercialTi: 0.18, default: 0.1 } as const;

/** Default waste applied to derived sqft quantities (industry-typical ~10%). */
const DEFAULT_WASTE_PCT = 10;

export interface DerivedLine {
  assemblyKey: string;
  description: string;
  qty: number;
  unit: AssemblyUnit;
  unitCost: number;
  provenance: string;
}

export interface TakeoffEvidence {
  text: string;
  maxValuation: number | null;
  maxUnits: number | null;
}

/**
 * The same evidence substrate score-run.ts builds (its `rec` lateral,
 * score-run.ts:99-116): active resolutions' title/description/type fields,
 * concatenated and lowercased. Reproduced rather than refactored — score-run
 * feeds the frozen eval gates and is not to be reshaped for a reader.
 */
export async function loadTakeoffEvidence(db: Db, opportunityId: string): Promise<TakeoffEvidence> {
  const res = await db.execute(sql`
    SELECT
      COALESCE(rec.text, lower(p.canonical_name)) AS text,
      rec.max_valuation,
      rec.max_units
    FROM opportunities o
    JOIN projects p ON p.id = o.project_id
    LEFT JOIN LATERAL (
      SELECT
        lower(string_agg(rec_text.t, ' ')) AS text,
        max((sr.normalized_json->>'valuationUsd')::numeric)::float AS max_valuation,
        max((sr.normalized_json->>'units')::numeric)::float AS max_units
      FROM record_resolutions rr
      JOIN source_records sr ON sr.id = rr.source_record_id
      CROSS JOIN LATERAL (
        SELECT concat_ws(' ',
          sr.normalized_json->>'title',
          left(sr.normalized_json->>'description', 800),
          sr.normalized_json->>'permitType',
          sr.normalized_json->>'applicationType',
          sr.normalized_json->>'documentType') AS t
      ) rec_text
      WHERE rr.project_id = p.id AND rr.status = 'active'
    ) rec ON true
    WHERE o.id = ${opportunityId}`);
  const r = res.rows[0] as
    | { text: string | null; max_valuation: number | null; max_units: number | null }
    | undefined;
  return {
    text: r?.text ?? "",
    maxValuation: r?.max_valuation ?? null,
    maxUnits: r?.max_units ?? null,
  };
}

function parseQty(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

function line(key: string, qty: number, provenance: string, over?: Partial<DerivedLine>): DerivedLine {
  const a = ASSEMBLY_BY_KEY.get(key);
  if (!a) throw new TakeoffError("unknown_assembly", `unknown assembly ${key}`);
  return {
    assemblyKey: a.key,
    description: a.description,
    qty,
    unit: a.unit,
    unitCost: a.defaultUnitCost,
    provenance,
    ...over,
  };
}

/**
 * Evidence → suggested lines. Pure and deterministic (exported for tests).
 *
 * Rules, in order of trust:
 * - stated sqft → hang/finish + paint lines at sqft×(1+waste);
 * - assembly triggers (level 5 / fire-rated / acoustic ceiling) → their line,
 *   at the stated sqft when present, else qty 0 flagged "set from job walk" —
 *   a zero the estimator must touch beats a number nobody stated;
 * - stated linear feet → metal stud framing;
 * - NOTHING but valuation → one allowance line at valuation×trade-share. The
 *   fallback never fabricates quantities — it prices scope, labelled as such.
 */
export function deriveLines(evidence: TakeoffEvidence, wastePct: number = DEFAULT_WASTE_PCT): DerivedLine[] {
  const text = evidence.text ?? "";
  const out: DerivedLine[] = [];
  const waste = 1 + wastePct / 100;

  const sqftMatch = EXTRACT.sqft.exec(text);
  const sqft = sqftMatch ? parseQty(sqftMatch[1]!) : null;
  const lfMatch = EXTRACT.linearFeet.exec(text);

  if (sqft !== null && sqft > 0) {
    const prov = `stated area: "${sqftMatch![0]}"`;
    out.push(line("hang_finish", Math.round(sqft * waste), `${prov} × ${(waste).toFixed(2)} waste`));
    out.push(line("paint_walls", Math.round(sqft * waste), prov));
  }

  if (EXTRACT.level5.test(text)) {
    out.push(
      line("level5_skim", sqft !== null ? Math.round(sqft * waste) : 0,
        sqft !== null ? `level-5 trigger + stated area` : `level-5 trigger; quantity unknown — set from job walk`),
    );
  }
  if (EXTRACT.fireRated.test(text)) {
    out.push(
      line("fire_rated_assembly", 0, `fire-rated trigger: "${EXTRACT.fireRated.exec(text)?.[0] ?? ""}"; quantity unknown — set from job walk`),
    );
  }
  if (EXTRACT.actGrid.test(text) || EXTRACT.acoustic.test(text)) {
    out.push(
      line("act_grid", 0, `ceiling/acoustic trigger; quantity unknown — set from job walk`),
    );
  }
  if (lfMatch) {
    out.push(line("metal_stud_framing", parseQty(lfMatch[1]!), `stated framing: "${lfMatch[0]}"`));
  }

  if (out.length === 0 && evidence.maxValuation !== null && evidence.maxValuation > 0) {
    const share = EXTRACT.commercialTi.test(text) ? VALUATION_SHARE.commercialTi : VALUATION_SHARE.default;
    out.push(
      line("scope_allowance", 1, `~${Math.round(share * 100)}% of stated valuation $${evidence.maxValuation.toLocaleString("en-US")} — estimate, not a measured quantity`, {
        unitCost: Math.round(evidence.maxValuation * share),
      }),
    );
  }

  return out;
}

export interface TakeoffLineRow {
  id: string;
  assemblyKey: string;
  description: string;
  qty: number;
  unit: AssemblyUnit;
  unitCost: number;
  source: "derived" | "manual";
  provenance: string | null;
  sort: number;
}

export interface TakeoffSheet {
  id: string;
  pursuitId: string;
  accountProfileId: string;
  status: "draft" | "final";
  wastePct: number;
  overheadPct: number;
  marginPct: number;
  lines: TakeoffLineRow[];
  totals: TakeoffTotals;
}

export interface TakeoffTotals {
  subtotal: number;
  overhead: number;
  margin: number;
  bidPrice: number;
  derivedCount: number;
  manualCount: number;
}

/** Waste lives inside derived quantities (qty already includes it); totals are
 * therefore plain Σ(qty × unitCost) → +overhead → +margin. */
export function sheetTotals(
  lines: readonly Pick<TakeoffLineRow, "qty" | "unitCost" | "source">[],
  overheadPct: number,
  marginPct: number,
): TakeoffTotals {
  const subtotal = lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
  const overhead = subtotal * (overheadPct / 100);
  const margin = (subtotal + overhead) * (marginPct / 100);
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    overhead: Math.round(overhead * 100) / 100,
    margin: Math.round(margin * 100) / 100,
    bidPrice: Math.round((subtotal + overhead + margin) * 100) / 100,
    derivedCount: lines.filter((l) => l.source === "derived").length,
    manualCount: lines.filter((l) => l.source === "manual").length,
  };
}

async function loadSheetRow(db: Db, pursuitId: string) {
  const res = await db.execute(sql`SELECT * FROM takeoff_sheets WHERE pursuit_id = ${pursuitId}`);
  return (res.rows[0] as Record<string, unknown> | undefined) ?? null;
}

async function loadLines(db: Db, sheetId: string): Promise<TakeoffLineRow[]> {
  const res = await db.execute(
    sql`SELECT id, assembly_key, description, qty, unit, unit_cost, source, provenance, sort
        FROM takeoff_lines WHERE sheet_id = ${sheetId} ORDER BY sort ASC, created_at ASC`,
  );
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: r["id"] as string,
    assemblyKey: r["assembly_key"] as string,
    description: r["description"] as string,
    qty: Number(r["qty"]),
    unit: r["unit"] as AssemblyUnit,
    unitCost: Number(r["unit_cost"]),
    source: r["source"] as "derived" | "manual",
    provenance: (r["provenance"] as string | null) ?? null,
    sort: Number(r["sort"]),
  }));
}

function toSheet(row: Record<string, unknown>, lines: TakeoffLineRow[]): TakeoffSheet {
  const overheadPct = Number(row["overhead_pct"]);
  const marginPct = Number(row["margin_pct"]);
  return {
    id: row["id"] as string,
    pursuitId: row["pursuit_id"] as string,
    accountProfileId: row["account_profile_id"] as string,
    status: row["status"] as "draft" | "final",
    wastePct: Number(row["waste_pct"]),
    overheadPct,
    marginPct,
    lines,
    totals: sheetTotals(lines, overheadPct, marginPct),
  };
}

async function insertDerivedLines(db: Db, sheetId: string, derived: DerivedLine[], sortBase: number): Promise<void> {
  let sort = sortBase;
  for (const l of derived) {
    await db.execute(sql`
      INSERT INTO takeoff_lines (sheet_id, assembly_key, description, qty, unit, unit_cost, source, provenance, sort)
      VALUES (${sheetId}, ${l.assemblyKey}, ${l.description}, ${l.qty}, ${l.unit}, ${l.unitCost}, 'derived', ${l.provenance}, ${sort})`);
    sort += 10;
  }
}

/** Read-only lookup — returns null rather than creating. The pursuit detail
 * page uses this so merely VIEWING a pursuit never mints a sheet. */
export async function getTakeoffSheet(db: Db, pursuitId: string): Promise<TakeoffSheet | null> {
  const row = await loadSheetRow(db, pursuitId);
  if (!row) return null;
  return toSheet(row, await loadLines(db, row["id"] as string));
}

/**
 * Get the pursuit's sheet, deriving one on first call. Concurrency: the
 * UNIQUE(pursuit_id) constraint arbitrates get-or-create races — the loser's
 * INSERT ... ON CONFLICT DO NOTHING falls back to the winner's row
 * (deliver.ts:110-118 precedent).
 */
export async function getOrCreateTakeoffSheet(
  db: Db,
  pursuit: { id: string; accountProfileId: string; opportunityId: string },
): Promise<TakeoffSheet> {
  const existing = await loadSheetRow(db, pursuit.id);
  if (existing) return toSheet(existing, await loadLines(db, existing["id"] as string));

  const evidence = await loadTakeoffEvidence(db, pursuit.opportunityId);
  const derived = deriveLines(evidence);
  const snapshot = {
    derivedAt: new Date().toISOString(),
    evidence: { textLength: evidence.text.length, maxValuation: evidence.maxValuation, maxUnits: evidence.maxUnits },
    lineCount: derived.length,
  };
  const inserted = await db.execute(sql`
    INSERT INTO takeoff_sheets (pursuit_id, account_profile_id, derived_from_json)
    VALUES (${pursuit.id}, ${pursuit.accountProfileId}, ${JSON.stringify(snapshot)})
    ON CONFLICT (pursuit_id) DO NOTHING
    RETURNING *`);
  if (inserted.rows.length === 0) {
    const again = await loadSheetRow(db, pursuit.id);
    if (!again) throw new TakeoffError("not_found", "sheet vanished during create");
    return toSheet(again, await loadLines(db, again["id"] as string));
  }
  const row = inserted.rows[0] as Record<string, unknown>;
  await insertDerivedLines(db, row["id"] as string, derived, 0);
  return toSheet(row, await loadLines(db, row["id"] as string));
}

/**
 * Re-run derivation against current evidence. Replaces `source='derived'`
 * lines only — manual lines are the customer's work and are NEVER touched. A
 * refresh that eats an estimator's edits is data loss, not a refresh.
 */
export async function rederiveSheet(
  db: Db,
  pursuit: { id: string; opportunityId: string },
): Promise<TakeoffSheet> {
  const row = await loadSheetRow(db, pursuit.id);
  if (!row) throw new TakeoffError("not_found", `no takeoff sheet for pursuit ${pursuit.id}`);
  if ((row["status"] as string) === "final") {
    throw new TakeoffError("sheet_final", "sheet is final — reopen to draft before re-deriving");
  }
  const sheetId = row["id"] as string;
  const evidence = await loadTakeoffEvidence(db, pursuit.opportunityId);
  const derived = deriveLines(evidence, Number(row["waste_pct"]));

  await db.execute(sql`DELETE FROM takeoff_lines WHERE sheet_id = ${sheetId} AND source = 'derived'`);
  // Derived lines re-sort after the highest surviving manual sort, so a
  // re-derive never shuffles the customer's ordering.
  const maxSort = await db.execute(
    sql`SELECT COALESCE(max(sort), -10) AS s FROM takeoff_lines WHERE sheet_id = ${sheetId}`,
  );
  const base = Number((maxSort.rows[0] as { s: number }).s) + 10;
  await insertDerivedLines(db, sheetId, derived, base);
  const snapshot = {
    derivedAt: new Date().toISOString(),
    evidence: { textLength: evidence.text.length, maxValuation: evidence.maxValuation, maxUnits: evidence.maxUnits },
    lineCount: derived.length,
  };
  await db.execute(sql`
    UPDATE takeoff_sheets SET derived_from_json = ${JSON.stringify(snapshot)}, updated_at = now()
    WHERE id = ${sheetId}`);
  return toSheet((await loadSheetRow(db, pursuit.id))!, await loadLines(db, sheetId));
}

export async function addManualLine(
  db: Db,
  sheetId: string,
  input: { assemblyKey: string; qty: number; unitCost?: number; description?: string },
): Promise<{ id: string }> {
  const a = ASSEMBLY_BY_KEY.get(input.assemblyKey);
  if (!a) throw new TakeoffError("unknown_assembly", `unknown assembly ${input.assemblyKey}`);
  if (!Number.isFinite(input.qty) || input.qty < 0) {
    throw new TakeoffError("invalid_value", "qty must be a non-negative number");
  }
  const maxSort = await db.execute(
    sql`SELECT COALESCE(max(sort), -10) AS s FROM takeoff_lines WHERE sheet_id = ${sheetId}`,
  );
  const sort = Number((maxSort.rows[0] as { s: number }).s) + 10;
  const res = await db.execute(sql`
    INSERT INTO takeoff_lines (sheet_id, assembly_key, description, qty, unit, unit_cost, source, sort)
    VALUES (${sheetId}, ${a.key}, ${input.description ?? a.description}, ${input.qty}, ${a.unit},
            ${input.unitCost ?? a.defaultUnitCost}, 'manual', ${sort})
    RETURNING id`);
  return { id: (res.rows[0] as { id: string }).id };
}

/**
 * Edit a line. ANY edit makes the line manual: a derived quantity the
 * estimator has overridden is now the estimator's number, and a later
 * re-derive must not silently put the machine's figure back.
 */
export async function updateLine(
  db: Db,
  sheetId: string,
  lineId: string,
  patch: { qty?: number; unitCost?: number; description?: string },
): Promise<void> {
  for (const v of [patch.qty, patch.unitCost]) {
    if (v !== undefined && (!Number.isFinite(v) || v < 0)) {
      throw new TakeoffError("invalid_value", "qty and unitCost must be non-negative numbers");
    }
  }
  const res = await db.execute(sql`
    UPDATE takeoff_lines SET
      qty = COALESCE(${patch.qty ?? null}, qty),
      unit_cost = COALESCE(${patch.unitCost ?? null}, unit_cost),
      description = COALESCE(${patch.description ?? null}, description),
      source = 'manual',
      provenance = CASE WHEN source = 'derived' THEN concat('was derived: ', COALESCE(provenance, '')) ELSE provenance END
    WHERE id = ${lineId} AND sheet_id = ${sheetId}
    RETURNING id`);
  if (res.rows.length === 0) throw new TakeoffError("line_not_found", `line ${lineId} not on sheet ${sheetId}`);
}

export async function deleteLine(db: Db, sheetId: string, lineId: string): Promise<void> {
  const res = await db.execute(
    sql`DELETE FROM takeoff_lines WHERE id = ${lineId} AND sheet_id = ${sheetId} RETURNING id`,
  );
  if (res.rows.length === 0) throw new TakeoffError("line_not_found", `line ${lineId} not on sheet ${sheetId}`);
}

export async function updateSheetMeta(
  db: Db,
  sheetId: string,
  patch: { wastePct?: number; overheadPct?: number; marginPct?: number; status?: "draft" | "final" },
): Promise<void> {
  for (const v of [patch.wastePct, patch.overheadPct, patch.marginPct]) {
    if (v !== undefined && (!Number.isFinite(v) || v < 0 || v > 100)) {
      throw new TakeoffError("invalid_value", "percentages must be between 0 and 100");
    }
  }
  const res = await db.execute(sql`
    UPDATE takeoff_sheets SET
      waste_pct = COALESCE(${patch.wastePct ?? null}, waste_pct),
      overhead_pct = COALESCE(${patch.overheadPct ?? null}, overhead_pct),
      margin_pct = COALESCE(${patch.marginPct ?? null}, margin_pct),
      status = COALESCE(${patch.status ?? null}, status),
      updated_at = now()
    WHERE id = ${sheetId}
    RETURNING id`);
  if (res.rows.length === 0) throw new TakeoffError("not_found", `sheet ${sheetId} not found`);
}

/**
 * Stamp the sheet's bid price into pursuits.estimated_contract_value —
 * EXPLICIT button, never automatic — and leave an audit note on the pursuit
 * (existing surface, existing render) recording old → new.
 */
export async function stampEstimate(
  db: Db,
  pursuit: { id: string },
  authorUserId: string,
): Promise<{ bidPrice: number }> {
  const row = await loadSheetRow(db, pursuit.id);
  if (!row) throw new TakeoffError("not_found", `no takeoff sheet for pursuit ${pursuit.id}`);
  const lines = await loadLines(db, row["id"] as string);
  const totals = sheetTotals(lines, Number(row["overhead_pct"]), Number(row["margin_pct"]));
  const prev = await db.execute(
    sql`SELECT estimated_contract_value FROM pursuits WHERE id = ${pursuit.id}`,
  );
  const old = (prev.rows[0] as { estimated_contract_value: number | null } | undefined)
    ?.estimated_contract_value ?? null;
  await db.execute(sql`
    UPDATE pursuits SET estimated_contract_value = ${totals.bidPrice}, updated_at = now()
    WHERE id = ${pursuit.id}`);
  await db.execute(sql`
    INSERT INTO pursuit_notes (pursuit_id, author_user_id, body, visibility)
    VALUES (${pursuit.id}, ${authorUserId},
      ${`takeoff sheet stamped as estimated value: ${old === null ? "—" : `$${old.toLocaleString("en-US")}`} → $${totals.bidPrice.toLocaleString("en-US")} (~estimate)`},
      'account')`);
  return { bidPrice: totals.bidPrice };
}
