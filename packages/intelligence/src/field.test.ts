import { describe, expect, it } from "vitest";
import type { Db } from "@otn/db";
import { addFieldEntry, FieldError } from "./field.js";

/**
 * Branch coverage for `addFieldEntry`'s validation and idempotency handling.
 *
 * SCOPE, stated because it is easy to over-read: this suite proves the DECISION
 * LOGIC — which inputs are refused, when a second statement is issued, and what
 * `deduped` reports. It cannot prove the database actually stores one row for a
 * replayed key; that depends on the partial unique index in migration 0042 and
 * is asserted against a real database in
 * `apps/web/e2e/mobile-offline-field.spec.ts`. A stub that returns whatever we
 * tell it to would "pass" even if the index were missing, so treating this file
 * as proof of exactly-once would be exactly the kind of self-confirming test
 * this codebase has been bitten by before.
 */

/** Minimal Db stub: hands back queued responses in order and counts calls. */
function stubDb(responses: Array<{ rows: unknown[] }>): { db: Db; calls: () => number } {
  let i = 0;
  let n = 0;
  const db = {
    execute: async () => {
      n += 1;
      return responses[i++] ?? { rows: [] };
    },
  };
  return { db: db as unknown as Db, calls: () => n };
}

const base = {
  pursuitId: "11111111-1111-4111-8111-111111111111",
  linkId: "22222222-2222-4222-8222-222222222222",
  entryType: "daily_log",
  body: "hung 40 boards",
};

const UUID = "33333333-3333-4333-8333-333333333333";

describe("addFieldEntry — validation", () => {
  it("refuses an unknown entry type", async () => {
    const { db } = stubDb([]);
    await expect(addFieldEntry(db, { ...base, entryType: "invoice" })).rejects.toThrow(FieldError);
  });

  it("refuses an empty body", async () => {
    const { db } = stubDb([]);
    await expect(addFieldEntry(db, { ...base, body: "   " })).rejects.toThrow(/body required/i);
  });

  it("refuses a clientEntryId that is not a UUID", async () => {
    const { db } = stubDb([]);
    // The value reaches a unique index; an unbounded client string would let a
    // caller squat arbitrary keys.
    await expect(addFieldEntry(db, { ...base, clientEntryId: "abc" })).rejects.toThrow(/UUID/i);
  });

  it("refuses a negative change-order amount", async () => {
    const { db } = stubDb([]);
    await expect(
      addFieldEntry(db, { ...base, entryType: "change_order", amount: -5 }),
    ).rejects.toThrow(/non-negative/i);
  });
});

describe("addFieldEntry — idempotency branching", () => {
  it("a fresh insert reports deduped:false and issues one statement", async () => {
    const { db, calls } = stubDb([{ rows: [{ id: "row-1" }] }]);
    const out = await addFieldEntry(db, { ...base, clientEntryId: UUID });
    expect(out).toEqual({ id: "row-1", deduped: false });
    expect(calls()).toBe(1);
  });

  it("a conflicting replay reads the original id back and reports deduped:true", async () => {
    // INSERT ... ON CONFLICT DO NOTHING returns zero rows on replay; the second
    // statement is how the caller still learns the original id.
    const { db, calls } = stubDb([{ rows: [] }, { rows: [{ id: "row-1" }] }]);
    const out = await addFieldEntry(db, { ...base, clientEntryId: UUID });
    expect(out).toEqual({ id: "row-1", deduped: true });
    expect(calls()).toBe(2);
  });

  it("a conflict whose row cannot be read back raises rather than inventing an id", async () => {
    const { db } = stubDb([{ rows: [] }, { rows: [] }]);
    await expect(addFieldEntry(db, { ...base, clientEntryId: UUID })).rejects.toThrow(
      /could not be read back/i,
    );
  });

  it("without a client key it never issues the lookup — cockpit path unchanged", async () => {
    const { db, calls } = stubDb([{ rows: [{ id: "row-2" }] }]);
    const out = await addFieldEntry(db, base);
    expect(out).toEqual({ id: "row-2", deduped: false });
    expect(calls()).toBe(1);
  });

  it("treats an empty-string key as absent, not as a key", async () => {
    // A form that renders the input but never fills it must not send "" into a
    // unique index — the second such submission would collide with the first.
    const { db, calls } = stubDb([{ rows: [{ id: "row-3" }] }]);
    const out = await addFieldEntry(db, { ...base, clientEntryId: "" });
    expect(out.deduped).toBe(false);
    expect(calls()).toBe(1);
  });
});
