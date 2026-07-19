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
  },
  {
    entityId: OTHER_ENTITY, ubi: "601000001", contractorNumbers: ["OTHERCO999XX"],
    canonicalName: "Other Trades LLC", canonicalNameNormalized: "OTHER TRADES",
    phone: null, cityToken: "tacoma", stateCode: "WA",
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

  it("is idempotent — a second run binds nothing new (bound orgs are skipped)", async () => {
    const summary = await linkRegistry(db, { fetchRows: async () => REGISTRY_ROWS });
    expect(summary.bound).toBe(0);
    // Non-force runs scan only unbound orgs, so the two already-bound orgs are
    // not rescanned; the conflict (still unbound) is re-evaluated every run.
    expect(summary.conflicts).toBe(1);
  });

  it("force re-evaluates bound orgs and rewrites nothing when the binding is unchanged", async () => {
    const summary = await linkRegistry(db, { fetchRows: async () => REGISTRY_ROWS, force: true });
    expect(summary.bound).toBe(0);
    expect(summary.alreadyLinked).toBe(2);
    expect(summary.conflicts).toBe(1);
  });
});
