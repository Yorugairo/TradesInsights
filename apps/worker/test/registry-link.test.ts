/**
 * Integration seam (docs/integration-one-trade-network.md, Parts B & D) —
 * linkRegistry binds Insights organizations to canonical registry entities by
 * strong identifier, idempotently, and reports a visible skip when no registry
 * connection is configured. Uses a stubbed fetchRows (a real contract-view row
 * shape) so the test needs no live registry.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { organizations, type Db } from "@otn/db";
import { linkRegistry, type RegistryIdentityRow } from "@otn/resolution";
import { testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
let db: Db;
let pool: pg.Pool;
let solisId: string;
let cnOnlyId: string;
let conflictId: string;
let unknownId: string;

// Live contract-view shape for Solis (ubi 604837560, contractor SOLISIL785NT).
const SOLIS_ENTITY = "8a12a7cb-fb4b-4418-8378-def585ef88ff";
const OTHER_ENTITY = randomUUID();
const REGISTRY_ROWS: RegistryIdentityRow[] = [
  {
    entityId: SOLIS_ENTITY, ubi: "604837560", contractorNumbers: ["SOLISIL785NT"],
    canonicalName: "Solis Interiors LLC", canonicalNameNormalized: "SOLIS INTERIORS",
    phone: "3603508616", cityToken: "olympia", stateCode: "WA",
    registeredAddress: null, registeredPostalCode: null,
    // WS-B enriched contract columns (secondary Google channel + L&I trade codes).
    googlePhone: "3603509999", googleRating: 4.7, googleReviewCount: 33,
    tradeCodes: ["drywall", "painting"],
  },
  {
    entityId: OTHER_ENTITY, ubi: "601000001", contractorNumbers: ["OTHERCO999XX"],
    canonicalName: "Other Trades LLC", canonicalNameNormalized: "OTHER TRADES",
    phone: null, cityToken: "tacoma", stateCode: "WA",
    registeredAddress: null, registeredPostalCode: null,
  },
];

async function mkOrg(name: string, ubi: string | null, cn: string | null): Promise<string> {
  const [o] = await db
    .insert(organizations)
    .values({ canonicalName: `${name} ${RUN}`, status: "active", ubi, contractorRegistration: cn })
    .returning({ id: organizations.id });
  return o!.id;
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  solisId = await mkOrg("Solis Interiors LLC", "604-837-560", null);      // UBI (formatted) → Solis
  cnOnlyId = await mkOrg("Other Trades", null, "otherco999xx");           // contractor-only → Other
  conflictId = await mkOrg("Conflicted Co", "604837560", "OTHERCO999XX"); // UBI≠contractor → conflict
  unknownId = await mkOrg("No Registry Match", "999999999", null);        // no match
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM organizations WHERE canonical_name LIKE ${"%" + RUN}`);
  await pool.end();
});

describe("linkRegistry", () => {
  it("skips with a visible flag when no registry connection is available", async () => {
    const summary = await linkRegistry(db, { fetchRows: async () => null });
    expect(summary.skipped).toBe(true);
    expect(summary.bound).toBe(0);
    const [row] = (await db.execute(sql`SELECT registry_ref FROM organizations WHERE id = ${solisId}`)).rows as { registry_ref: string | null }[];
    expect(row!.registry_ref).toBeNull();
  });

  it("binds by strong identifier, records provenance, and leaves conflicts/unknowns unbound", async () => {
    const summary = await linkRegistry(db, { fetchRows: async () => REGISTRY_ROWS });
    expect(summary.skipped).toBe(false);
    expect(summary.bound).toBe(2);
    expect(summary.byMethod).toEqual({ ubi_exact: 1, contractor_number_exact: 1 });
    expect(summary.conflicts).toBe(1);

    const rows = (await db.execute(sql`
      SELECT id, registry_ref, registry_ref_method, registry_linked_at FROM organizations
      WHERE id IN (${solisId}, ${cnOnlyId}, ${conflictId}, ${unknownId})`)).rows as {
      id: string; registry_ref: string | null; registry_ref_method: string | null; registry_linked_at: string | null;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(solisId)).toMatchObject({ registry_ref: SOLIS_ENTITY, registry_ref_method: "ubi_exact" });
    expect(byId.get(solisId)!.registry_linked_at).not.toBeNull();
    expect(byId.get(cnOnlyId)).toMatchObject({ registry_ref: OTHER_ENTITY, registry_ref_method: "contractor_number_exact" });
    expect(byId.get(conflictId)!.registry_ref).toBeNull();  // conflict never auto-binds
    expect(byId.get(unknownId)!.registry_ref).toBeNull();
  });

  it("caches the WS-B enriched contract fields (google + trade codes) in the identity snapshot", async () => {
    const [row] = (await db.execute(sql`
      SELECT registry_identity_json FROM organizations WHERE id = ${solisId}`)).rows as {
      registry_identity_json: Record<string, unknown> | null;
    }[];
    const snap = row!.registry_identity_json;
    expect(snap?.["google_phone"]).toBe("3603509999");
    expect(snap?.["google_rating"]).toBe(4.7);
    expect(snap?.["google_review_count"]).toBe(33);
    expect(snap?.["trade_codes"]).toEqual(["drywall", "painting"]);
    // L&I phone stays the authoritative `phone` key — Google never overwrites it.
    expect(snap?.["phone"]).toBe("3603508616");
  });

  it("is idempotent — a second run binds nothing new (bound orgs are skipped)", async () => {
    const summary = await linkRegistry(db, { fetchRows: async () => REGISTRY_ROWS });
    expect(summary.bound).toBe(0);
    // Non-force runs scan only unbound orgs, so the two already-bound orgs are
    // not rescanned; the conflict (still unbound) is re-evaluated every run.
    expect(summary.conflicts).toBe(1);
  });

  it("force re-evaluates bound orgs and rewrites nothing when the binding is unchanged", async () => {
    const summary = await linkRegistry(db, { fetchRows: async () => REGISTRY_ROWS, force: true });
    expect(summary.bound).toBe(0); // nothing NEW bound — force rewrote nothing
    // force re-scans EVERY bound org in the table (global), so alreadyLinked counts
    // this test's 2 PLUS any bound orgs already in the corpus (e.g. a seeded Solis
    // binding). Assert "≥ our 2 re-evaluated" rather than an exact global count.
    expect(summary.alreadyLinked).toBeGreaterThanOrEqual(2);
    // This test's own two orgs stay bound to the same refs (force rewrote nothing).
    const rows = (await db.execute(sql`
      SELECT id, registry_ref FROM organizations WHERE id IN (${solisId}, ${cnOnlyId})`)).rows as {
      id: string; registry_ref: string | null;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r.registry_ref]));
    expect(byId.get(solisId)).toBe(SOLIS_ENTITY);
    expect(byId.get(cnOnlyId)).toBe(OTHER_ENTITY);
    expect(summary.conflicts).toBe(1);
  });
});
