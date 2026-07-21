import { describe, expect, it } from "vitest";
import {
  AssistantFilterSchema,
  cutoffFor,
  parseQuestionDeterministic,
  sanitizeAssistantFilter,
  templateAnswer,
  type AssistantFilter,
  type AssistantMatch,
} from "./assistant.js";

/**
 * WS-F pure-parser tests (no DB): the whitelist sanitizer, the deterministic
 * no-model fallback parser, the timeframe→date mapping, and the deterministic
 * template answer. These prove NL→filter mapping is deterministic and confined
 * to the account's own vocabulary before any query is ever built.
 */

const SCOPE = { counties: ["Thurston", "Pierce", "Lewis", "King"], trades: ["drywall", "painting"] };

function filter(over: Partial<AssistantFilter> = {}): AssistantFilter {
  return {
    counties: [],
    trades: [],
    timeframe: "all",
    bidWindowOpen: false,
    priorityOnly: false,
    keyword: null,
    ...over,
  };
}

describe("sanitizeAssistantFilter (whitelist)", () => {
  it("drops counties outside the account territory and trades outside its capabilities", () => {
    const raw = filter({
      counties: ["Thurston", "Spokane", "Snohomish"],
      trades: ["drywall", "roofing", "plumbing"],
    });
    const out = sanitizeAssistantFilter(raw, SCOPE);
    expect(out.counties).toEqual(["Thurston"]);
    expect(out.trades).toEqual(["drywall"]);
  });

  it("normalizes casing/spacing to the canonical whitelist value and de-dupes", () => {
    const raw = filter({ counties: ["  thurston ", "THURSTON", "king"], trades: ["Drywall", "DRYWALL"] });
    const out = sanitizeAssistantFilter(raw, SCOPE);
    expect(out.counties).toEqual(["Thurston", "King"]);
    expect(out.trades).toEqual(["drywall"]);
  });

  it("clamps an over-long keyword to 80 chars and empties a blank one", () => {
    const long = "x".repeat(200);
    expect(sanitizeAssistantFilter(filter({ keyword: long }), SCOPE).keyword).toHaveLength(80);
    expect(sanitizeAssistantFilter(filter({ keyword: "   " }), SCOPE).keyword).toBeNull();
  });

  it("keeps an injection-y keyword as inert text (it is bound as a parameter downstream)", () => {
    const evil = "'; DROP TABLE opportunities; --";
    const out = sanitizeAssistantFilter(filter({ keyword: evil }), SCOPE);
    expect(out.keyword).toBe(evil); // preserved verbatim; safety comes from binding, not stripping
  });
});

describe("parseQuestionDeterministic (no-model fallback)", () => {
  it("maps counties, timeframe, and the winnable intent from plain English", () => {
    const out = parseQuestionDeterministic("what's winnable in Thurston this week?", SCOPE);
    expect(out.counties).toEqual(["Thurston"]);
    expect(out.timeframe).toBe("this_week");
    expect(out.bidWindowOpen).toBe(true);
    expect(out.trades).toEqual([]);
  });

  it("only matches the account's own counties — an out-of-territory county is never added", () => {
    const out = parseQuestionDeterministic("anything winnable in Spokane this month?", SCOPE);
    expect(out.counties).toEqual([]); // Spokane is not in this account's territory
    expect(out.timeframe).toBe("this_month");
  });

  it("detects configured trades and the priority intent", () => {
    const out = parseQuestionDeterministic("show me top drywall and painting jobs", SCOPE);
    expect(out.trades).toEqual(["drywall", "painting"]);
    expect(out.priorityOnly).toBe(true);
  });
});

describe("cutoffFor", () => {
  it("maps timeframes to date cutoffs in deterministic code (all => no cutoff)", () => {
    const now = new Date("2026-07-21T00:00:00Z");
    expect(cutoffFor("all", now)).toBeNull();
    expect(cutoffFor("this_week", now)!.toISOString()).toBe("2026-07-14T00:00:00.000Z");
    expect(cutoffFor("this_month", now)!.toISOString()).toBe("2026-06-21T00:00:00.000Z");
    expect(cutoffFor("last_90_days", now)!.toISOString()).toBe("2026-04-22T00:00:00.000Z");
  });
});

describe("templateAnswer (deterministic, grounded)", () => {
  const match = (over: Partial<AssistantMatch>): AssistantMatch => ({
    opportunityId: "opp-1",
    projectId: "proj-1",
    projectName: "Maple TI",
    county: "Thurston",
    jurisdiction: "Lacey",
    stage: "permit_issued",
    score: 84,
    route: "interior_trades",
    generalContractor: "Acme GC",
    bidWindow: { status: "open", note: "bid window open" },
    ...over,
  });

  it("says plainly that nothing matches when there are zero rows — never invents one", () => {
    const answer = templateAnswer([], filter({ counties: ["Thurston"], bidWindowOpen: true }));
    expect(answer).toMatch(/nothing winnable matches/i);
    expect(answer).toMatch(/Thurston/);
  });

  it("summarizes the retrieved rows without adding facts", () => {
    const answer = templateAnswer([match({}), match({ opportunityId: "opp-2", projectName: "Oak Plaza" })], filter({ counties: ["Thurston"] }));
    expect(answer).toMatch(/2 opportunities match in Thurston/);
    expect(answer).toMatch(/Maple TI/);
    expect(answer).toMatch(/Oak Plaza/);
  });
});

describe("AssistantFilterSchema", () => {
  it("is strict — an unexpected key rejects the parse", () => {
    expect(AssistantFilterSchema.safeParse({ counties: [], sql: "DROP TABLE" }).success).toBe(false);
  });

  it("applies defaults for an empty object", () => {
    const res = AssistantFilterSchema.parse({});
    expect(res).toEqual({
      counties: [],
      trades: [],
      timeframe: "all",
      bidWindowOpen: false,
      priorityOnly: false,
      keyword: null,
    });
  });
});
