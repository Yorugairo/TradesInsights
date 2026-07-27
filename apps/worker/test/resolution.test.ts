/**
 * M2.2 — resolver passes 1–3 (spec §10, §19 "same project across SEPA, local
 * notice, and permit"). Runs against the real Postgres from docker compose.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import {
  organizations,
  projectEvents,
  projectExternalIds,
  projects,
  rawArtifacts,
  recordResolutions,
  resolutionReviews,
  sourceRecords,
  sourceRuns,
  sources,
  type Db,
} from "@otn/db";
import type { NormalizedSourceRecord } from "@otn/domain";
import {
  crossNameKey,
  findBoundOrganizationByStrongKey,
  loadOrganizationAliases,
  persistOrganizationAlias,
  persistOrganizationIdentifiers,
  RESOLVER_VERSION,
  resolveRecord,
  type ResolutionOutcome,
} from "@otn/resolution";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let artifactId: string;
const createdProjects = new Set<string>();

async function resolveTracked(row: Parameters<typeof resolveRecord>[1]): Promise<ResolutionOutcome> {
  const outcome = await resolveRecord(db, row);
  if (outcome.projectId) createdProjects.add(outcome.projectId);
  return outcome;
}

// Unique per test run so leftover graph rows from prior runs can't collide.
const RUN = randomUUID().slice(0, 8).toUpperCase();
const PARCEL = `9${RUN.replace(/\D/g, "0").padEnd(10, "7")}`.slice(0, 11);

function record(overrides: Partial<NormalizedSourceRecord>): NormalizedSourceRecord {
  return {
    sourceKey: "fake_source",
    externalId: "X",
    recordType: "planning_application",
    title: "X",
    description: null,
    permittingJurisdiction: "Test Jurisdiction",
    county: "Thurston",
    city: null,
    addressRaw: null,
    parcelIds: [],
    geometry: null,
    applicationType: null,
    permitType: null,
    documentType: null,
    statusRaw: null,
    normalizedStage: "unknown",
    applicationDate: null,
    issueDate: null,
    sourceUpdatedAt: null,
    valuationUsd: null,
    units: null,
    lots: null,
    squareFeet: null,
    organizations: [],
    sourceUrl: "https://example.invalid/x",
    evidence: [],
    ...overrides,
  };
}

async function insertRecord(
  normalized: NormalizedSourceRecord,
  rawFields: Record<string, unknown>,
  firstSeenAt: Date,
): Promise<{ id: string; normalized: NormalizedSourceRecord; rawFields: Record<string, unknown>; firstSeenAt: Date }> {
  const [row] = await db
    .insert(sourceRecords)
    .values({
      sourceId,
      rawArtifactId: artifactId,
      externalId: normalized.externalId,
      recordType: normalized.recordType,
      firstSeenAt,
      lastSeenAt: firstSeenAt,
      rawFieldsJson: rawFields,
      normalizedJson: normalized,
      normalizedFingerprint: `test-${normalized.externalId}-${RUN}`,
    })
    .returning({ id: sourceRecords.id });
  return { id: row!.id, normalized, rawFields, firstSeenAt };
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  sourceId = await resetSource(db, "fake_source");
  const [run] = await db
    .insert(sourceRuns)
    .values({ sourceId, status: "succeeded" })
    .returning({ id: sourceRuns.id });
  const [artifact] = await db
    .insert(rawArtifacts)
    .values({
      sourceId,
      sourceRunId: run!.id,
      canonicalUrl: `https://example.invalid/resolution-test/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/resolution-test-${RUN}`,
      sha256: RUN.padEnd(64, "0").toLowerCase(),
      byteSize: 2,
      headersJson: {},
      parserVersion: "test",
    })
    .returning({ id: rawArtifacts.id });
  artifactId = artifact!.id;
});

afterAll(async () => {
  await deleteTestProjects(db, [...createdProjects]);
  await pool.end();
});

describe("WS-B.4 — findBoundOrganizationByStrongKey (registry_ref dedup key)", () => {
  it("returns a registry-bound org sharing a normalized strong key; null for unbound / no key", async () => {
    const ubi = `7${RUN.replace(/[^0-9]/g, "0")}`; // run-unique test UBI (>= 7 chars)
    const boundRef = `b4b4b4b4-0000-0000-0000-${RUN.toLowerCase().padEnd(12, "0").slice(0, 12)}`;
    const unboundUbi = `8${RUN.replace(/[^0-9]/g, "0")}`;
    // The collapse key is the per-BRAND contractor licence, not the UBI.
    const lic = `RIVERAB${RUN.slice(0, 5)}`;
    const unboundLic = `PAINTWK${RUN.slice(0, 5)}`;
    // A source record to attribute the identifiers to (FK; never resolved).
    const sr = await insertRecord(
      record({ externalId: `B4SR-${RUN}` }),
      {},
      new Date("2026-07-02T00:00:00Z"),
    );
    const [bound] = await db
      .insert(organizations)
      .values({ canonicalName: `RIVERA BUILDERS ${RUN}`, registryRef: boundRef })
      .returning({ id: organizations.id });
    const [unbound] = await db
      .insert(organizations)
      .values({ canonicalName: `PAINTED WORKS ${RUN}` })
      .returning({ id: organizations.id });
    try {
      // Persisted the real way so the finder is tested against the actual normalization.
      await persistOrganizationIdentifiers(db, bound!.id, sr.id, { ubi, contractorLicense: lic });
      await persistOrganizationIdentifiers(db, unbound!.id, sr.id, {
        ubi: unboundUbi,
        contractorLicense: unboundLic,
      });

      // Matches the bound org by a shared LICENCE, normalized the same way
      // (spaces stripped).
      expect(await findBoundOrganizationByStrongKey(db, null, `  ${lic}  `)).toBe(bound!.id);
      // Gated to registry_ref IS NOT NULL — an unbound org sharing a key is never collapsed onto.
      expect(await findBoundOrganizationByStrongKey(db, null, unboundLic)).toBeNull();
      // No strong key ⇒ null.
      expect(await findBoundOrganizationByStrongKey(db, null, null)).toBeNull();
      // A UBI must NEVER collapse two orgs: it identifies the LEGAL ENTITY, and
      // one entity trades under several brands. Collapsing on it fused Apollo
      // Sheet Metal into Apollo Mechanical Contractors. Brands still roll up
      // together via their shared registry_ref (see enterpriseRollup).
      expect(await findBoundOrganizationByStrongKey(db, ubi, null)).toBeNull();
    } finally {
      await db.execute(
        sql`DELETE FROM organization_identifiers WHERE organization_id IN (${bound!.id}, ${unbound!.id})`,
      );
      await db.delete(organizations).where(inArray(organizations.id, [bound!.id, unbound!.id]));
      await db.execute(sql`DELETE FROM source_records WHERE id = ${sr.id}`);
    }
  });
});

describe("organization alias capture (migration 0031 — the name arm of the identity graph)", () => {
  it("captures a genuine name variant when collapsing onto a bound org, and skips a same-key restatement", async () => {
    const ubi = `9${RUN.replace(/[^0-9]/g, "0")}`;
    // The collapse key is the LICENCE, not the UBI: a UBI is the legal entity
    // and one entity trades under several brands, so collapsing on it would
    // fuse sibling brands (see findBoundOrganizationByStrongKey).
    const lic = `SWPLUM${RUN.slice(0, 6)}`;
    const boundRef = `a11a5000-0000-0000-0000-${RUN.toLowerCase().padEnd(12, "0").slice(0, 12)}`;
    // recordType 'inspection' keeps these fixtures out of the provenance test's
    // record census below, which counts the four project-forming types.
    const seed = await insertRecord(
      record({ externalId: `ALSEED-${RUN}`, recordType: "inspection" }),
      {},
      new Date("2026-07-03T00:00:00Z"),
    );
    const [bound] = await db
      .insert(organizations)
      .values({ canonicalName: `SOUTHWEST PLUMBING ${RUN}`, registryRef: boundRef })
      .returning({ id: organizations.id });
    const orgId = bound!.id;
    try {
      await persistOrganizationIdentifiers(db, orgId, seed.id, { ubi, contractorLicense: lic });

      // A later record names the SAME entity (same UBI) under a different name.
      // The resolver collapses it onto the bound org — and that discarded name
      // is exactly what the binding matcher needs as a key.
      const variant = await insertRecord(
        record({
          externalId: `ALVAR-${RUN}`,
          recordType: "inspection",
          organizations: [
            {
              name: `SW Plumbing & Heating ${RUN}`,
              role: "primary_contractor",
              ubi,
              contractorLicense: lic,
              evidenceText: `Contractor: SW Plumbing & Heating ${RUN} (UBI ${ubi})`,
            },
          ],
        }),
        {},
        new Date("2026-07-04T00:00:00Z"),
      );
      await resolveTracked({ ...variant, sourceId });

      const after = await db.execute(
        sql`SELECT alias, source_id FROM organization_aliases WHERE organization_id = ${orgId}`,
      );
      expect(after.rows).toHaveLength(1);
      expect((after.rows[0] as { alias: string }).alias).toBe(`SW Plumbing & Heating ${RUN}`);
      // Provenance travels with the alias — the source that published the name.
      expect((after.rows[0] as { source_id: string | null }).source_id).toBe(sourceId);

      // A name that folds to the SAME cross-system key is not a new match key
      // (legal suffixes are stripped), so it must not be stored as noise.
      const restated = await insertRecord(
        record({
          externalId: `ALSAME-${RUN}`,
          recordType: "inspection",
          organizations: [
            {
              name: `Southwest Plumbing ${RUN} LLC`,
              role: "primary_contractor",
              ubi,
              contractorLicense: lic,
              evidenceText: `Contractor: Southwest Plumbing ${RUN} LLC (UBI ${ubi})`,
            },
          ],
        }),
        {},
        new Date("2026-07-05T00:00:00Z"),
      );
      await resolveTracked({ ...restated, sourceId });
      const stillOne = await db.execute(
        sql`SELECT count(*)::int AS n FROM organization_aliases WHERE organization_id = ${orgId}`,
      );
      expect((stillOne.rows[0] as { n: number }).n).toBe(1);

      // Idempotent: re-persisting a known alias reports no new row.
      expect(
        await persistOrganizationAlias(db, orgId, `SW Plumbing & Heating ${RUN}`, sourceId),
      ).toBe(false);

      // Loaded aliases are folded to the cross-system match key the registry
      // name index is built on, so they can be looked up directly.
      const loaded = await loadOrganizationAliases(db);
      expect(loaded.get(orgId)).toEqual(new Set([crossNameKey(`SW Plumbing & Heating ${RUN}`)]));
    } finally {
      await db.execute(sql`DELETE FROM organization_aliases WHERE organization_id = ${orgId}`);
      await db.execute(sql`DELETE FROM organization_identifiers WHERE organization_id = ${orgId}`);
      await db.execute(sql`DELETE FROM project_roles WHERE organization_id = ${orgId}`);
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
  });

  it("stores nothing for an empty or whitespace-only alias", async () => {
    const [org] = await db
      .insert(organizations)
      .values({ canonicalName: `BLANK ALIAS ${RUN}` })
      .returning({ id: organizations.id });
    try {
      expect(await persistOrganizationAlias(db, org!.id, "   ", null)).toBe(false);
      const res = await db.execute(
        sql`SELECT count(*)::int AS n FROM organization_aliases WHERE organization_id = ${org!.id}`,
      );
      expect((res.rows[0] as { n: number }).n).toBe(0);
    } finally {
      await db.delete(organizations).where(eq(organizations.id, org!.id));
    }
  });
});

describe("M2.2 resolver: SEPA + planning + permit resolve into one project", () => {
  const planningId = `SUP-${RUN}-0001`;
  const sepaFileRef = `SEP-${RUN}-0002`;
  let projectId: string;

  it("creates a project from the first planning record", async () => {
    const row = await insertRecord(
      record({
        externalId: planningId,
        recordType: "planning_application",
        title: `${planningId} – Roamers Test RV Park`,
        normalizedStage: "entitlement",
        statusRaw: "under review",
        parcelIds: [PARCEL],
        addressRaw: `${RUN.slice(0, 4)} Roamers Test Rd, Chehalis, WA 98532`,
        organizations: [{ name: "Roamers Test LLC", role: "applicant", evidenceText: "x" }],
      }),
      { fileNumbers: [planningId, sepaFileRef] },
      new Date("2026-07-01T00:00:00Z"),
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("created");
    expect(outcome.rule).toBe("new_project");
    projectId = outcome.projectId!;

    const ids = await db
      .select()
      .from(projectExternalIds)
      .where(eq(projectExternalIds.projectId, projectId));
    expect(ids.map((i) => i.externalId).sort()).toEqual([sepaFileRef, planningId].sort());

    const events = await db
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.projectId, projectId));
    // The creating record carries its own event alongside first-seen.
    expect(events.map((e) => e.eventType).sort()).toEqual([
      "application_submitted",
      "project_first_seen",
    ]);
  });

  it("merges a SEPA record via explicit file-number reference (pass 2)", async () => {
    const row = await insertRecord(
      record({
        externalId: `77${RUN.replace(/\D/g, "1")}`,
        recordType: "sepa_document",
        title: `SEPA – Roamers Test RV Park DNS`,
        documentType: "DNS",
        issueDate: "2026-07-03",
        permittingJurisdiction: "Test Jurisdiction",
      }),
      { leadagencyfilenumber: sepaFileRef },
      new Date("2026-07-03T00:00:00Z"),
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("merged");
    expect(outcome.rule).toBe("explicit_reference");
    expect(outcome.projectId).toBe(projectId);
  });

  it("merges a permit via parcel overlap (pass 3) and advances the stage", async () => {
    const row = await insertRecord(
      record({
        externalId: `B-${RUN}-0100`,
        recordType: "building_permit",
        title: `B-${RUN}-0100 – NEW COMMERCIAL at 123 TEST RD`,
        normalizedStage: "permit_issued",
        statusRaw: "issued",
        issueDate: "2026-07-10",
        parcelIds: [PARCEL],
      }),
      {},
      new Date("2026-07-10T00:00:00Z"),
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("merged");
    expect(outcome.rule).toBe("parcel_overlap");
    expect(outcome.projectId).toBe(projectId);

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(project!.currentStage).toBe("permit_issued");

    const events = await db
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.projectId, projectId))
      .orderBy(projectEvents.observedAt);
    const types = events.map((e) => e.eventType);
    expect(types).toEqual([
      "project_first_seen",
      "application_submitted",
      "sepa_determination",
      "permit_issued",
    ]);
    const permitEvent = events[3]!;
    expect(permitEvent.priorStage).toBe("entitlement");
    expect(permitEvent.resultingStage).toBe("permit_issued");
    expect(permitEvent.materialChange).toBe(true);
  });

  it("a record whose own id is a registered official id matches pass 1", async () => {
    // The SEPA file number was registered from the planning record's
    // references; a later record carrying it as its own official id
    // (same jurisdiction) is a pass-1 match.
    const row = await insertRecord(
      record({
        externalId: sepaFileRef,
        recordType: "public_notice",
        title: `${sepaFileRef} – Roamers Test RV Park DNS notice`,
        normalizedStage: "entitlement",
      }),
      {},
      new Date("2026-07-12T00:00:00Z"),
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("merged");
    expect(outcome.rule).toBe("official_id");
    expect(outcome.projectId).toBe(projectId);
    // Stage never regresses from a lower-stage record.
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(project!.currentStage).toBe("permit_issued");
  });

  it("routes a cross-jurisdiction parcel match to review, not auto-merge", async () => {
    const row = await insertRecord(
      record({
        externalId: `TI-${RUN}-0001`,
        recordType: "building_permit",
        title: `TI-${RUN}-0001 – TENANT IMPROVEMENT`,
        permittingJurisdiction: "Other Jurisdiction",
        parcelIds: [PARCEL],
      }),
      {},
      new Date("2026-07-11T00:00:00Z"),
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("review");
    const [review] = await db
      .select()
      .from(resolutionReviews)
      .where(eq(resolutionReviews.sourceRecordId, row.id));
    expect(review!.status).toBe("pending");
    expect(review!.reasonsJson).toEqual(["conflicting_jurisdiction"]);
    expect(review!.candidateProjectId).toBe(projectId);
  });

  it("records resolver provenance and loses no source records", async () => {
    const resolutions = await db
      .select()
      .from(recordResolutions)
      .where(eq(recordResolutions.projectId, projectId));
    expect(resolutions.length).toBe(4);
    for (const r of resolutions) {
      expect(r.resolverVersion).toBe(RESOLVER_VERSION);
      expect(r.decision).toBe("auto");
      expect(r.status).toBe("active");
      expect(r.featuresJson).toBeTruthy();
      expect(r.score).toBeGreaterThan(0.9);
    }
    // Every inserted test record still exists (nothing deleted by resolution).
    const recs = await db
      .select({ id: sourceRecords.id })
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.sourceId, sourceId),
          inArray(sourceRecords.recordType, [
            "planning_application",
            "sepa_document",
            "building_permit",
            "public_notice",
          ]),
        ),
      );
    expect(recs.length).toBe(5);
  });
});


/**
 * Pass 1b — an authoritative permit number sitting in the review queue means
 * "we do not know yet", and that has to outrank every weaker pass.
 *
 * Live failure this pins (2026-07-27, Pierce PALS hydration): 46 records whose
 * twin was parked in review fell through to weaker passes — 31 created a SECOND
 * project for a permit we already held, and 15 merged on parcel overlap into a
 * project that diverges from the twin's review candidate. In all 46 the twin's
 * review points elsewhere, so deciding those reviews splits one permit across
 * two projects permanently.
 *
 * The twin is inserted under a SECOND source on purpose: source_records is
 * unique on (source_id, external_id), so one source physically cannot hold the
 * same permit twice — which is precisely why this only ever bites across
 * sources, where an enrichment lane meets the open-data lane.
 */
