import { describe, expect, it } from "vitest";
import {
  compareCandidates,
  selectCappedEvidence,
  type CandidateRow,
} from "./link-opportunity-evidence.js";
import {
  GRADE_A_CONFIDENCE,
  GRADE_C_CONFIDENCE,
  type ClaimType,
} from "./opportunity-evidence.js";

const candidate = (
  evidenceItemId: string,
  claimType: ClaimType,
  confidence = GRADE_A_CONFIDENCE,
): CandidateRow => ({
  opportunityId: "opp-1",
  evidenceItemId,
  claimType,
  confirmed: confidence === GRADE_A_CONFIDENCE,
  confidence,
});

/** Deterministic shuffle — no Math.random, so a failure always reproduces. */
function rotate<T>(items: readonly T[], by: number): T[] {
  const n = items.length;
  return items.map((_, i) => items[(i + by) % n] as T);
}

describe("selectCappedEvidence", () => {
  it("keeps everything when under the cap and drops nothing", () => {
    const rows = [candidate("a", "identity"), candidate("b", "stage")];
    const { kept, dropped } = selectCappedEvidence(rows, 50);
    expect(kept).toHaveLength(2);
    expect(dropped).toBe(0);
  });

  it("drops exactly the overflow", () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      candidate(`e${String(i).padStart(3, "0")}`, "other"),
    );
    const { kept, dropped } = selectCappedEvidence(rows, 50);
    expect(kept).toHaveLength(50);
    expect(dropped).toBe(10);
  });

  it("picks the SAME rows whatever order the database returned them in", () => {
    // This is the property the cap depends on. If selection were order
    // sensitive, each run would contribute a different subset, ON CONFLICT DO
    // NOTHING would accept every one, and the table would converge on the full
    // uncapped set with the cap silently defeated.
    const rows = [
      candidate("e5", "other"),
      candidate("e1", "identity"),
      candidate("e4", "geography"),
      candidate("e2", "stage"),
      candidate("e3", "event_date"),
    ];
    const baseline = selectCappedEvidence(rows, 3).kept.map((r) => r.evidenceItemId);
    for (let by = 1; by < rows.length; by += 1) {
      const shuffled = selectCappedEvidence(rotate(rows, by), 3).kept.map((r) => r.evidenceItemId);
      expect(shuffled).toEqual(baseline);
    }
  });

  it("keeps gate-critical claims over ungated ones when the cap bites", () => {
    // The publication gate needs identity, geography, stage and event date.
    // Dropping those in favour of `other` would make the cap actively harmful.
    const rows = [
      candidate("e1", "other"),
      candidate("e2", "other"),
      candidate("e3", "identity"),
      candidate("e4", "stage"),
    ];
    const kept = selectCappedEvidence(rows, 2).kept.map((r) => r.claimType);
    expect(kept).toEqual(["identity", "stage"]);
  });

  it("prefers stronger authority over a more important claim type", () => {
    // A weakly-sourced identity claim should not outrank a well-sourced one
    // just because identity sorts first.
    const rows = [
      candidate("e1", "identity", GRADE_C_CONFIDENCE),
      candidate("e2", "other", GRADE_A_CONFIDENCE),
    ];
    const kept = selectCappedEvidence(rows, 1).kept;
    expect(kept[0]?.evidenceItemId).toBe("e2");
    expect(kept[0]?.confidence).toBe(GRADE_A_CONFIDENCE);
  });

  it("does not mutate its input", () => {
    const rows = [candidate("e9", "other"), candidate("e1", "identity")];
    const before = rows.map((r) => r.evidenceItemId);
    selectCappedEvidence(rows, 1);
    expect(rows.map((r) => r.evidenceItemId)).toEqual(before);
  });

  it("handles an empty candidate set", () => {
    expect(selectCappedEvidence([], 50)).toEqual({ kept: [], dropped: 0 });
  });
});

describe("compareCandidates", () => {
  it("is a total order — ties broken by evidence id, never left equal", () => {
    // Any pair returning 0 would make the sort unstable across engines and
    // reintroduce the leak the cap exists to prevent.
    const rows = [
      candidate("e1", "identity"),
      candidate("e2", "identity"),
      candidate("e3", "other", GRADE_C_CONFIDENCE),
    ];
    for (const a of rows) {
      for (const b of rows) {
        if (a.evidenceItemId === b.evidenceItemId) continue;
        expect(compareCandidates(a, b)).not.toBe(0);
      }
    }
  });

  it("orders identical rows by evidence id ascending", () => {
    expect(compareCandidates(candidate("a", "stage"), candidate("b", "stage"))).toBeLessThan(0);
  });
});
