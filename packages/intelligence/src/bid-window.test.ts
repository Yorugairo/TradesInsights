import { describe, expect, it } from "vitest";
import {
  accountBidWindows,
  bidTrackFor,
  drywallBidWindow,
  tradeBidWindow,
  tradeBidWindows,
  windowTradesFor,
} from "./bid-window.js";

const NOW = new Date("2026-07-17T00:00:00Z");
const weeksAgo = (w: number) => new Date(NOW.getTime() - w * 7 * 86_400_000);

describe("bidTrackFor", () => {
  it("SFR keywords stay residential even with TI-ish interior wording", () => {
    expect(bidTrackFor({ isSfr: true, isCommercial: false, isMultifamily: false })).toBe(
      "residential",
    );
    // "interior remodel of existing sfr" → isSfr wins over the TI regex.
    expect(bidTrackFor({ isSfr: true, isCommercial: true, isMultifamily: false })).toBe(
      "residential",
    );
  });

  it("commercial/multifamily keywords go commercial; unlabeled defaults residential", () => {
    expect(bidTrackFor({ isSfr: false, isCommercial: true, isMultifamily: false })).toBe(
      "commercial",
    );
    expect(bidTrackFor({ isSfr: false, isCommercial: false, isMultifamily: true })).toBe(
      "commercial",
    );
    expect(bidTrackFor({ isSfr: false, isCommercial: false, isMultifamily: false })).toBe(
      "residential",
    );
  });
});

describe("drywallBidWindow — residential (4–8 wks AFTER issuance)", () => {
  const base = { track: "residential" as const, now: NOW };

  it("issued 2 weeks ago → opens_soon with the open/close dates", () => {
    const w = drywallBidWindow({ ...base, stage: "permit_issued", issuedAt: weeksAgo(2) });
    expect(w.status).toBe("opens_soon");
    expect(w.note).toMatch(/typically open ~2 weeks/);
    expect(w.opensAt).toEqual(new Date(weeksAgo(2).getTime() + 4 * 7 * 86_400_000));
    expect(w.closesAt).toEqual(new Date(weeksAgo(2).getTime() + 8 * 7 * 86_400_000));
  });

  it("issued 5 weeks ago → open (framed/dried-in)", () => {
    const w = drywallBidWindow({ ...base, stage: "permit_issued", issuedAt: weeksAgo(5) });
    expect(w.status).toBe("open");
    expect(w.note).toMatch(/bid window is open/i);
  });

  it("window stays open through week 10 (crews locked 3–4 wks ahead)", () => {
    expect(
      drywallBidWindow({ ...base, stage: "permit_issued", issuedAt: weeksAgo(10) }).status,
    ).toBe("open");
    expect(
      drywallBidWindow({ ...base, stage: "permit_issued", issuedAt: weeksAgo(11) }).status,
    ).toBe("likely_closed");
  });

  it("stage construction uses the same issuance clock", () => {
    expect(drywallBidWindow({ ...base, stage: "construction", issuedAt: weeksAgo(6) }).status).toBe(
      "open",
    );
  });

  it("issued but no stated date → watch (never fabricates a date)", () => {
    const w = drywallBidWindow({ ...base, stage: "permit_issued", issuedAt: null });
    expect(w.status).toBe("watch");
    expect(w.opensAt).toBeNull();
  });

  it("pre-issuance stages → watch; late stages → likely_closed", () => {
    expect(drywallBidWindow({ ...base, stage: "permit_applied", issuedAt: null }).status).toBe(
      "watch",
    );
    expect(drywallBidWindow({ ...base, stage: "entitlement", issuedAt: null }).status).toBe(
      "watch",
    );
    expect(drywallBidWindow({ ...base, stage: "near_final", issuedAt: null }).status).toBe(
      "likely_closed",
    );
  });
});

describe("drywallBidWindow — commercial (2–6 months BEFORE permit)", () => {
  const base = { track: "commercial" as const, now: NOW, issuedAt: null };

  it("in plan review (applied/entitlement/CDs) → open NOW", () => {
    for (const stage of [
      "permit_applied",
      "entitlement",
      "approved",
      "construction_documents",
      "preapplication",
    ]) {
      const w = drywallBidWindow({ ...base, stage });
      expect(w.status).toBe("open");
      expect(w.note).toMatch(/before the permit issues/);
    }
  });

  it("permit issued → likely_closed with the addendum caveat", () => {
    const w = drywallBidWindow({ ...base, stage: "permit_issued", issuedAt: weeksAgo(1) });
    expect(w.status).toBe("likely_closed");
    expect(w.note).toMatch(/[Aa]ddendum/);
  });

  it("concept → watch (CDs not in review yet)", () => {
    expect(drywallBidWindow({ ...base, stage: "concept" }).status).toBe("watch");
  });
});

