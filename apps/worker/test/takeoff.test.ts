/**
 * Takeoff scaffold (deck A6). The load-bearing invariant under test: re-derive
 * replaces `source='derived'` lines and NEVER touches `manual` ones — the
 * customer's edits are the product, and a refresh that eats them is data loss
 * wearing a refresh button.
 *
 * Derivation is tested as a pure function; the DB tests get their evidence via
 * loadTakeoffEvidence's canonical-name fallback (a project with no active
 * resolutions reads `lower(canonical_name)`), so no record fixtures needed.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { accountProfiles, type Db } from "@otn/db";
import {
  createPursuit,
  deriveLines,
  getOrCreateTakeoffSheet,
  getTakeoffSheet,
  rederiveSheet,
  addManualLine,
  updateLine,
  sheetTotals,
  stampEstimate,
  TakeoffError,
  updateSheetMeta,
} from "@otn/intelligence";
import { testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toLowerCase();

let db: Db;
let pool: pg.Pool;
let accountId: string;
let projectId: string;
let opportunityId: string;
let pursuitId: string;

beforeAll(async () => {
  ({ db, pool } = await testDb());
  const [acct] = await db
    .insert(accountProfiles)
    .values({
      key: `test_takeoff_${RUN}`,
      name: `Takeoff ${RUN}`,
      active: false,
      capabilitiesJson: [],
      territoryJson: {},
      deliveryConfigJson: {},
    })
    .returning({ id: accountProfiles.id });
  accountId = acct!.id;

  // The canonical name IS the evidence (fallback path) — derivation reads it.
  const proj = await db.execute(sql`
    INSERT INTO projects (canonical_name, permitting_jurisdiction, county, current_stage, first_seen_at, last_seen_at)
    VALUES (${`tenant improvement 4,200 sq ft level 5 finish takeoff-${RUN}`}, 'Test Jurisdiction', 'Pierce', 'permit_applied', now(), now())
    RETURNING id`);
  projectId = (proj.rows[0] as { id: string }).id;
  const opp = await db.execute(sql`
    INSERT INTO opportunities (account_profile_id, project_id, state) VALUES (${accountId}, ${projectId}, 'new')
    RETURNING id`);
  opportunityId = (opp.rows[0] as { id: string }).id;
  pursuitId = (await createPursuit(db, { accountProfileId: accountId, opportunityId, ownerUserId: "test" })).id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM takeoff_lines WHERE sheet_id IN (SELECT id FROM takeoff_sheets WHERE account_profile_id = ${accountId})`);
  await db.execute(sql`DELETE FROM takeoff_sheets WHERE account_profile_id = ${accountId}`);
  await db.execute(sql`DELETE FROM pursuit_notes WHERE pursuit_id = ${pursuitId}`);
  await db.execute(sql`DELETE FROM pursuit_transitions WHERE pursuit_id = ${pursuitId}`);
  await db.execute(sql`DELETE FROM pursuits WHERE id = ${pursuitId}`);
  await db.execute(sql`DELETE FROM opportunities WHERE id = ${opportunityId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM account_profiles WHERE id = ${accountId}`);
  await pool.end();
});

describe("deriveLines (pure)", () => {
  it("extracts a comma-formatted sqft into hang/finish and paint with waste applied", () => {
    const lines = deriveLines({ text: "interior remodel of 4,200 sq ft office", maxValuation: null, maxUnits: null });
    const hang = lines.find((l) => l.assemblyKey === "hang_finish");
    expect(hang).toBeDefined();
    expect(hang!.qty).toBe(Math.round(4200 * 1.1));
    expect(hang!.provenance).toContain("4,200 sq ft");
    expect(lines.some((l) => l.assemblyKey === "paint_walls")).toBe(true);
  });

  it("accepts the bare 'sf' form", () => {
    const lines = deriveLines({ text: "3500 sf warehouse office buildout", maxValuation: null, maxUnits: null });
    expect(lines.find((l) => l.assemblyKey === "hang_finish")!.qty).toBe(Math.round(3500 * 1.1));
  });

  it("falls back to a labelled allowance when only valuation exists — never fabricated quantities", () => {
    const ti = deriveLines({ text: "tenant improvement suite 200", maxValuation: 500_000, maxUnits: null });
    expect(ti).toHaveLength(1);
    expect(ti[0]!.assemblyKey).toBe("scope_allowance");
    expect(ti[0]!.qty).toBe(1);
    expect(ti[0]!.unitCost).toBe(Math.round(500_000 * 0.18));
    expect(ti[0]!.provenance).toContain("estimate");

    const generic = deriveLines({ text: "new dwelling", maxValuation: 500_000, maxUnits: null });
    expect(generic[0]!.unitCost).toBe(Math.round(500_000 * 0.1));
  });

  it("a fire-rated trigger without stated area yields qty 0 flagged for the job walk", () => {
    const lines = deriveLines({ text: "2-hr rated shaftwall corridor", maxValuation: null, maxUnits: null });
    const fr = lines.find((l) => l.assemblyKey === "fire_rated_assembly");
    expect(fr).toBeDefined();
    expect(fr!.qty).toBe(0);
    expect(fr!.provenance).toContain("set from job walk");
  });

  it("returns nothing on empty evidence rather than inventing lines", () => {
    expect(deriveLines({ text: "", maxValuation: null, maxUnits: null })).toEqual([]);
  });
});

describe("sheetTotals", () => {
  it("computes subtotal → overhead → margin to the cent", () => {
    const totals = sheetTotals(
      [
        { qty: 100, unitCost: 2.5, source: "derived" },
        { qty: 10, unitCost: 14, source: "manual" },
      ],
      10,
      20,
    );
    expect(totals.subtotal).toBe(390);
    expect(totals.overhead).toBe(39);
    expect(totals.margin).toBe(85.8); // (390+39) × 20%
    expect(totals.bidPrice).toBe(514.8);
    expect(totals.derivedCount).toBe(1);
    expect(totals.manualCount).toBe(1);
  });
});

describe("sheet lifecycle", () => {
  it("derives from evidence on first call and is idempotent on the second", async () => {
    const first = await getOrCreateTakeoffSheet(db, { id: pursuitId, accountProfileId: accountId, opportunityId });
    // Project name carries sqft + level-5 + TI: hang/paint/level5 expected.
    expect(first.lines.some((l) => l.assemblyKey === "hang_finish")).toBe(true);
    expect(first.lines.some((l) => l.assemblyKey === "level5_skim")).toBe(true);
    expect(first.lines.every((l) => l.source === "derived")).toBe(true);

    const second = await getOrCreateTakeoffSheet(db, { id: pursuitId, accountProfileId: accountId, opportunityId });
    expect(second.id).toBe(first.id);
    expect(second.lines.length).toBe(first.lines.length);
  });

  it("re-derive replaces derived lines and NEVER touches manual ones", async () => {
    const sheet = await getOrCreateTakeoffSheet(db, { id: pursuitId, accountProfileId: accountId, opportunityId });
    const { id: manualId } = await addManualLine(db, sheet.id, { assemblyKey: "doors_frames", qty: 12, unitCost: 90 });
    // Editing a derived line converts it to manual — the estimator's number now.
    const derivedLine = sheet.lines.find((l) => l.source === "derived")!;
    await updateLine(db, sheet.id, derivedLine.id, { qty: 9999 });

    const after = await rederiveSheet(db, { id: pursuitId, opportunityId });
    const manual = after.lines.filter((l) => l.source === "manual");
    expect(manual.some((l) => l.id === manualId && l.qty === 12)).toBe(true);
    expect(manual.some((l) => l.id === derivedLine.id && l.qty === 9999)).toBe(true);
    const editedNowManual = manual.find((l) => l.id === derivedLine.id)!;
    expect(editedNowManual.provenance).toContain("was derived");
    // Fresh derived lines exist and none carry the edited id.
    expect(after.lines.some((l) => l.source === "derived")).toBe(true);
    expect(after.lines.filter((l) => l.source === "derived").every((l) => l.id !== derivedLine.id)).toBe(true);
  });

  it("rejects unknown assemblies and negative quantities at the service boundary", async () => {
    const sheet = await getTakeoffSheet(db, pursuitId);
    await expect(addManualLine(db, sheet!.id, { assemblyKey: "nope", qty: 1 })).rejects.toThrowError(TakeoffError);
    await expect(addManualLine(db, sheet!.id, { assemblyKey: "hang_finish", qty: -5 })).rejects.toThrowError(TakeoffError);
  });

  it("stamps the bid price onto the pursuit with an audit note", async () => {
    const { bidPrice } = await stampEstimate(db, { id: pursuitId }, "test");
    expect(bidPrice).toBeGreaterThan(0);
    const p = await db.execute(sql`SELECT estimated_contract_value FROM pursuits WHERE id = ${pursuitId}`);
    expect(Number((p.rows[0] as { estimated_contract_value: number }).estimated_contract_value)).toBe(bidPrice);
    const notes = await db.execute(
      sql`SELECT body FROM pursuit_notes WHERE pursuit_id = ${pursuitId} AND body LIKE 'takeoff sheet stamped%'`,
    );
    expect(notes.rows.length).toBeGreaterThan(0);
  });

  it("a final sheet refuses re-derive until reopened", async () => {
    const sheet = await getTakeoffSheet(db, pursuitId);
    await updateSheetMeta(db, sheet!.id, { status: "final" });
    await expect(rederiveSheet(db, { id: pursuitId, opportunityId })).rejects.toMatchObject({ code: "sheet_final" });
    await updateSheetMeta(db, sheet!.id, { status: "draft" });
  });
});
