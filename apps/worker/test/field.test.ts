/**
 * Field communication (deck A5). What matters here: the raw token never lands
 * in the DB (hash only), failure is constant-shape (no oracle distinguishing
 * revoked from never-existed), a change order can be decided exactly once, and
 * the rollup ignores rejected entries.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { accountProfiles, type Db } from "@otn/db";
import {
  addFieldEntry,
  createPursuit,
  decideChangeOrder,
  FieldError,
  fieldRollup,
  getFieldBrief,
  listFieldEntries,
  listFieldLinks,
  mintFieldLink,
  revokeFieldLink,
  verifyFieldToken,
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
      key: `test_field_${RUN}`,
      name: `Field ${RUN}`,
      active: false,
      capabilitiesJson: [],
      territoryJson: {},
      deliveryConfigJson: {},
    })
    .returning({ id: accountProfiles.id });
  accountId = acct!.id;
  const proj = await db.execute(sql`
    INSERT INTO projects (canonical_name, permitting_jurisdiction, county, city, current_stage, first_seen_at, last_seen_at)
    VALUES (${`field test project ${RUN}`}, 'Test Jurisdiction', 'Pierce', 'Tacoma', 'permit_applied', now(), now())
    RETURNING id`);
  projectId = (proj.rows[0] as { id: string }).id;
  const opp = await db.execute(sql`
    INSERT INTO opportunities (account_profile_id, project_id, state) VALUES (${accountId}, ${projectId}, 'new')
    RETURNING id`);
  opportunityId = (opp.rows[0] as { id: string }).id;
  pursuitId = (await createPursuit(db, { accountProfileId: accountId, opportunityId, ownerUserId: "test" })).id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM field_entries WHERE pursuit_id = ${pursuitId}`);
  await db.execute(sql`DELETE FROM field_links WHERE pursuit_id = ${pursuitId}`);
  await db.execute(sql`DELETE FROM pursuit_notes WHERE pursuit_id = ${pursuitId}`);
  await db.execute(sql`DELETE FROM pursuit_transitions WHERE pursuit_id = ${pursuitId}`);
  await db.execute(sql`DELETE FROM pursuits WHERE id = ${pursuitId}`);
  await db.execute(sql`DELETE FROM opportunities WHERE id = ${opportunityId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM account_profiles WHERE id = ${accountId}`);
  await pool.end();
});

describe("field links", () => {
  it("mints a raw token that verifies, storing only its SHA-256", async () => {
    const { id, rawToken } = await mintFieldLink(db, { pursuitId, accountProfileId: accountId, label: "Javier" });
    const verdict = await verifyFieldToken(db, rawToken);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.pursuitId).toBe(pursuitId);

    const stored = await db.execute(sql`SELECT token_hash FROM field_links WHERE id = ${id}`);
    const hash = (stored.rows[0] as { token_hash: string }).token_hash;
    expect(hash).not.toBe(rawToken);
    expect(hash).toBe(createHash("sha256").update(rawToken).digest("hex"));
  });

  it("fails constant-shape on garbage, expired, and revoked alike", async () => {
    expect((await verifyFieldToken(db, "not-a-token")).ok).toBe(false);

    const expired = await mintFieldLink(db, { pursuitId, accountProfileId: accountId, label: "old" });
    await db.execute(sql`UPDATE field_links SET expires_at = now() - interval '1 day' WHERE id = ${expired.id}`);
    expect(await verifyFieldToken(db, expired.rawToken)).toEqual({ ok: false });

    const revoked = await mintFieldLink(db, { pursuitId, accountProfileId: accountId, label: "gone" });
    await revokeFieldLink(db, pursuitId, revoked.id);
    expect(await verifyFieldToken(db, revoked.rawToken)).toEqual({ ok: false });
  });

  it("revoking twice is not_found the second time", async () => {
    const link = await mintFieldLink(db, { pursuitId, accountProfileId: accountId, label: "once" });
    await revokeFieldLink(db, pursuitId, link.id);
    await expect(revokeFieldLink(db, pursuitId, link.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("lists links without ever exposing a token", async () => {
    const links = await listFieldLinks(db, pursuitId);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(JSON.stringify(l)).not.toContain("token");
  });
});

describe("field entries", () => {
  it("parses daily-log quantities from form strings and rejects negatives", async () => {
    const { id } = await addFieldEntry(db, {
      pursuitId, linkId: null, entryType: "daily_log",
      body: "good day", quantities: { boards: "84", tapedLf: "310", crewHours: "27" },
    });
    const rows = await listFieldEntries(db, pursuitId);
    const e = rows.find((r) => r.id === id)!;
    expect(e.quantities).toEqual({ boards: 84, tapedLf: 310, crewHours: 27 });
    // Non-CO entries need no decision: they land approved.
    expect(e.status).toBe("approved");

    await expect(
      addFieldEntry(db, { pursuitId, linkId: null, entryType: "daily_log", body: "bad", quantities: { boards: "-3" } }),
    ).rejects.toMatchObject({ code: "invalid_quantities" });
  });

  it("rejects unknown entry types and empty bodies", async () => {
    await expect(
      addFieldEntry(db, { pursuitId, linkId: null, entryType: "selfie", body: "hi" }),
    ).rejects.toThrowError(FieldError);
    await expect(
      addFieldEntry(db, { pursuitId, linkId: null, entryType: "note", body: "   " }),
    ).rejects.toMatchObject({ code: "invalid_value" });
  });

  it("a change order lands 'submitted', is decidable exactly once, and leaves an audit note", async () => {
    const { id } = await addFieldEntry(db, {
      pursuitId, linkId: null, entryType: "change_order",
      body: `water damage north wall ${RUN}`, amount: 1850, submittedName: "Javier R",
    });
    let entry = (await listFieldEntries(db, pursuitId)).find((e) => e.id === id)!;
    expect(entry.status).toBe("submitted");

    await decideChangeOrder(db, pursuitId, id, "approved", "owner");
    entry = (await listFieldEntries(db, pursuitId)).find((e) => e.id === id)!;
    expect(entry.status).toBe("approved");
    expect(entry.decidedBy).toBe("owner");

    await expect(decideChangeOrder(db, pursuitId, id, "rejected", "owner")).rejects.toMatchObject({
      code: "already_decided",
    });

    const notes = await db.execute(
      sql`SELECT body FROM pursuit_notes WHERE pursuit_id = ${pursuitId} AND body LIKE 'change order approved%'`,
    );
    expect(notes.rows.length).toBeGreaterThan(0);
  });

  it("deciding a plain note is not_a_change_order", async () => {
    const { id } = await addFieldEntry(db, { pursuitId, linkId: null, entryType: "note", body: "just a note" });
    await expect(decideChangeOrder(db, pursuitId, id, "approved", "owner")).rejects.toMatchObject({
      code: "not_a_change_order",
    });
  });

  it("rollup sums logs, counts only APPROVED extras, and ignores rejected entries", async () => {
    await addFieldEntry(db, {
      pursuitId, linkId: null, entryType: "daily_log", body: "day 2",
      quantities: { boards: "16", tapedLf: null, crewHours: "9" },
    });
    const rejected = await addFieldEntry(db, {
      pursuitId, linkId: null, entryType: "change_order", body: "padding attempt", amount: 99_999,
    });
    await decideChangeOrder(db, pursuitId, rejected.id, "rejected", "owner");

    const r = await fieldRollup(db, pursuitId);
    expect(r.boards).toBe(100); // 84 + 16
    expect(r.crewHours).toBe(36); // 27 + 9
    expect(r.logCount).toBe(2);
    expect(r.approvedExtras).toBe(1850); // approved CO only — never the rejected 99,999
  });

  it("the brief carries the account key and nothing sensitive", async () => {
    const brief = await getFieldBrief(db, pursuitId);
    expect(brief).not.toBeNull();
    expect(brief!.accountKey).toBe(`test_field_${RUN}`);
    expect(brief!.projectName).toContain("field test project");
    expect(brief!.city).toBe("Tacoma");
  });
});