describe("paint — a finish trade on a later clock (6–12 wks after issuance)", () => {
  const base = { trade: "paint" as const, track: "residential" as const, now: NOW };

  it("issued 5 weeks ago → drywall is OPEN but paint still opens_soon", () => {
    const issuedAt = weeksAgo(5);
    expect(drywallBidWindow({ stage: "permit_issued", track: "residential", issuedAt, now: NOW }).status).toBe("open");
    const paint = tradeBidWindow({ ...base, stage: "permit_issued", issuedAt });
    expect(paint.status).toBe("opens_soon");
    expect(paint.note).toMatch(/~1 week/);
  });

  it("issued 8 weeks ago → open (framing/drywall phase, painters walk the site)", () => {
    const w = tradeBidWindow({ ...base, stage: "permit_issued", issuedAt: weeksAgo(8) });
    expect(w.status).toBe("open");
    expect(w.note).toMatch(/walk the site/);
  });

  it("stays open through week 14, likely_closed after", () => {
    expect(tradeBidWindow({ ...base, stage: "permit_issued", issuedAt: weeksAgo(14) }).status).toBe("open");
    expect(tradeBidWindow({ ...base, stage: "permit_issued", issuedAt: weeksAgo(15) }).status).toBe("likely_closed");
  });

  it("commercial paint rides the same pre-permit GMP buyout, with the late-mobilization caveat once issued", () => {
    const open = tradeBidWindow({ trade: "paint", track: "commercial", stage: "permit_applied", issuedAt: null, now: NOW });
    expect(open.status).toBe("open");
    expect(open.note).toMatch(/Commercial paint/);
    const closed = tradeBidWindow({ trade: "paint", track: "commercial", stage: "permit_issued", issuedAt: null, now: NOW });
    expect(closed.status).toBe("likely_closed");
    expect(closed.note).toMatch(/late-package/);
  });

  it("PNW season caveat: paint execution landing in Nov–Apr gets the wet-season heads-up", () => {
    // Issued mid-August → execution midpoint ≈ late November → caveat.
    const winter = tradeBidWindow({
      ...base,
      stage: "permit_issued",
      issuedAt: new Date("2026-08-15T00:00:00Z"),
      now: new Date("2026-09-15T00:00:00Z"),
    });
    expect(winter.note).toMatch(/Nov–Apr wet season/);
    // Issued March → execution midpoint ≈ June → no caveat.
    const summer = tradeBidWindow({
      ...base,
      stage: "permit_issued",
      issuedAt: new Date("2026-03-01T00:00:00Z"),
      now: new Date("2026-04-01T00:00:00Z"),
    });
    expect(summer.note).not.toMatch(/wet season/);
  });

  it("the season caveat never touches drywall (interior/structural trade)", () => {
    const w = drywallBidWindow({
      stage: "permit_issued",
      track: "residential",
      issuedAt: new Date("2026-08-15T00:00:00Z"),
      now: new Date("2026-09-15T00:00:00Z"),
    });
    expect(w.note).not.toMatch(/wet season/);
  });
});

describe("tradeBidWindows — both Solis trades at once", () => {
  it("returns drywall first (structural before finish), each with its own clock", () => {
    const both = tradeBidWindows({
      stage: "permit_issued",
      track: "residential",
      issuedAt: weeksAgo(5),
      now: NOW,
    });
    expect(both.map((w) => w.trade)).toEqual(["drywall", "paint"]);
    expect(both[0]!.status).toBe("open");
    expect(both[1]!.status).toBe("opens_soon");
  });
});

describe("trade scoping (owner directive 2026-07-22) — windows only for modeled trades", () => {
  const openInput = {
    stage: "permit_issued",
    track: "residential" as const,
    issuedAt: weeksAgo(6),
    now: NOW,
  };

  it("maps Solis capabilities (drywall, painting) to both modeled trades, drywall first", () => {
    expect(windowTradesFor(["drywall", "painting"])).toEqual(["drywall", "paint"]);
    expect(windowTradesFor(["painting", "drywall"])).toEqual(["drywall", "paint"]);
  });

  it("unmodeled trades map to NOTHING — never a borrowed clock", () => {
    expect(windowTradesFor(["electrical"])).toEqual([]);
    expect(windowTradesFor(["excavation", "roofing", "hvac"])).toEqual([]);
  });

  it("mixed capabilities scope to the modeled subset only", () => {
    expect(windowTradesFor(["electrical", "painting"])).toEqual(["paint"]);
  });

  it("dedupes paint/painting and survives junk entries", () => {
    expect(windowTradesFor(["paint", "painting", 42, null, undefined])).toEqual(["paint"]);
    expect(windowTradesFor([])).toEqual([]);
  });

  it("interior-finish account gets per-trade windows (drywall open at wk 6)", () => {
    const windows = accountBidWindows(["drywall", "painting"], openInput);
    expect(windows.map((w) => w.trade)).toEqual(["drywall", "paint"]);
    expect(windows[0]!.status).toBe("open");
  });

  it("an electrical account gets an EMPTY array — honest nothing", () => {
    expect(accountBidWindows(["electrical"], openInput)).toEqual([]);
  });

  it("paint-only account gets only the paint window", () => {
    const windows = accountBidWindows(["painting"], openInput);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.trade).toBe("paint");
  });
});

describe("drywallBidWindow — invariants", () => {
  it("bidding_confirmed (the explicit-solicitation FACT) beats the model on both tracks", () => {
    for (const track of ["residential", "commercial"] as const) {
      const w = drywallBidWindow({ stage: "bidding_confirmed", track, issuedAt: null, now: NOW });
      expect(w.status).toBe("confirmed_open");
    }
  });

  it("withdrawn is dead on both tracks", () => {
    for (const track of ["residential", "commercial"] as const) {
      expect(
        drywallBidWindow({ stage: "withdrawn", track, issuedAt: null, now: NOW }).status,
      ).toBe("likely_closed");
    }
  });

  it("every note reads as typical-sequencing language, never a promise", () => {
    const samples = [
      drywallBidWindow({ stage: "permit_issued", track: "residential", issuedAt: weeksAgo(5), now: NOW }),
      drywallBidWindow({ stage: "permit_applied", track: "commercial", issuedAt: null, now: NOW }),
      drywallBidWindow({ stage: "permit_issued", track: "commercial", issuedAt: null, now: NOW }),
    ];
    for (const w of samples) expect(w.note).toMatch(/typical/i);
  });
});
