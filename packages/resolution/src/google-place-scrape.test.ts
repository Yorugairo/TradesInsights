import { describe, expect, it } from "vitest";
import {
  scoreGooglePlaceObservations,
  type GooglePlaceScrapeRow,
} from "./google-place-scrape.js";
import type { RegistryIdentityRow } from "./registry-link.js";

const identity = (over: Partial<RegistryIdentityRow>): RegistryIdentityRow => ({
  entityId: "e1",
  ubi: null,
  contractorNumbers: null,
  canonicalName: "Smith Fire Systems Inc",
  canonicalNameNormalized: "SMITH FIRE SYSTEMS INC",
  phone: "253-555-0100",
  cityToken: null,
  stateCode: "WA",
  registeredAddress: null,
  registeredPostalCode: null,
  ...over,
});

const obs = (over: Partial<GooglePlaceScrapeRow>): GooglePlaceScrapeRow => ({
  entityId: "e1",
  googlePlaceId: "place-1",
  lniLicenseNumber: "LIC1",
  scrapedName: "Smith Fire Systems, INC",
  scrapedPhone: "(253) 555-0100",
  scrapedAddress: null,
  scrapeStatus: "ok",
  fetchedAt: "2026-07-24T00:00:00Z",
  sharedLicenceCount: 1,
  ...over,
});

describe("scoreGooglePlaceObservations", () => {
  it("confirms when phone AND name agree, through the shared normalizer", () => {
    // Live shape: L&I "Smith Fire Systems Inc" vs Google "Smith Fire Systems,
    // INC" differ by a comma and case and are plainly the same business.
    const s = scoreGooglePlaceObservations([obs({})], [identity({})]);
    expect(s.byConfirmation.phone_and_name).toBe(1);
    expect(s.confirmed).toHaveLength(1);
    expect(s.confirmed[0]?.lniName).toBe("Smith Fire Systems Inc");
  });

  it("does NOT promote phone-only agreement", () => {
    // Circular: 2,962 of 2,980 existing links were made BY matching that phone,
    // so a phone match re-confirms the decision instead of testing it.
    const s = scoreGooglePlaceObservations(
      [obs({ scrapedName: "Completely Different Roofing LLC" })],
      [identity({})],
    );
    expect(s.byConfirmation.phone_only).toBe(1);
    expect(s.confirmed).toHaveLength(0);
  });

  it("records name-only agreement without confirming it", () => {
    const s = scoreGooglePlaceObservations(
      [obs({ scrapedPhone: "206-555-9999" })],
      [identity({})],
    );
    expect(s.byConfirmation.name_only).toBe(1);
    expect(s.confirmed).toHaveLength(0);
  });

  it("counts a total mismatch as none", () => {
    const s = scoreGooglePlaceObservations(
      [obs({ scrapedName: "Unrelated Bakery", scrapedPhone: "206-555-9999" })],
      [identity({})],
    );
    expect(s.byConfirmation.none).toBe(1);
  });

  it("skips unusable scrapes instead of judging them 'none'", () => {
    // A blocked scrape has no observation. Scoring it `none` would look like
    // evidence against the match rather than absence of evidence.
    const s = scoreGooglePlaceObservations(
      [obs({ scrapeStatus: "blocked" }), obs({ scrapeStatus: "error" })],
      [identity({})],
    );
    expect(s.skippedUnusableStatus).toBe(2);
    expect(s.byConfirmation.none).toBe(0);
    expect(s.observations).toBe(2);
  });

  it("skips entities absent from the identity contract, counting them", () => {
    const s = scoreGooglePlaceObservations([obs({ entityId: "ghost" })], [identity({})]);
    expect(s.skippedUnknownEntity).toBe(1);
    expect(s.confirmed).toHaveLength(0);
  });

  it("flags a place id confirmed by more than one licence as contested", () => {
    // The owner's case: one listing bridged to several contractors. A listing
    // cannot belong to two companies, so two confirmations is a contradiction.
    const s = scoreGooglePlaceObservations(
      [
        obs({ entityId: "e1", lniLicenseNumber: "LIC1", sharedLicenceCount: 2 }),
        obs({ entityId: "e2", lniLicenseNumber: "LIC2", sharedLicenceCount: 2 }),
      ],
      [
        identity({ entityId: "e1" }),
        // Same name and phone on a second entity — exactly how a shared listing
        // produces two "confirmations".
        identity({ entityId: "e2" }),
      ],
    );
    expect(s.confirmed).toHaveLength(2);
    expect(s.contestedPlaceIds).toEqual(["place-1"]);
  });

  it("does not flag a place id confirmed by exactly one licence", () => {
    const s = scoreGooglePlaceObservations(
      [
        obs({ entityId: "e1", lniLicenseNumber: "LIC1", sharedLicenceCount: 13 }),
        obs({ entityId: "e2", lniLicenseNumber: "LIC2", scrapedName: "Other Co" }),
      ],
      [identity({ entityId: "e1" }), identity({ entityId: "e2", canonicalName: "Nope Inc" })],
    );
    expect(s.confirmed).toHaveLength(1);
    // 13 licences share the place, but only one of them confirms — the whole
    // point of re-scoring rejects per licence rather than per place.
    expect(s.contestedPlaceIds).toEqual([]);
  });

  it("handles an empty input without inventing counts", () => {
    const s = scoreGooglePlaceObservations([], []);
    expect(s).toMatchObject({
      observations: 0,
      skippedUnusableStatus: 0,
      skippedUnknownEntity: 0,
      confirmed: [],
      contestedPlaceIds: [],
    });
  });

  it("never mutates the rows it is given", () => {
    const rows = [obs({})];
    const before = JSON.stringify(rows);
    scoreGooglePlaceObservations(rows, [identity({})]);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
