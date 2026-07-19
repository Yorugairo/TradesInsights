/**
 * Increment 3 + product layers (integration doc) — the reviewed observation
 * loop: deterministic candidate generation from stubbed contract-view rows,
 * top-N review listing, accept side effects (bind org / global contact /
 * queued export), the export push into registry_partner staging (stub writer),
 * and the deterministic per-rule learning signal (reject teaches; a proven
 * rule auto-accepts).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { accountProfiles, organizations, projects, rawArtifacts, sourceRecords, sourceRuns, type Db } from "@otn/db";
import {
  AUTO_ACCEPT_MIN_DECISIONS,
  decideRegistryObservation,
  exportRegistryObservations,
  generateRegistryObservations,
  listRegistryObservations,
  type RegistryIdentityRow,
} from "@otn/resolution";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
let db: Db;
let pool: pg.Pool;
let accountId: string;
let orgId: string;
let projectId: string;

const ENTITY = randomUUID();
const REGISTRY_ROWS: RegistryIdentityRow[] = [
  {
    entityId: ENTITY,
    ubi: "600000001",
    contractorNumbers: [`REGOB${RUN.slice(0, 6)}`],
    canonicalName: `Registry Obs Drywall ${RUN} LLC`,
    canonicalNameNormalized: `REGISTRY OBS DRYWALL ${RUN}`,
    phone: "3605550142",
    cityToken: "olympia",
    stateCode: "WA",
  },
];

/** Stub registry_partner writer capturing every staged row. */
function stubWriter() {
  const staged: { text: string; params: unknown[] }[] = [];
  return {
    staged,
    query: async (text: string, params?: unknown[]) => {
      staged.push({ text, params: params ?? [] });
      return { rows: [] };
    },
  };
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  const [a] = await db.insert(accountProfiles).values({
    key: `test_regobs_${RUN.toLowerCase()}`, name: "regobs", active: true,
    capabilitiesJson: [], territoryJson: {}, deliveryConfigJson: {},
  }).returning({ id: accountProfiles.id });
  accountId = a!.id;

  // An org seen as primary_contractor on a MECHANICAL permit in Olympia —
  // unbound, no UBI (the live-corpus reality), name-matching the registry row.
  const [org] = await db.insert(organizations).values({
    canonicalName: `REGISTRY OBS DRYWALL ${RUN} LLC`, status: "active",
  }).returning({ id: organizations.id });
  orgId = org!.id;

  const [p] = await db.insert(projects).values({
    canonicalName: `REGOBS-${RUN}`, permittingJurisdiction: "Olympia", county: "Thurston",
    currentStage: "permit_issued", firstSeenAt: new Date(), lastSeenAt: new Date(),
  }).returning({ id: projects.id });
  projectId = p!.id;

  const sourceId = await resetSource(db, "fake_source");
  const [run] = await db.insert(sourceRuns).values({ sourceId, status: "succeeded" }).returning({ id: sourceRuns.id });
  const [art] = await db.insert(rawArtifacts).values({
    sourceId, sourceRunId: run!.id, canonicalUrl: `https://example.invalid/regobs/${RUN}`,
    retrievedAt: new Date(), contentType: "text/html", httpStatus: 200,
    storageKey: `raw/fake_source/regobs-${RUN}`, sha256: RUN.padEnd(64, "8").toLowerCase(), byteSize: 8,
    headersJson: {}, parserVersion: "test",
  }).returning({ id: rawArtifacts.id });
  const [rec] = await db.insert(sourceRecords).values({
    sourceId, rawArtifactId: art!.id, externalId: `REGOBS-${RUN}`, recordType: "permit",
    firstSeenAt: new Date(), lastSeenAt: new Date(), rawFieldsJson: {},
    normalizedJson: { title: `REGOBS-${RUN}`, city: "Olympia", permitType: "Mechanical", sourceUrl: "https://example.invalid/p" },
    normalizedFingerprint: `regobs-${RUN}`,
  }).returning({ id: sourceRecords.id });
  await db.execute(sql`
    INSERT INTO project_roles (project_id, organization_id, role, source_record_id, confirmed, confidence, first_seen_at, last_seen_at)
    VALUES (${projectId}, ${orgId}, 'primary_contractor', ${rec!.id}, true, 1, now(), now())`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM registry_observations WHERE organization_id = ${orgId}`);
  await db.execute(sql`DELETE FROM organization_contacts WHERE organization_id = ${orgId}`);
  await db.execute(sql`DELETE FROM project_roles WHERE organization_id = ${orgId}`);
  await deleteTestProjects(db, [projectId]);
  await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`);
  await db.execute(sql`DELETE FROM account_profiles WHERE id = ${accountId}`);
  await pool.end();
});

