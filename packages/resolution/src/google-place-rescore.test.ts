import { describe, expect, it } from "vitest";
import {
  buildGooglePlaceExports,
  googlePlaceDedupeKey,
  GOOGLE_PLACE_CONFIRMED_TRUST,
  GOOGLE_PLACE_CONTESTED_TRUST,
} from "./google-place-rescore.js";
import type { GooglePlaceScoreSummary, ScoredGooglePlaceObservation } from "./google-place-scrape.js";

const confirmed = (over: Partial<ScoredGooglePlaceObservation>): ScoredGooglePlaceObservation => ({
  entityId: "e1",
  googlePlaceId: "place-1",
  lniLicenseNumber: "LIC1",
  lniName: "Example Roofing Inc",
  scrapedName: "Example Roofing",
  scrapedPhone: "253-555-0100",
  sharedLicenceCount: 1,
  confirmation: "phone_and_name",
  ...over,
});

const summary = (over: Partial<GooglePlaceScoreSummary>): GooglePlaceScoreSummary => ({
  observations: 0,
  skippedUnusableStatus: 0,
  skippedUnknownEntity: 0,
  byConfirmation: { phone_and_name: 0, phone_only: 0, name_only: 0, none: 0 },
  confirmed: [],
  contestedPlaceIds: [],
  ...over,
});

describe("googlePlaceDedupeKey", () => {
  it("is stable for the same pair, so a re-export is a no-op", () => {
    expect(googlePlaceDedupeKey("e1", "place-1")).toBe(googlePlaceDedupeKey("e1", "place-1"));
  });

  it("separates the same place claimed by different entities", () => {
    // Must NOT collapse: a shared place legitimately produces one row per entity.
    expect(googlePlaceDedupeKey("e1", "place-1")).not.toBe(googlePlaceDedupeKey("e2", "place-1"));
  });

  it("is namespaced under the registry loader's source_system constant", () => {
    // Matches the convention every other export type on partner_observations
    // uses (${SOURCE_SYSTEM}:${...}) — and 'otn_insights' specifically must
    // match, because the loader's pending-row query filters on that literal.
    expect(googlePlaceDedupeKey("e1", "place-1")).toContain("otn_insights");
  });
});

describe("buildGooglePlaceExports", () => {
  it("marks an uncontested confirmation and gives it full trust", () => {
    const rows = buildGooglePlaceExports(summary({ confirmed: [confirmed({})] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contested).toBe(false);
    expect(rows[0]?.trustScore).toBe(GOOGLE_PLACE_CONFIRMED_TRUST);
    expect(rows[0]?.competingEntityIds).toEqual([]);
  });

  it("EXPORTS contested rows rather than dropping them, at lower trust", () => {
    // Dropping them would leave a genuine conflict looking unexamined forever.
    // The registry needs to see it in order to resolve it.
    const rows = buildGooglePlaceExports(
      summary({
        confirmed: [
          confirmed({ entityId: "e1", sharedLicenceCount: 2 }),
          confirmed({ entityId: "e2", lniLicenseNumber: "LIC2", sharedLicenceCount: 2 }),
        ],
        contestedPlaceIds: ["place-1"],
      }),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.contested)).toBe(true);
    expect(rows.every((r) => r.trustScore === GOOGLE_PLACE_CONTESTED_TRUST)).toBe(true);
  });

  it("gives each contested row the OTHER claimants, never itself", () => {
    const rows = buildGooglePlaceExports(
      summary({
        confirmed: [
          confirmed({ entityId: "e1" }),
          confirmed({ entityId: "e2" }),
          confirmed({ entityId: "e3" }),
        ],
        contestedPlaceIds: ["place-1"],
      }),
    );
    expect(rows.find((r) => r.entityId === "e1")?.competingEntityIds).toEqual(["e2", "e3"]);
    expect(rows.find((r) => r.entityId === "e3")?.competingEntityIds).toEqual(["e1", "e2"]);
  });

  it("keeps contested and uncontested places independent", () => {
    // A shared place being contested must not taint an unrelated confirmation.
    const rows = buildGooglePlaceExports(
      summary({
        confirmed: [
          confirmed({ entityId: "e1", googlePlaceId: "contested-place" }),
          confirmed({ entityId: "e2", googlePlaceId: "contested-place" }),
          confirmed({ entityId: "e9", googlePlaceId: "clean-place" }),
        ],
        contestedPlaceIds: ["contested-place"],
      }),
    );
    const clean = rows.find((r) => r.googlePlaceId === "clean-place");
    expect(clean?.contested).toBe(false);
    expect(clean?.trustScore).toBe(GOOGLE_PLACE_CONFIRMED_TRUST);
    expect(clean?.competingEntityIds).toEqual([]);
  });

  it("carries the licence count so the registry can see how shared the place is", () => {
    // Live: one place id bridges 77 licences.
    const rows = buildGooglePlaceExports(
      summary({ confirmed: [confirmed({ sharedLicenceCount: 77 })] }),
    );
    expect(rows[0]?.sharedLicenceCount).toBe(77);
    // Shared but only ONE confirmation, so not contested — that is the whole
    // point of judging per licence rather than per place.
    expect(rows[0]?.contested).toBe(false);
  });

  it("returns nothing when nothing was confirmed", () => {
    expect(buildGooglePlaceExports(summary({}))).toEqual([]);
  });

  it("preserves the L&I and Google names for review provenance", () => {
    const rows = buildGooglePlaceExports(summary({ confirmed: [confirmed({})] }));
    expect(rows[0]?.lniName).toBe("Example Roofing Inc");
    expect(rows[0]?.scrapedName).toBe("Example Roofing");
  });
});
