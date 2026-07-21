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
  persistOrganizationIdentifiers,
  type RegistryIdentityRow,
} from "@otn/resolution";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
let db: Db;
let pool: pg.Pool;
let accountId: string;
let orgId: string;
let org2Id: string;
let projectId: string;
let recId: string;

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
    registeredAddress: null,
    registeredPostalCode: null,
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
  recId = rec!.id;
  await db.execute(sql`
    INSERT INTO project_roles (project_id, organization_id, role, source_record_id, confirmed, confidence, first_seen_at, last_seen_at)
    VALUES (${projectId}, ${orgId}, 'primary_contractor', ${rec!.id}, true, 1, now(), now())`);

  // A second org whose name does NOT key-match its registry entity, but whose
  // permit-published phone does (the phone-match path).
  const [org2] = await db.insert(organizations).values({
    canonicalName: `NW DRYWALL AND PAINT ${RUN}`, status: "active",
  }).returning({ id: organizations.id });
  org2Id = org2!.id;
  await db.execute(sql`
    INSERT INTO project_roles (project_id, organization_id, role, source_record_id, confirmed, confidence, first_seen_at, last_seen_at)
    VALUES (${projectId}, ${org2Id}, 'primary_contractor', ${recId}, true, 1, now(), now())`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM registry_observations WHERE organization_id IN (${orgId}, ${org2Id})`);
  await db.execute(sql`DELETE FROM organization_identifiers WHERE organization_id IN (${orgId}, ${org2Id})`);
  await db.execute(sql`DELETE FROM organization_contacts WHERE organization_id IN (${orgId}, ${org2Id})`);
  await db.execute(sql`DELETE FROM project_roles WHERE organization_id IN (${orgId}, ${org2Id})`);
  await deleteTestProjects(db, [projectId]);
  await db.execute(sql`DELETE FROM organizations WHERE id IN (${orgId}, ${org2Id})`);
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

  it("permit-published identifiers persist with evidence and backfeed strong keys", async () => {
    const res = await persistOrganizationIdentifiers(db, org2Id, recId, {
      phone: "(253) 555-0177",
      ubi: "601-999-888", // formatted; normalizes to 601999888
    });
    expect(res.upserted).toBe(2);
    const ids = (await db.execute(sql`
      SELECT identifier_type, value_normalized, source_record_id FROM organization_identifiers
      WHERE organization_id = ${org2Id} ORDER BY identifier_type`)).rows as {
      identifier_type: string; value_normalized: string; source_record_id: string;
    }[];
    expect(ids.map((i) => [i.identifier_type, i.value_normalized])).toEqual([
      ["phone", "2535550177"],
      ["ubi", "601999888"],
    ]);
    expect(ids.every((i) => i.source_record_id === recId)).toBe(true); // no claim without a source
    // Strong-key backfeed: the org row now carries the UBI for the nightly
    // strong-key registry link (never overwrites an existing value).
    const [org] = (await db.execute(sql`SELECT ubi FROM organizations WHERE id = ${org2Id}`)).rows as { ubi: string | null }[];
    expect(org!.ubi).toBe("601999888");
  });

  it("phone-exact against the registry's L&I phone yields a binding_phone_match candidate", async () => {
    const ENTITY2 = randomUUID();
    const rowsWithPhone: RegistryIdentityRow[] = [
      ...REGISTRY_ROWS,
      {
        entityId: ENTITY2, ubi: "601777666", contractorNumbers: [`NWDRY${RUN.slice(0, 5)}`],
        canonicalName: `NW Drywall ${RUN} LLC`, canonicalNameNormalized: `NW DRYWALL ${RUN}`,
        phone: "2535550177", cityToken: "puyallup", stateCode: "WA",
        registeredAddress: null, registeredPostalCode: null,
      },
    ];
    const summary = await generateRegistryObservations(db, rowsWithPhone);
    expect(summary.bindingCandidates).toBe(1); // org2 via phone; org1's is deduped

    const cand = (await listRegistryObservations(db, { status: "pending", limit: 30 })).find(
      (o) => o.organizationId === org2Id && o.observationType === "binding_name_match",
    )!;
    expect(cand.ruleKey).toBe("binding_phone_match");
    expect(cand.trustComponents["identifier"]).toBe(1); // phone agrees with L&I
    expect(cand.trustComponents["name"]).toBeGreaterThanOrEqual(0.3); // similarity floor
    expect(cand.trustComponents["name"]).toBeLessThan(1); // not a name-key match
    expect(cand.payload["phone_agrees"]).toBe(true);
    expect(cand.payload["registry_phone"]).toBe("2535550177");

    // Still review-gated: accepting binds org2 to the phone-matched entity.
    const outcome = await decideRegistryObservation(db, cand.id, "accept", { decidedBy: "test:operator" });
    expect(outcome.applied).toBe("bound_organization");
    const [org] = (await db.execute(sql`
      SELECT registry_ref, registry_ref_method FROM organizations WHERE id = ${org2Id}`)).rows as {
      registry_ref: string; registry_ref_method: string;
    }[];
    expect(org!.registry_ref).toBe(ENTITY2);
    expect(org!.registry_ref_method).toBe("name_review_confirmed");
  });
});

/**
 * WS-B — google_phone adoption: a bound entity whose L&I `phone` is ABSENT but
 * whose Google Business profile carries a phone. The Google phone is a SECONDARY
 * channel — adopted only when there is no L&I phone (L&I stays authoritative),
 * under a DISTINCT rule key so it earns its own reviewed accept history.
 */
describe("google_phone adoption (L&I phone absent — secondary channel)", () => {
  const GRUN = randomUUID().slice(0, 8).toUpperCase();
  let gdb: Db;
  let gpool: pg.Pool;
  let gAccountId: string;
  let gOrgId: string;
  let gProjectId: string;
  let gRecId: string;
  let gArtId: string;
  let gRunId: string;
  const G_ENTITY = randomUUID();
  const G_GOOGLE_PHONE = "3609990000";
  const rows: RegistryIdentityRow[] = [
    {
      entityId: G_ENTITY,
      ubi: "601234567",
      contractorNumbers: [`GDRY${GRUN.slice(0, 5)}`],
      canonicalName: `Google Only Drywall ${GRUN} LLC`,
      canonicalNameNormalized: `GOOGLE ONLY DRYWALL ${GRUN}`,
      phone: null, // L&I phone ABSENT — the google branch is the only phone to adopt
      googlePhone: G_GOOGLE_PHONE,
      cityToken: "lacey",
      stateCode: "WA",
      registeredAddress: null,
      registeredPostalCode: null,
      tradeCodes: ["drywall"],
    },
  ];

  beforeAll(async () => {
    ({ db: gdb, pool: gpool } = await testDb());
    const [a] = await gdb.insert(accountProfiles).values({
      key: `test_gphone_${GRUN.toLowerCase()}`, name: "gphone", active: true,
      capabilitiesJson: [], territoryJson: {}, deliveryConfigJson: {},
    }).returning({ id: accountProfiles.id });
    gAccountId = a!.id;

    // Pre-bound org (registry_ref set) → the BOUND-org phone-adoption path runs.
    const [o] = await gdb.insert(organizations).values({
      canonicalName: `Google Only Drywall ${GRUN} LLC`, status: "active", registryRef: G_ENTITY,
    }).returning({ id: organizations.id });
    gOrgId = o!.id;

    // Reuse the shared fake_source WITHOUT the destructive resetSource() — its
    // cross-cutting delete of source_records trips FKs from sibling tests'
    // organization_identifiers (ambient corpus state). The file's top suite has
    // already created fake_source; a fresh artifact/record under it is enough.
    const [src] = (await gdb.execute(sql`SELECT id FROM sources WHERE key = 'fake_source' LIMIT 1`)).rows as { id: string }[];
    const sourceId = src?.id ?? (await resetSource(gdb, "fake_source"));
    const [run] = await gdb.insert(sourceRuns).values({ sourceId, status: "succeeded" }).returning({ id: sourceRuns.id });
    gRunId = run!.id;
    const [art] = await gdb.insert(rawArtifacts).values({
      sourceId, sourceRunId: run!.id, canonicalUrl: `https://example.invalid/gphone/${GRUN}`,
      retrievedAt: new Date(), contentType: "text/html", httpStatus: 200,
      storageKey: `raw/fake_source/gphone-${GRUN}`, sha256: GRUN.padEnd(64, "9").toLowerCase(), byteSize: 9,
      headersJson: {}, parserVersion: "test",
    }).returning({ id: rawArtifacts.id });
    gArtId = art!.id;
    const [rec] = await gdb.insert(sourceRecords).values({
      sourceId, rawArtifactId: art!.id, externalId: `GPHONE-${GRUN}`, recordType: "permit",
      firstSeenAt: new Date(), lastSeenAt: new Date(), rawFieldsJson: {},
      normalizedJson: { title: `GPHONE-${GRUN}`, city: "Lacey", permitType: "Drywall", sourceUrl: "https://example.invalid/p" },
      normalizedFingerprint: `gphone-${GRUN}`,
    }).returning({ id: sourceRecords.id });
    gRecId = rec!.id;
    const [p] = await gdb.insert(projects).values({
      canonicalName: `GPHONE-${GRUN}`, permittingJurisdiction: "Lacey", county: "Thurston",
      currentStage: "permit_issued", firstSeenAt: new Date(), lastSeenAt: new Date(),
    }).returning({ id: projects.id });
    gProjectId = p!.id;
    await gdb.execute(sql`
      INSERT INTO project_roles (project_id, organization_id, role, source_record_id, confirmed, confidence, first_seen_at, last_seen_at)
      VALUES (${gProjectId}, ${gOrgId}, 'primary_contractor', ${gRecId}, true, 1, now(), now())`);
  });

  afterAll(async () => {
    await gdb.execute(sql`DELETE FROM registry_observations WHERE organization_id = ${gOrgId}`);
    await gdb.execute(sql`DELETE FROM organization_contacts WHERE organization_id = ${gOrgId}`);
    await gdb.execute(sql`DELETE FROM project_roles WHERE organization_id = ${gOrgId}`);
    await deleteTestProjects(gdb, [gProjectId]);
    // Only our own fake_source rows (never the shared source itself).
    await gdb.execute(sql`DELETE FROM source_records WHERE id = ${gRecId}`);
    await gdb.execute(sql`DELETE FROM raw_artifacts WHERE id = ${gArtId}`);
    await gdb.execute(sql`DELETE FROM source_runs WHERE id = ${gRunId}`);
    await gdb.execute(sql`DELETE FROM organizations WHERE id = ${gOrgId}`);
    await gdb.execute(sql`DELETE FROM account_profiles WHERE id = ${gAccountId}`);
    await gpool.end();
  });

  it("adopts the Google phone as a phone_adoption when the L&I phone is absent", async () => {
    const summary = await generateRegistryObservations(gdb, rows);
    expect(summary.phoneAdoptions).toBe(1);
    const phone = (await listRegistryObservations(gdb, { status: "pending", limit: 20 })).find(
      (o) => o.organizationId === gOrgId && o.observationType === "phone_adoption",
    )!;
    expect(phone.ruleKey).toBe("phone_from_google");
    expect(phone.payload["phone"]).toBe(G_GOOGLE_PHONE);
    expect(phone.payload["role"]).toBe("Google Business phone");
  });

  it("accepting creates the GLOBAL public-business contact with the Google role; idempotent", async () => {
    const phone = (await listRegistryObservations(gdb, { status: "pending", limit: 20 })).find(
      (o) => o.organizationId === gOrgId && o.observationType === "phone_adoption",
    )!;
    const outcome = await decideRegistryObservation(gdb, phone.id, "accept", { decidedBy: "test:operator" });
    expect(outcome.applied).toBe("contact_created");
    const contacts = (await gdb.execute(sql`
      SELECT account_profile_id, phone, role, source_type FROM organization_contacts WHERE organization_id = ${gOrgId}`)).rows as {
      account_profile_id: string | null; phone: string; role: string; source_type: string;
    }[];
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      account_profile_id: null, phone: G_GOOGLE_PHONE, role: "Google Business phone", source_type: "public_business",
    });

    // Idempotent: a fresh observation for the same phone cannot duplicate.
    await gdb.execute(sql`DELETE FROM registry_observations WHERE dedupe_key = ${"phone:" + gOrgId + ":" + G_GOOGLE_PHONE}`);
    await generateRegistryObservations(gdb, rows);
    const again = (await listRegistryObservations(gdb, { status: "pending", limit: 20 })).find(
      (o) => o.organizationId === gOrgId && o.observationType === "phone_adoption",
    )!;
    await decideRegistryObservation(gdb, again.id, "accept", { decidedBy: "test:operator" });
    const after = (await gdb.execute(sql`
      SELECT count(*)::int AS n FROM organization_contacts WHERE organization_id = ${gOrgId}`)).rows as { n: number }[];
    expect(after[0]!.n).toBe(1);
  });

  it("does NOT adopt the Google phone when the L&I phone is present (L&I authoritative)", async () => {
    const withLni: RegistryIdentityRow[] = [{ ...rows[0]!, phone: "3601112222" }];
    await gdb.execute(sql`
      DELETE FROM registry_observations WHERE organization_id = ${gOrgId} AND observation_type = 'phone_adoption'`);
    await generateRegistryObservations(gdb, withLni);
    // Query status-agnostically: 'phone_from_lni' may auto-accept off proven rule
    // history in the shared corpus, so filtering to pending would miss it.
    const adoptions = (
      await gdb.execute(sql`
        SELECT rule_key, payload_json FROM registry_observations
        WHERE organization_id = ${gOrgId} AND observation_type = 'phone_adoption'`)
    ).rows as { rule_key: string; payload_json: Record<string, unknown> }[];
    // Exactly the L&I phone is adopted; the Google phone is never a second contact.
    expect(adoptions).toHaveLength(1);
    expect(adoptions[0]!.rule_key).toBe("phone_from_lni");
    expect(adoptions[0]!.payload_json["phone"]).toBe("3601112222");
  });
});