describe("registry observation loop", () => {
  it("skips visibly with no registry rows", async () => {
    const summary = await generateRegistryObservations(db, null);
    expect(summary.skipped).toBe(true);
  });

  it("generates a binding candidate (name+locality) for the unbound org — never auto-binds", async () => {
    const summary = await generateRegistryObservations(db, REGISTRY_ROWS);
    expect(summary.bindingCandidates).toBe(1);
    expect(summary.autoAccepted).toBe(0);

    const pending = await listRegistryObservations(db, { status: "pending", limit: 10 });
    const bind = pending.find((o) => o.organizationId === orgId && o.observationType === "binding_name_match");
    expect(bind).toBeDefined();
    expect(bind!.trustScore).toBeGreaterThanOrEqual(0.55);
    expect(bind!.trustComponents["name"]).toBe(1); // exact cross-key match
    expect(bind!.trustComponents["locality"]).toBe(1); // olympia seen in org's records
    // The org itself is untouched until a human accepts.
    const [org] = (await db.execute(sql`SELECT registry_ref FROM organizations WHERE id = ${orgId}`)).rows as { registry_ref: string | null }[];
    expect(org!.registry_ref).toBeNull();
  });

  it("accepting the binding binds the org with snapshot + provenance", async () => {
    const pending = await listRegistryObservations(db, { status: "pending", limit: 10 });
    const bind = pending.find((o) => o.organizationId === orgId && o.observationType === "binding_name_match")!;
    const outcome = await decideRegistryObservation(db, bind.id, "accept", { decidedBy: "test:operator" });
    expect(outcome).toEqual({ status: "accepted", applied: "bound_organization" });

    const [org] = (await db.execute(sql`
      SELECT registry_ref, registry_ref_method, registry_identity_json FROM organizations WHERE id = ${orgId}`)).rows as {
      registry_ref: string | null; registry_ref_method: string | null; registry_identity_json: Record<string, unknown> | null;
    }[];
    expect(org!.registry_ref).toBe(ENTITY);
    expect(org!.registry_ref_method).toBe("name_review_confirmed");
    expect(org!.registry_identity_json?.["phone"]).toBe("3605550142");
  });

  it("next pass generates phone adoption + trade evidence for the bound org", async () => {
    const summary = await generateRegistryObservations(db, REGISTRY_ROWS);
    expect(summary.phoneAdoptions).toBe(1);
    expect(summary.tradeExports).toBe(1); // Mechanical permit → 'mechanical'
    // Name and registry canonical agree → no alias variant to teach.
    expect(summary.aliasExports).toBe(0);
  });

  it("accepting phone adoption creates the GLOBAL public-business contact (the customer bucket)", async () => {
    const pending = await listRegistryObservations(db, { status: "pending", limit: 20 });
    const phone = pending.find((o) => o.organizationId === orgId && o.observationType === "phone_adoption")!;
    const outcome = await decideRegistryObservation(db, phone.id, "accept", { decidedBy: "test:operator" });
    expect(outcome.applied).toBe("contact_created");

    const contacts = (await db.execute(sql`
      SELECT account_profile_id, phone, source_type FROM organization_contacts WHERE organization_id = ${orgId}`)).rows as {
      account_profile_id: string | null; phone: string | null; source_type: string;
    }[];
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ account_profile_id: null, phone: "3605550142", source_type: "public_business" });

    // Idempotent: re-accepting the same phone (fresh observation) can't duplicate.
    await db.execute(sql`DELETE FROM registry_observations WHERE dedupe_key = ${"phone:" + orgId + ":3605550142"}`);
    await generateRegistryObservations(db, REGISTRY_ROWS);
    const again = (await listRegistryObservations(db, { status: "pending", limit: 20 })).find(
      (o) => o.organizationId === orgId && o.observationType === "phone_adoption",
    )!;
    await decideRegistryObservation(db, again.id, "accept", { decidedBy: "test:operator" });
    const after = (await db.execute(sql`
      SELECT count(*)::int AS n FROM organization_contacts WHERE organization_id = ${orgId}`)).rows as { n: number }[];
    expect(after[0]!.n).toBe(1);
  });

  it("accepted trade evidence exports to registry_partner staging with review provenance", async () => {
    const pending = await listRegistryObservations(db, { status: "pending", limit: 20 });
    const trade = pending.find((o) => o.organizationId === orgId && o.observationType === "trade_export")!;
    expect(trade.payload["trade_code"]).toBe("mechanical");
    const outcome = await decideRegistryObservation(db, trade.id, "accept", { decidedBy: "test:operator" });
    expect(outcome.applied).toBe("queued_for_export");

    const writer = stubWriter();
    const summary = await exportRegistryObservations(db, writer);
    expect(summary.observationsExported).toBe(1);
    expect(summary.projectFactsExported).toBeGreaterThanOrEqual(1);
    const obsInsert = writer.staged.find((s) => s.text.includes("partner_observations"))!;
    expect(obsInsert.params[0]).toBe("otn_insights");
    expect(obsInsert.params[1]).toBe(ENTITY);
    expect(obsInsert.params[2]).toBe("trade_evidence");
    expect(obsInsert.params[5]).toBe("test:operator"); // reviewed_by travels with the row
    const factsInsert = writer.staged.find((s) => s.text.includes("partner_project_facts"))!;
    const facts = JSON.parse(String(factsInsert.params[2])) as { project_count: number; counties: string[] };
    expect(facts.project_count).toBe(1);
    expect(facts.counties).toContain("Thurston");

    // Exported exactly once — a second export pushes nothing.
    const writer2 = stubWriter();
    const second = await exportRegistryObservations(db, writer2);
    expect(second.observationsExported).toBe(0);
  });

  it("export skips visibly without a registry writer", async () => {
    const summary = await exportRegistryObservations(db, null);
    expect(summary.skipped).toBe(true);
  });

  it("rejects teach the rule history; a proven rule earns auto-accept (never for bindings)", async () => {
    // Seed a decided history for the phone rule at a 100% accept rate.
    for (let i = 0; i < AUTO_ACCEPT_MIN_DECISIONS; i++) {
      await db.execute(sql`
        INSERT INTO registry_observations
          (observation_type, organization_id, registry_entity_id, rule_key, payload_json,
           trust_score, trust_components_json, dedupe_key, status, decided_by, decided_at)
        VALUES ('phone_adoption', ${orgId}, ${ENTITY}, 'phone_from_lni', '{}', 0.9, '{}',
          ${`seed:${RUN}:${i}`}, 'accepted', 'test:operator', now())`);
    }
    // A fresh phone observation for this rule now auto-accepts (with provenance)…
    await db.execute(sql`DELETE FROM registry_observations WHERE dedupe_key = ${"phone:" + orgId + ":3605550142"}`);
    await db.execute(sql`DELETE FROM organization_contacts WHERE organization_id = ${orgId}`);
    const summary = await generateRegistryObservations(db, REGISTRY_ROWS);
    expect(summary.autoAccepted).toBeGreaterThanOrEqual(1);
    const auto = (await db.execute(sql`
      SELECT status, decided_by FROM registry_observations
      WHERE dedupe_key = ${"phone:" + orgId + ":3605550142"}`)).rows as { status: string; decided_by: string }[];
    expect(auto[0]).toMatchObject({ status: "accepted", decided_by: "auto:rule-history" });

    // …while binding candidates NEVER auto-accept, whatever their rule history.
    await db.execute(sql`
      UPDATE organizations SET registry_ref = NULL, registry_ref_method = NULL,
        registry_linked_at = NULL, registry_identity_json = NULL WHERE id = ${orgId}`);
    await db.execute(sql`DELETE FROM registry_observations WHERE dedupe_key = ${"bind:" + orgId + ":" + ENTITY}`);
    for (let i = 0; i < AUTO_ACCEPT_MIN_DECISIONS; i++) {
      await db.execute(sql`
        INSERT INTO registry_observations
          (observation_type, organization_id, registry_entity_id, rule_key, payload_json,
           trust_score, trust_components_json, dedupe_key, status, decided_by, decided_at)
        VALUES ('binding_name_match', ${orgId}, ${ENTITY}, 'binding_name_exact', '{}', 0.9, '{}',
          ${`seedbind:${RUN}:${i}`}, 'accepted', 'test:operator', now())`);
    }
    const regen = await generateRegistryObservations(db, REGISTRY_ROWS);
    expect(regen.bindingCandidates).toBe(1);
    const bind = (await db.execute(sql`
      SELECT status FROM registry_observations WHERE dedupe_key = ${"bind:" + orgId + ":" + ENTITY}`)).rows as { status: string }[];
    expect(bind[0]!.status).toBe("pending");

    // And the learning signal is visible in the trust score: the proven rule's
    // ruleHistory component beats the unreviewed 0.5 prior.
    const pendingBind = (await listRegistryObservations(db, { status: "pending", limit: 20 })).find(
      (o) => o.organizationId === orgId && o.observationType === "binding_name_match",
    )!;
    expect(pendingBind.trustComponents["ruleHistory"]).toBeGreaterThan(0.5);
  });
});
