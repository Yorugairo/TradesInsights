import { describe, expect, it } from "vitest";
import {
  groupByPlace,
  loadContestedPlaces,
  realConflicts,
  type ContestedPlaceRow,
} from "./google-place-contested.js";

const row = (over: Partial<ContestedPlaceRow>): ContestedPlaceRow => ({
  entityId: "e1",
  entityName: "Whidbey Sign Company LLC",
  googlePlaceId: "place-1",
  scrapedName: "Whidbey Sign Co",
  scrapedPhone: "(360) 555-0100",
  profileUrl: null,
  lniName: "Whidbey Sign Company LLC",
  lniPhone: "360-555-0100",
  lniLicenseNumber: "WHIDBSC000XX",
  linkStatus: "relationship_pending",
  publicSurfacePolicy: "not_public_pending_review",
  competingEntityIds: [],
  rivalCount: 0,
  sharedLicenceCount: 2,
  ...over,
});

/** Minimal pool stub — the reader only ever calls `query`. */
const pool = (impl: () => Promise<{ rows: Record<string, unknown>[] }>) =>
  ({ query: impl }) as unknown as Parameters<typeof loadContestedPlaces>[0];

describe("loadContestedPlaces", () => {
  it("returns [] when the registry migration has not landed (42P01)", async () => {
    // The Insights deploy and the registry migration are not atomic, so a
    // missing view is an expected transient state, not a failure.
    const err = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    await expect(loadContestedPlaces(pool(() => Promise.reject(err)))).resolves.toEqual([]);
  });

  it("RETHROWS a permission error rather than reporting no conflicts", async () => {
    // 42501 must never look like "nothing is contested" — that is precisely the
    // shape of a silent seam outage, and it would read as a clean queue.
    const err = Object.assign(new Error("permission denied"), { code: "42501" });
    await expect(loadContestedPlaces(pool(() => Promise.reject(err)))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("maps competing_entity_ids into a string array", async () => {
    const rows = await loadContestedPlaces(
      pool(() =>
        Promise.resolve({
          rows: [
            {
              entity_id: "e1",
              entity_name: "A",
              google_place_id: "place-1",
              scraped_name: "A Co",
              scraped_phone: " (360) 555-0100 ",
              profile_url: null,
              lni_name: "A LLC",
              lni_phone: null,
              lni_license_number: "LIC1",
              link_status: "relationship_pending",
              public_surface_policy: "not_public_pending_review",
              competing_entity_ids: ["e2"],
              rival_count: 1,
              shared_licence_count: 2,
            },
          ],
        }),
      ),
    );
    expect(rows[0]?.competingEntityIds).toEqual(["e2"]);
    expect(rows[0]?.rivalCount).toBe(1);
    // Blank-ish strings normalize to null, and whitespace is trimmed.
    expect(rows[0]?.scrapedPhone).toBe("(360) 555-0100");
    expect(rows[0]?.lniPhone).toBeNull();
  });
});

describe("groupByPlace", () => {
  it("collapses several claimants of one listing into a single decision", () => {
    const groups = groupByPlace([
      row({ entityId: "e1", competingEntityIds: ["e2"], rivalCount: 1 }),
      row({ entityId: "e2", competingEntityIds: ["e1"], rivalCount: 1 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.claimants).toHaveLength(2);
    expect(groups[0]?.isRealConflict).toBe(true);
  });

  it("keeps separate listings separate", () => {
    const groups = groupByPlace([
      row({ googlePlaceId: "place-1" }),
      row({ googlePlaceId: "place-2" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("does NOT call one company holding two licences a conflict", () => {
    // THE LIVE CASE (139 of 143 rows on 2026-07-25): the same entity appears
    // once per licence. Two rows, one company, no conflict. Judging on
    // claimants.length instead of distinct entities would get this wrong.
    const groups = groupByPlace([
      row({ entityId: "e1", lniLicenseNumber: "ANDERDL789CQ" }),
      row({ entityId: "e1", lniLicenseNumber: "ANDERDL789TQ" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.claimants).toHaveLength(2);
    expect(groups[0]?.isRealConflict).toBe(false);
  });

  it("sorts genuine conflicts ahead of legacy mislabels", () => {
    const groups = groupByPlace([
      row({ googlePlaceId: "quiet", entityId: "e9" }),
      row({ googlePlaceId: "fight", entityId: "e1", competingEntityIds: ["e2"], rivalCount: 1 }),
      row({ googlePlaceId: "fight", entityId: "e2", competingEntityIds: ["e1"], rivalCount: 1 }),
    ]);
    expect(groups[0]?.googlePlaceId).toBe("fight");
    expect(groups[0]?.isRealConflict).toBe(true);
  });

  it("returns nothing for an empty read", () => {
    expect(groupByPlace([])).toEqual([]);
  });
});

describe("realConflicts", () => {
  it("keeps only the listings a human must adjudicate", () => {
    const groups = groupByPlace([
      row({ googlePlaceId: "quiet", entityId: "e9" }),
      row({ googlePlaceId: "fight", entityId: "e1", competingEntityIds: ["e2"], rivalCount: 1 }),
      row({ googlePlaceId: "fight", entityId: "e2", competingEntityIds: ["e1"], rivalCount: 1 }),
    ]);
    // 3 rows, 2 listings, but only ONE real decision — the distinction the
    // whole module exists to preserve.
    expect(groups).toHaveLength(2);
    expect(realConflicts(groups)).toHaveLength(1);
    expect(realConflicts(groups)[0]?.googlePlaceId).toBe("fight");
  });
});