describe("pass 1b — a permit number awaiting review holds its twin", () => {
  let twinSourceId: string;
  let twinArtifactId: string;
  const twinRecordIds: string[] = [];

  beforeAll(async () => {
    const [row] = await db
      .insert(sources)
      .values({
        key: `fake_twin_source_${RUN.toLowerCase()}`,
        name: "Twin source (test)",
        authority: "Test Jurisdiction",
        priority: "test",
        landingUrl: "https://example.invalid/twin",
        accessUrl: "https://example.invalid/twin.json",
        format: "json",
        accessClass: "open_data",
        cadence: "daily",
        county: "Thurston",
        permittingJurisdiction: "Test Jurisdiction",
        enabled: false,
      })
      .returning({ id: sources.id });
    twinSourceId = row!.id;

    // Its OWN artifact. Pointing twin records at fake_source's artifact makes
    // resetSource("fake_source") in a concurrently-running test file fail on
    // the raw_artifacts FK, because these records still reference it.
    const [twinRun] = await db
      .insert(sourceRuns)
      .values({ sourceId: twinSourceId, status: "succeeded" })
      .returning({ id: sourceRuns.id });
    const [twinArtifact] = await db
      .insert(rawArtifacts)
      .values({
        sourceId: twinSourceId,
        sourceRunId: twinRun!.id,
        canonicalUrl: `https://example.invalid/twin-test/${RUN}`,
        retrievedAt: new Date(),
        contentType: "application/json",
        httpStatus: 200,
        storageKey: `raw/twin/${RUN}`,
        sha256: `1${RUN.padEnd(63, "0")}`.toLowerCase().slice(0, 64),
        byteSize: 2,
        headersJson: {},
        parserVersion: "test",
      })
      .returning({ id: rawArtifacts.id });
    twinArtifactId = twinArtifact!.id;
  });

  afterAll(async () => {
    // Leave nothing behind: the source key is RUN-unique, so without this every
    // run accumulates a source plus its records.
    if (twinRecordIds.length > 0) {
      await db
        .delete(resolutionReviews)
        .where(inArray(resolutionReviews.sourceRecordId, twinRecordIds));
      await db.delete(recordResolutions).where(inArray(recordResolutions.sourceRecordId, twinRecordIds));
      await db.delete(projectEvents).where(inArray(projectEvents.sourceRecordId, twinRecordIds));
      await db.delete(sourceRecords).where(inArray(sourceRecords.id, twinRecordIds));
    }
    await db.delete(rawArtifacts).where(eq(rawArtifacts.id, twinArtifactId));
    await db.delete(sourceRuns).where(eq(sourceRuns.sourceId, twinSourceId));
    await db.delete(sources).where(eq(sources.id, twinSourceId));
  });

  /** Insert the twin under the other source, then park it in review. */
  async function parkedTwin(
    normalized: NormalizedSourceRecord,
    candidateProjectId: string | null,
  ): Promise<{ id: string; normalized: NormalizedSourceRecord; rawFields: Record<string, unknown>; firstSeenAt: Date }> {
    const firstSeenAt = new Date("2026-07-01T00:00:00Z");
    const [row] = await db
      .insert(sourceRecords)
      .values({
        sourceId: twinSourceId,
        rawArtifactId: twinArtifactId,
        externalId: normalized.externalId,
        recordType: normalized.recordType,
        firstSeenAt,
        lastSeenAt: firstSeenAt,
        rawFieldsJson: {},
        normalizedJson: normalized,
        normalizedFingerprint: `twin-${normalized.externalId}-${RUN}`,
      })
      .returning({ id: sourceRecords.id });
    twinRecordIds.push(row!.id);
    await db.insert(resolutionReviews).values({
      sourceRecordId: row!.id,
      candidateProjectId,
      matchedRule: "proximity_org",
      featuresJson: {},
      score: 0.6,
      reasonsJson: ["fuzzy_without_parcel_or_org_support"],
      resolverVersion: RESOLVER_VERSION,
    });
    return { id: row!.id, normalized, rawFields: {}, firstSeenAt };
  }

  it("parks the second record instead of creating a second project for the same permit", async () => {
    const permit = `TWIN-A-${RUN}`;
    await parkedTwin(record({ externalId: permit, title: "open-data record, parked" }), null);

    const enrichment = await insertRecord(
      record({ externalId: permit, title: "lookup-class enrichment" }),
      {},
      new Date("2026-07-02T00:00:00Z"),
    );
    const outcome = await resolveTracked(enrichment);

    expect(outcome.outcome).toBe("review");
    expect(outcome.rule).toBe("official_id");
    const [rv] = await db
      .select()
      .from(resolutionReviews)
      .where(eq(resolutionReviews.sourceRecordId, enrichment.id));
    expect(rv?.reasonsJson).toEqual(["same_permit_pending_review"]);
  });

  it("outranks a parcel match — the strong key wins over the weaker guess", async () => {
    // The 15-record half of the live failure: a parcel overlap is a guess made
    // against a key we already know is authoritative and already know is
    // undecided, so it must not be allowed to decide.
    const parcel = `8${RUN.replace(/\D/g, "0").padEnd(10, "3")}`.slice(0, 11);
    const seed = await insertRecord(
      record({ externalId: `TWIN-SEED-${RUN}`, parcelIds: [parcel], title: "existing project" }),
      {},
      new Date("2026-07-01T00:00:00Z"),
    );
    expect((await resolveTracked(seed)).outcome).toBe("created");

    const permit = `TWIN-B-${RUN}`;
    await parkedTwin(record({ externalId: permit, title: "parked twin" }), null);

    // Same parcel as the seeded project — pass 3 would merge it there.
    const enrichment = await insertRecord(
      record({ externalId: permit, parcelIds: [parcel], title: "would have merged on parcel" }),
      {},
      new Date("2026-07-03T00:00:00Z"),
    );
    const outcome = await resolveTracked(enrichment);

    expect(outcome.outcome).toBe("review");
    expect(outcome.rule).toBe("official_id");
  });

  it("self-heals: once the twin has a project, the held record merges on official_id", async () => {
    const permit = `TWIN-C-${RUN}`;
    const twin = await parkedTwin(record({ externalId: permit, title: "twin awaiting a human" }), null);

    const enrichment = await insertRecord(
      record({ externalId: permit, title: "held alongside" }),
      {},
      new Date("2026-07-02T00:00:00Z"),
    );
    expect((await resolveTracked(enrichment)).outcome).toBe("review");

    // The reviewer decides; the twin lands on a project, which registers the
    // permit number. Nothing about the held record has to be repaired by hand.
    await db
      .update(resolutionReviews)
      .set({ status: "rejected" })
      .where(eq(resolutionReviews.sourceRecordId, twin.id));
    // `adjudicating` is what decideReview's reject branch passes. WITHOUT it the
    // two records hold each other forever: the twin would now see the held
    // record's pending review for the same permit and park itself too.
    const twinOutcome = await resolveRecord(db, twin, { adjudicating: true });
    if (twinOutcome.projectId) createdProjects.add(twinOutcome.projectId);
    expect(twinOutcome.outcome).toBe("created");

    const healed = await resolveTracked(enrichment);
    expect(healed.outcome).toBe("merged");
    expect(healed.rule).toBe("official_id");
    expect(healed.projectId).toBe(twinOutcome.projectId);
  });

  it("without `adjudicating` the two records would hold each other forever", async () => {
    // Pins the deadlock directly, so nobody removes the flag thinking it is
    // redundant. This is the state decideReview's reject branch is in: the row
    // is already 'rejected', so "has a pending review" cannot tell the record
    // being decided apart from one merely waiting.
    const permit = `TWIN-E-${RUN}`;
    const twin = await parkedTwin(record({ externalId: permit, title: "twin" }), null);
    const enrichment = await insertRecord(
      record({ externalId: permit, title: "held alongside" }),
      {},
      new Date("2026-07-02T00:00:00Z"),
    );
    expect((await resolveTracked(enrichment)).outcome).toBe("review");
    await db
      .update(resolutionReviews)
      .set({ status: "rejected" })
      .where(eq(resolutionReviews.sourceRecordId, twin.id));

    const deadlocked = await resolveRecord(db, twin);
    if (deadlocked.projectId) createdProjects.add(deadlocked.projectId);
    expect(deadlocked.outcome).toBe("review");
  });

  it("does not treat the same bare number in another jurisdiction as a twin", async () => {
    // Permit numbers are only unique within their authority; matching across
    // jurisdictions would invent twins out of coincidence.
    const permit = `TWIN-D-${RUN}`;
    await parkedTwin(
      record({ externalId: permit, permittingJurisdiction: "Other Jurisdiction" }),
      null,
    );

    const other = await insertRecord(
      record({ externalId: permit, title: "same number, different authority" }),
      {},
      new Date("2026-07-02T00:00:00Z"),
    );
    expect((await resolveTracked(other)).outcome).toBe("created");
  });
});
