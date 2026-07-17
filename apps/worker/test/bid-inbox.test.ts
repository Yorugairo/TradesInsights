/**
 * M4.6 — customer-authorized bid-invitation scaffolding: private ingestion
 * from an authorized export, explicit-invitation-only bidding_confirmed,
 * account isolation (source-scoped SQL + resolver exclusion), and the
 * spec §20 access audit. The live source stays disabled until the customer
 * grants authorization — these tests run the adapter against synthetic
 * fixtures through the real pipeline.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import { accountProfiles, sourceRecords, sources, type Db } from "@otn/db";
import { CustomerBidInboxAdapter } from "@otn/adapters";
import { MemoryObjectStore, createLogger, runSource } from "@otn/source-sdk";
import { resolveUnresolved } from "@otn/resolution";
import { FIXTURES_DIR } from "../src/jobs.js";
import { testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toLowerCase();
const SOURCE_KEY = "customer_bid_inbox_solis";

let db: Db;
let pool: pg.Pool;
let ownerAccountId: string;
let otherAccountId: string;
let sourceId: string;

beforeAll(async () => {
  ({ db, pool } = await testDb());
  const [owner] = await db
    .insert(accountProfiles)
    .values({
      key: `test_inbox_owner_${RUN}`,
      name: `Inbox Owner ${RUN}`,
      active: false,
      capabilitiesJson: [],
      territoryJson: {},
      deliveryConfigJson: {},
    })
    .returning({ id: accountProfiles.id });
  ownerAccountId = owner!.id;
  const [other] = await db
    .insert(accountProfiles)
    .values({
      key: `test_inbox_other_${RUN}`,
      name: `Inbox Other ${RUN}`,
      active: false,
      capabilitiesJson: [],
      territoryJson: {},
      deliveryConfigJson: {},
    })
    .returning({ id: accountProfiles.id });
  otherAccountId = other!.id;

  // Private, account-scoped source row (what db:seed produces for
  // account_key-configured sources), reset for a deterministic run.
  const [src] = await db
    .insert(sources)
    .values({
      key: SOURCE_KEY,
      name: "Test Bid Inbox",
      authority: "Customer-authorized (test)",
      priority: "P1",
      landingUrl: "https://private.invalid/inbox",
      format: "json_export",
      accessClass: "private_authorized",
      cadence: "on_demand",
      enabled: true,
      accountProfileId: ownerAccountId,
    })
    .onConflictDoUpdate({
      target: sources.key,
      set: { enabled: true, accountProfileId: ownerAccountId },
    })
    .returning({ id: sources.id });
  sourceId = src!.id;
  await db.execute(sql`
    DELETE FROM evidence_items WHERE source_record_id IN
      (SELECT id FROM source_records WHERE source_id = ${sourceId})`);
  await db.execute(sql`
    DELETE FROM artifact_access_log WHERE raw_artifact_id IN
      (SELECT id FROM raw_artifacts WHERE source_id = ${sourceId})`);
  await db.execute(sql`DELETE FROM source_records WHERE source_id = ${sourceId}`);
  await db.execute(sql`DELETE FROM raw_artifacts WHERE source_id = ${sourceId}`);
  await db.execute(sql`DELETE FROM source_runs WHERE source_id = ${sourceId}`);
});

afterAll(async () => {
  await db.execute(sql`
    UPDATE sources SET account_profile_id = NULL, enabled = false WHERE id = ${sourceId}`);
  await db.execute(sql`
    DELETE FROM artifact_access_log
    WHERE account_profile_id IN (${ownerAccountId}, ${otherAccountId})`);
  await db.execute(sql`
    DELETE FROM account_profiles WHERE id IN (${ownerAccountId}, ${otherAccountId})`);
  await pool.end();
});

describe("M4.6 customer bid inbox", () => {
  it("ingests the authorized export; only explicit invitations become bidding_confirmed", async () => {
    const result = await runSource({
      db,
      adapter: new CustomerBidInboxAdapter(SOURCE_KEY, "solis_interiors"),
      objectStore: new MemoryObjectStore(),
      logger: createLogger({ app: "test" }),
      fixturesDir: FIXTURES_DIR,
      userAgent: "test",
    });
    expect(result.status).toBe("succeeded");
    expect(result.metrics.parsed).toBe(2);

    const rows = await db.select().from(sourceRecords).where(eq(sourceRecords.sourceId, sourceId));
    const invited = rows.find((r) => r.externalId === "INV-90001")!;
    const preliminary = rows.find((r) => r.externalId === "INV-90002")!;
    const inv = invited.normalizedJson as Record<string, unknown>;
    const pre = preliminary.normalizedJson as Record<string, unknown>;

    // The invariant, both directions (spec: "a permit is not a bid").
    expect(inv["normalizedStage"]).toBe("bidding_confirmed");
    expect(pre["normalizedStage"]).toBe("unknown");
    expect(pre["statusRaw"]).toBe("preliminary_interest"); // preserved, never coerced

    // Contact data never enters normalized fields (M4.4 high-risk category).
    expect(JSON.stringify(inv)).not.toContain("estimator@");
    expect((invited.rawFieldsJson as Record<string, unknown>)["estimator_contact"]).toBe(
      "estimator@fixturebuilders.invalid",
    );
  });

  it("rejects an export whose account_key does not match the source's account", async () => {
    const adapter = new CustomerBidInboxAdapter(SOURCE_KEY, "lacey_glass_commercial");
    const raw = {
      discovered: {
        idempotencyKey: "t",
        canonicalUrl: "private://t",
        parentUrl: null,
        expectedContentType: "application/json",
        sourcePublishedAt: null,
        meta: { file: "export-2026-07-10.json" },
      },
      body: Buffer.from(
        JSON.stringify({
          account_key: "solis_interiors",
          exported_at: "2026-07-10T18:00:00Z",
          platform: "x",
          invitations: [],
        }),
      ),
      contentType: "application/json",
      httpStatus: null,
      headers: {},
      retrievedAt: new Date(),
    };
    await expect(
      adapter.parse(raw as never, { logger: createLogger({ app: "t" }) } as never),
    ).rejects.toThrow(/does not match source account/);
  });

  it("keeps private records out of the shared project graph", async () => {
    const summary = await resolveUnresolved(db, { limit: 10_000 });
    const resolved = await db.execute(sql`
      SELECT count(*) AS n FROM record_resolutions rr
      JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE sr.source_id = ${sourceId}`);
    expect(Number((resolved.rows[0] as { n: string }).n)).toBe(0);
    expect(summary.errors).toBe(0);
  });

  it("private-CLASS records stay out even when the account binding is unbound", async () => {
    // Regression (2026-07-17): the guard used to key ONLY on account_profile_id,
    // so an unbound/not-yet-activated private inbox source leaked its records
    // into the shared graph on the next resolve run. access_class must hold on
    // any binding state.
    await db.execute(sql`UPDATE sources SET account_profile_id = NULL WHERE id = ${sourceId}`);
    try {
      const summary = await resolveUnresolved(db, { limit: 10_000 });
      const resolved = await db.execute(sql`
        SELECT count(*) AS n FROM record_resolutions rr
        JOIN source_records sr ON sr.id = rr.source_record_id
        WHERE sr.source_id = ${sourceId}`);
      expect(Number((resolved.rows[0] as { n: string }).n)).toBe(0);
      expect(summary.errors).toBe(0);
    } finally {
      await db.execute(
        sql`UPDATE sources SET account_profile_id = ${ownerAccountId} WHERE id = ${sourceId}`,
      );
    }
  });

  it("account isolation: only the owning account's scoped query reaches the records", async () => {
    const forOwner = await db.execute(sql`
      SELECT count(*) AS n FROM source_records sr JOIN sources s ON s.id = sr.source_id
      WHERE s.account_profile_id = ${ownerAccountId} AND sr.record_type = 'bid_invitation'`);
    const forOther = await db.execute(sql`
      SELECT count(*) AS n FROM source_records sr JOIN sources s ON s.id = sr.source_id
      WHERE s.account_profile_id = ${otherAccountId} AND sr.record_type = 'bid_invitation'`);
    expect(Number((forOwner.rows[0] as { n: string }).n)).toBe(2);
    expect(Number((forOther.rows[0] as { n: string }).n)).toBe(0);
  });

  it("access to private artifacts is auditable (spec §20)", async () => {
    // The web layer logs on every read; exercise the same append here.
    const artifact = await db.execute(sql`
      SELECT id FROM raw_artifacts WHERE source_id = ${sourceId} LIMIT 1`);
    const rawArtifactId = (artifact.rows[0] as { id: string }).id;
    await db.execute(sql`
      INSERT INTO artifact_access_log (raw_artifact_id, account_profile_id, accessed_by, purpose)
      VALUES (${rawArtifactId}, ${ownerAccountId}, 'test:reader', 'invitation_list_view')`);
    const log = await db.execute(sql`
      SELECT accessed_by, purpose FROM artifact_access_log WHERE raw_artifact_id = ${rawArtifactId}`);
    expect(log.rows.length).toBeGreaterThanOrEqual(1);
    expect((log.rows[0] as { purpose: string }).purpose).toBe("invitation_list_view");
  });
});
