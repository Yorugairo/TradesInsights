import { describe, expect, it } from "vitest";
import { bidTrackFor, drywallBidWindow } from "./bid-window.js";

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
