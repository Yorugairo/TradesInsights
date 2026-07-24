import { describe, expect, it } from "vitest";
import type { RegistryPoolLike } from "./registry-link.js";
import {
  fetchGooglePlaceBlockedSummary,
  fetchGooglePlaceReviewRows,
  isGooglePlaceReviewState,
} from "./google-place-review.js";

const VIEW_ROW: Record<string, unknown> = {
  review_id: 4321,
  review_state: "actionable",
  reason: "google_phone_differs_from_lni",
  priority: 3,
  entity_id: "ent-1",
  entity_name: "Marr's Heating & A/C Inc",
  ubi: "601429770",
  lni_business_name: "Marr'S Heating & A/C Inc",
  lni_license_number: "MARRSHC741CE",
  lni_license_type: "EC",
  lni_address: "1677 Mt Baker Hwy",
  lni_city: "Bellingham",
  lni_state_code: "WA",
  lni_zip: "98226",
  lni_phone: "3607344455",
  google_place_id: "ChIJLyXIExClhVQRVwU3wh5bK-c",
  google_name: "Marr's Heating, AC, Plumbing & Electrical",
  google_phone: "(855) 202-7062",
  google_address: "1677 Mt Baker Hwy, Bellingham, WA 98226",
  google_website: "https://www.marrsheating.com/",
  google_category: "HVAC contractor",
  google_maps_url: "https://www.google.com/maps/search/?api=1",
  google_rating: "4.9",
  google_review_count: "1970",
  match_status: "ambiguous",
  match_method: "place_conflict",
  match_confidence: "0.47",
  match_conflict_flags: ["phone_conflict", "place_id_multiple_lni"],
  created_at: "2026-07-18T08:17:49.477Z",
};

/** A pool that records the SQL it was asked to run and returns fixed rows. */
function stubPool(rows: Record<string, unknown>[], sink?: string[]): RegistryPoolLike {
  return {
    query: async (text: string) => {
      sink?.push(text);
      return { rows };
    },
  };
}

/** A pool that throws a driver-shaped error. */
function throwingPool(code: string): RegistryPoolLike {
  return {
    query: async () => {
      throw Object.assign(new Error(`relation does not exist (${code})`), { code });
    },
  };
}

describe("fetchGooglePlaceReviewRows", () => {
  it("maps the contract view onto the typed row, coercing text numerics", async () => {
    const [row] = await fetchGooglePlaceReviewRows(stubPool([VIEW_ROW]));
    expect(row!.reviewId).toBe(4321);
    expect(row!.reviewState).toBe("actionable");
    expect(row!.entityName).toBe("Marr's Heating & A/C Inc");
    expect(row!.lni.licenseNumber).toBe("MARRSHC741CE");
    // The view keeps these as text so one bad scrape cannot break it; we coerce.
    expect(row!.google.rating).toBe(4.9);
    expect(row!.google.reviewCount).toBe(1970);
    expect(row!.match.confidence).toBeCloseTo(0.47);
    expect(row!.match.conflictFlags).toEqual(["phone_conflict", "place_id_multiple_lni"]);
  });

  it("treats an unrecognised review_state as not-actionable", async () => {
    const [row] = await fetchGooglePlaceReviewRows(stubPool([{ ...VIEW_ROW, review_state: "brand_new_state" }]));
    expect(row!.reviewState).toBe("awaiting_evidence");
  });

  it("returns [] when the contract view does not exist yet (deploy-order degrade)", async () => {
    await expect(fetchGooglePlaceReviewRows(throwingPool("42P01"))).resolves.toEqual([]);
    await expect(fetchGooglePlaceBlockedSummary(throwingPool("42P01"))).resolves.toEqual([]);
  });

  it("rethrows every other error — a permission failure is not 'no rows'", async () => {
    await expect(fetchGooglePlaceReviewRows(throwingPool("42501"))).rejects.toThrow(/does not exist/);
    await expect(fetchGooglePlaceBlockedSummary(throwingPool("42501"))).rejects.toThrow(/does not exist/);
  });

  it("only interpolates a whitelisted state and a bounded limit", async () => {
    const sql: string[] = [];
    await fetchGooglePlaceReviewRows(stubPool([], sql), {
      state: "drop table" as never,
      limit: 10_000,
    });
    expect(sql[0]).not.toContain("drop table");
    expect(sql[0]).not.toContain("WHERE");
    expect(sql[0]).toContain("LIMIT 500");
  });

  it("filters by a valid state", async () => {
    const sql: string[] = [];
    await fetchGooglePlaceReviewRows(stubPool([], sql), { state: "actionable" });
    expect(sql[0]).toContain("WHERE review_state = 'actionable'");
  });
});

describe("fetchGooglePlaceBlockedSummary", () => {
  it("maps reason counts", async () => {
    const rows = await fetchGooglePlaceBlockedSummary(
      stubPool([{ review_state: "awaiting_auto_resolver", reason: "Potential duplicate…", n: 920 }]),
    );
    expect(rows).toEqual([
      { reviewState: "awaiting_auto_resolver", reason: "Potential duplicate…", count: 920 },
    ]);
  });
});

describe("isGooglePlaceReviewState", () => {
  it("accepts the three contract values and rejects anything else", () => {
    expect(isGooglePlaceReviewState("actionable")).toBe(true);
    expect(isGooglePlaceReviewState("awaiting_auto_resolver")).toBe(true);
    expect(isGooglePlaceReviewState("awaiting_evidence")).toBe(true);
    expect(isGooglePlaceReviewState("resolved")).toBe(false);
    expect(isGooglePlaceReviewState(null)).toBe(false);
  });
});
