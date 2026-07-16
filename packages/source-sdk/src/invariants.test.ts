import { describe, expect, it } from "vitest";
import {
  checkDateWindow,
  checkNumericRange,
  checkPattern,
  reconcileCount,
  reconcileSum,
  type InvariantViolation,
} from "./invariants.js";
import type { ParsedSourceRecord } from "./types.js";

/** Minimal parsed record; only the fields the invariant reads matter. */
function rec(externalId: string, over: Record<string, unknown> = {}): ParsedSourceRecord {
  return {
    rawFields: {},
    record: { externalId, ...over } as never,
  };
}

describe("D1 invariants", () => {
  it("reconcileCount: printed total vs parsed rows", () => {
    expect(reconcileCount("c", 14, 14)).toBeNull();
    expect(reconcileCount("c", null, 9)).toBeNull(); // unread total is never a violation
    const v = reconcileCount("c", 14, 9);
    expect(v).not.toBeNull();
    expect(v!.observed).toBe(9);
    expect(v!.expected).toBe(14);
  });

  it("reconcileSum: tolerance absorbs rounding, real gaps fire", () => {
    expect(reconcileSum("s", 100.0, 100.004)).toBeNull();
    expect(reconcileSum("s", null, 5)).toBeNull();
    expect(reconcileSum("s", 30_114_355.51, 14_594_587.0)).not.toBeNull();
  });

  it("checkNumericRange: a swapped valuation in a units column trips the ceiling", () => {
    const clean = [rec("A", { units: 89 }), rec("B", { units: 1 })];
    expect(
      checkNumericRange(clean, (p) => (p.record as { units: number }).units, { max: 2000, check: "u" }),
    ).toBeNull();
    const swapped = [rec("A", { units: 15_519_768 })];
    const v = checkNumericRange(swapped, (p) => (p.record as { units: number }).units, {
      max: 2000,
      check: "u",
    });
    expect(v).not.toBeNull();
    expect(v!.observed).toBe(15_519_768);
  });

  it("checkNumericRange: nulls are skipped (unknown is not a violation)", () => {
    const recs = [rec("A", { units: null })];
    expect(
      checkNumericRange(recs, (p) => (p.record as { units: number | null }).units, {
        max: 10,
        check: "u",
      }),
    ).toBeNull();
  });

  it("checkDateWindow: an out-of-window date (column swap) fires", () => {
    const recs = [rec("A", { d: "2020-01-01" })];
    const get = (p: ParsedSourceRecord) => (p.record as unknown as { d: string }).d;
    expect(checkDateWindow(recs, get, { minIso: "2026-07-01", maxIso: "2026-07-31", check: "d" })).not.toBeNull();
    expect(checkDateWindow([rec("A", { d: "2026-07-15" })], get, { minIso: "2026-07-01", maxIso: "2026-07-31", check: "d" })).toBeNull();
  });

  it("checkPattern: an id that stops matching its format fires", () => {
    const get = (p: ParsedSourceRecord) => p.record.externalId;
    expect(checkPattern([rec("BLDG26-1676")], get, { re: /^BLDG\d{2}-\d{3,5}$/, check: "id" })).toBeNull();
    const v = checkPattern([rec("FOOTING")], get, { re: /^BLDG\d{2}-\d{3,5}$/, check: "id" });
    expect(v).not.toBeNull();
  });

  it("stops at the first violation (cheap fail-fast)", () => {
    const recs = [rec("A", { units: 9999 }), rec("B", { units: 8888 })];
    const v = checkNumericRange(recs, (p) => (p.record as { units: number }).units, {
      max: 2000,
      check: "u",
    }) as InvariantViolation;
    expect(v.detail).toContain("A"); // first offender, not B
  });
});
