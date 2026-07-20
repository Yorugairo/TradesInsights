import { describe, expect, it } from "vitest";
import {
  buildTradeMatcher,
  FALLBACK_TRADE_MATCHER,
  fetchTradeTaxonomy,
  type TradeTaxonomyRow,
} from "./trade-taxonomy.js";
import type { RegistryPoolLike } from "./registry-link.js";

function row(over: Partial<TradeTaxonomyRow>): TradeTaxonomyRow {
  return { tradeCode: "x", label: "X", keywords: [], parentCode: null, active: true, ...over };
}

const SAMPLE: TradeTaxonomyRow[] = [
  row({ tradeCode: "drywall", label: "Drywall", keywords: ["drywall", "gypsum", "sheetrock"] }),
  row({ tradeCode: "painting", label: "Painting", keywords: ["paint", "painting"] }),
  row({ tradeCode: "glazing", label: "Glazing", keywords: ["glazing", "glass", "curtain wall", "storefront"] }),
  row({ tradeCode: "signage", label: "Signage", keywords: ["sign", "signage"] }),
];

describe("buildTradeMatcher", () => {
  const m = buildTradeMatcher(SAMPLE);

  it("maps a keyword to its trade code", () => {
    expect(m.match("INTERIOR DRYWALL AND TAPE")).toEqual(["drywall"]);
    expect(m.match("STOREFRONT GLASS REPLACEMENT").sort()).toEqual(["glazing"]);
  });

  it("emits every distinct trade present in the text", () => {
    expect(m.match("DRYWALL AND PAINT, NEW GLASS").sort()).toEqual(["drywall", "glazing", "painting"]);
  });

  it("respects word boundaries — no substring false positives", () => {
    // "glass" must not fire on "GLASSFORD", "sign" must not fire on "DESIGN".
    expect(m.match("1420 GLASSFORD LN")).toEqual([]);
    expect(m.match("ARCHITECTURAL DESIGN REVIEW")).toEqual([]);
  });

  it("matches multi-word phrases", () => {
    expect(m.match("INSTALL CURTAIN WALL SYSTEM")).toEqual(["glazing"]);
  });

  it("drops inactive rows and rows with no keywords", () => {
    const built = buildTradeMatcher([
      row({ tradeCode: "roofing", keywords: ["roof"], active: false }),
      row({ tradeCode: "empty", keywords: [] }),
      row({ tradeCode: "electrical", keywords: ["electrical"] }),
    ]);
    expect(built.codes).toEqual(["electrical"]);
    expect(built.match("ROOF REPAIR")).toEqual([]);
  });

  it("returns [] for empty text", () => {
    expect(m.match("")).toEqual([]);
  });
});

describe("FALLBACK_TRADE_MATCHER (pre-taxonomy skip-safe vocabulary)", () => {
  it("maps only explicit trade signals, never a generic building permit", () => {
    expect(FALLBACK_TRADE_MATCHER.match("BUILDING/RESIDENTIAL BUILDING/DWELLING-SINGLE/NA")).toEqual([]);
  });

  it("preserves the historical permit-type mappings", () => {
    expect(FALLBACK_TRADE_MATCHER.match("SPRINKLER")).toEqual(["fire_sprinkler"]);
    expect(FALLBACK_TRADE_MATCHER.match("MECHANICAL")).toEqual(["mechanical"]);
  });

  it("catches roofing morphology (ROOF / ROOFING / REROOF) under word boundaries", () => {
    expect(FALLBACK_TRADE_MATCHER.match("ROOF")).toEqual(["roofing"]);
    expect(FALLBACK_TRADE_MATCHER.match("ROOFING")).toEqual(["roofing"]);
    expect(FALLBACK_TRADE_MATCHER.match("REROOF")).toEqual(["roofing"]);
  });
});

describe("fetchTradeTaxonomy", () => {
  it("maps contract-view rows to TradeTaxonomyRow", async () => {
    const pool: RegistryPoolLike = {
      query: async () => ({
        rows: [
          { trade_code: "drywall", label: "Drywall", keywords: ["drywall", "gypsum"], parent_code: null, active: true },
          { trade_code: "glazing", label: null, keywords: null, parent_code: "finishes", active: null },
        ],
      }),
    };
    const rows = await fetchTradeTaxonomy(pool);
    expect(rows).not.toBeNull();
    expect(rows![0]).toEqual({
      tradeCode: "drywall", label: "Drywall", keywords: ["drywall", "gypsum"], parentCode: null, active: true,
    });
    // null label falls back to the code; null keywords → []; null active → true.
    expect(rows![1]).toEqual({
      tradeCode: "glazing", label: "glazing", keywords: [], parentCode: "finishes", active: true,
    });
  });

  it("is SKIP-SAFE — returns null when the view read throws (view absent / denied)", async () => {
    const pool: RegistryPoolLike = {
      query: async () => {
        throw new Error('relation "registry_public.trades_taxonomy_v1" does not exist');
      },
    };
    expect(await fetchTradeTaxonomy(pool)).toBeNull();
  });
});
