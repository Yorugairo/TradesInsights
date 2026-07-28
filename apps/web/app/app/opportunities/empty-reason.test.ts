import { describe, expect, test } from "vitest";

import { emptyReason } from "./empty-reason.js";

describe("emptyReason", () => {
  test("a mistyped search never claims the account has no data", () => {
    // The regression this pins. `scopedTotal` honours the search, so a search
    // that matches nothing drives it to 0 — and the first version read that as
    // "this account has never been scored" and said so to the operator.
    const reason = emptyReason({ q: "zzzznomatchzzzz" }, 0);
    expect(reason).toContain("zzzznomatchzzzz");
    expect(reason).not.toContain("no opportunity rows at all");
  });

  test("only an unconstrained empty view may speak about the account itself", () => {
    const reason = emptyReason({}, 0);
    expect(reason).toContain("no opportunity rows at all");
    expect(reason).toContain("not the same as every project having been rejected");
  });

  test("names every applied scope filter", () => {
    const reason = emptyReason({ q: "school", county: "Pierce", stage: "permit_applied", campus: "1" }, 0);
    expect(reason).toContain("search “school”");
    expect(reason).toContain("county Pierce");
    expect(reason).toContain("stage permit applied");
    expect(reason).toContain("active campus only");
  });

  test("blames the band, not the filters, when the scope did match rows", () => {
    const reason = emptyReason({ county: "Pierce", state: "promoted" }, 42);
    expect(reason).toContain("42 opportunities match county Pierce");
    expect(reason).toContain("none of them are in Promoted");
  });

  test("explains the default view's hidden archive exclusion", () => {
    // No band in the URL is not "all bands" — the query excludes archive. If
    // every match is archived the operator sees an empty table and no reason,
    // which is how a filter nobody chose looks like missing data.
    const reason = emptyReason({}, 17);
    expect(reason).toContain("all of them are archived");
    expect(reason).toContain("default view excludes archive");
  });

  test("never names the band as a term of the scoped count", () => {
    // `scopedTotal` ignores the band, so a sentence of the form "N match band X"
    // would be arithmetically false.
    const reason = emptyReason({ state: "dismissed", q: "clinic" }, 9);
    expect(reason).toContain("9 opportunities match search “clinic”");
    expect(reason).not.toMatch(/match[^.]*band/i);
  });
});
