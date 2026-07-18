import { describe, expect, it } from "vitest";
import { validateBrief, type BriefMenuItem } from "./brief-contract.js";

const MENU: BriefMenuItem[] = [
  { refId: "f0", kind: "fact", text: "project.valuationUsd = 2584093" },
  { refId: "f1", kind: "fact", text: "project.units = 20" },
  { refId: "i0", kind: "inference", text: "trade_fit: interior_plausible — TI scope drywall/paint" },
  {
    refId: "c_timing",
    kind: "context",
    text: "Stage permit_issued; last activity 12 days ago (within the active window).",
  },
];

function draft(segments: unknown): string {
  return JSON.stringify({ segments });
}

describe("brief contract validation", () => {
  it("accepts a well-formed draft that cites only menu items and reuses menu numbers", () => {
    const raw = draft([
      { text: "New permit valued at $2,584,093 in the account's territory.", kind: "fact", refs: ["f0"] },
      { text: "20 units in scope.", kind: "fact", refs: ["f1"] },
      { text: "Interior trades look like a fit on this TI scope.", kind: "inference", refs: ["i0"] },
      { text: "Permit issued 12 days ago, still inside the active window.", kind: "context", refs: ["c_timing"] },
    ]);
    const res = validateBrief(raw, MENU);
    expect(res.ok).toBe(true);
  });

  it("accepts a number reformatted with commas/$ as long as the digits match a cited item", () => {
    // f0 stores 2584093 (no punctuation); the model wrote $2,584,093 — same digits.
    const res = validateBrief(
      draft([{ text: "Valued at $2,584,093.", kind: "fact", refs: ["f0"] }]),
      MENU,
    );
    expect(res.ok).toBe(true);
  });

  it("rejects a segment citing an unknown ref (fabricated citation)", () => {
    const res = validateBrief(
      draft([{ text: "20 units.", kind: "fact", refs: ["f9"] }]),
      MENU,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.violations.some((v) => v.kind === "unknown_ref")).toBe(true);
  });

  it("derives kind from the cited items — a sentence on an inference item is labeled inference", () => {
    // The model mislabels it "fact"; the authoritative kind comes from the ref.
    const res = validateBrief(
      draft([{ text: "This is an interior job.", kind: "fact", refs: ["i0"] }]),
      MENU,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.segments[0]!.kind).toBe("inference");
  });

  it("derives fact for a sentence resting only on fact items", () => {
    const res = validateBrief(draft([{ text: "20 units.", refs: ["f1"] }]), MENU);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.segments[0]!.kind).toBe("fact");
  });

  it("rejects a number the cited item does not state (invented figure)", () => {
    const res = validateBrief(
      draft([{ text: "A 320-unit development.", kind: "fact", refs: ["f1"] }]),
      MENU,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.violations.some((v) => v.kind === "unsubstantiated_number")).toBe(true);
  });

  it("rejects an invented dollar amount", () => {
    const res = validateBrief(
      draft([{ text: "Worth about $9,900,000.", kind: "fact", refs: ["f0"] }]),
      MENU,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.violations.some((v) => v.kind === "unsubstantiated_number")).toBe(true);
  });

  it("rejects malformed JSON and bad shapes", () => {
    expect(validateBrief("not json", MENU).ok).toBe(false);
    const emptyRefs = validateBrief(
      draft([{ text: "x", kind: "fact", refs: [] }]),
      MENU,
    );
    expect(emptyRefs.ok).toBe(false);
    if (!emptyRefs.ok) expect(emptyRefs.violations[0]!.kind).toBe("schema");
    const noSegments = validateBrief(JSON.stringify({ segments: [] }), MENU);
    expect(noSegments.ok).toBe(false);
  });
});
