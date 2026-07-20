import type { RegistryPoolLike } from "./registry-link.js";

/**
 * One row of registry_public.trades_taxonomy_v1 — the SHARED trade vocabulary
 * contract. The registry seeds this from authoritative WA L&I license
 * specialties (drywall / painting / glazing / …) with a curated keyword
 * dictionary per trade; Insights DERIVES its permit-text matcher from it, so
 * the two systems can never drift on what a trade is or which words name it.
 * Adding an L&I specialty to the registry automatically teaches Insights a new
 * trade — there is no second, hand-maintained list.
 */
export interface TradeTaxonomyRow {
  tradeCode: string;
  label: string;
  keywords: string[];
  parentCode: string | null;
  active: boolean;
}

/** A compiled keyword→trade_code matcher over permit text. */
export interface TradeMatcher {
  /** The trade codes this matcher can emit (for reporting / tests). */
  readonly codes: string[];
  /** Distinct trade codes whose keyword vocabulary appears in `text`. */
  match(text: string): string[];
}

/**
 * Read the shared trade vocabulary from the registry contract view. Mirrors
 * `fetchRegistryIdentityRows` — the reader role has SELECT on this view alone
 * (the contract boundary), never on registry_internal.
 *
 * SKIP-SAFE: returns null on any read error — including the view not yet
 * existing (a registry that published trades_identity_v1 but not yet the
 * taxonomy view) or a permission denial — so a partially-rolled-out contract
 * never breaks the nightly run. The caller then falls back to the built-in
 * default vocabulary (`FALLBACK_TRADE_MATCHER`).
 */
export async function fetchTradeTaxonomy(
  pool: RegistryPoolLike,
): Promise<TradeTaxonomyRow[] | null> {
  try {
    const res = await pool.query(
      `SELECT trade_code, label, keywords, parent_code, active
         FROM registry_public.trades_taxonomy_v1`,
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      tradeCode: r["trade_code"] as string,
      label: (r["label"] as string | null) ?? (r["trade_code"] as string),
      keywords: ((r["keywords"] as unknown[] | null) ?? []).filter(
        (k): k is string => typeof k === "string" && k.trim().length > 0,
      ),
      parentCode: (r["parent_code"] as string | null) ?? null,
      active: (r["active"] as boolean | null) ?? true,
    }));
  } catch {
    return null;
  }
}

/** Escape a keyword for safe use inside a RegExp alternation. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile taxonomy rows into a keyword→trade_code matcher. Each trade's keyword
 * list becomes a word-boundary alternation, so "glass" matches "GLASS DOORS"
 * but NOT "GLASSFORD LN", "sign" matches "SIGN PERMIT" but not "DESIGN", and a
 * multi-word phrase ("curtain wall") matches as a phrase. Word boundaries
 * matter because the matcher now scans free-text descriptions, not just the
 * short controlled permit-type vocabulary — so the seed dictionary must carry
 * morphological variants it wants to catch (e.g. roof / roofing / reroof).
 * Inactive rows and rows with no keywords are dropped.
 */
export function buildTradeMatcher(rows: TradeTaxonomyRow[]): TradeMatcher {
  const compiled: { code: string; re: RegExp }[] = [];
  for (const row of rows) {
    if (!row.active) continue;
    const kws = row.keywords.map((k) => k.trim()).filter((k) => k.length > 0);
    if (kws.length === 0) continue;
    // Longest-first so a multi-word phrase wins its alternation branch.
    kws.sort((a, b) => b.length - a.length);
    const re = new RegExp(`\\b(?:${kws.map(escapeRegExp).join("|")})\\b`, "i");
    compiled.push({ code: row.tradeCode, re });
  }
  return {
    codes: compiled.map((c) => c.code),
    match(text: string): string[] {
      if (!text) return [];
      const out: string[] = [];
      for (const { code, re } of compiled) {
        if (re.test(text) && !out.includes(code)) out.push(code);
      }
      return out;
    },
  };
}

/**
 * Built-in fallback vocabulary — the historical permit-type trade codes, used
 * SKIP-SAFELY when no registry taxonomy is available (no REGISTRY_DATABASE_URL,
 * or the taxonomy view not yet published). Keyword variants (roof/roofing/
 * reroof) reproduce the pre-taxonomy substring hits under word-boundary
 * matching. When the taxonomy is absent the caller scans permitType ONLY — so
 * behavior is byte-identical to the pre-taxonomy code path. Once the registry
 * publishes trades_taxonomy_v1 (seeded from L&I specialties incl. drywall /
 * painting / glazing), the derived matcher supersedes this and the finish-trade
 * gap closes.
 */
export const FALLBACK_TRADE_TAXONOMY: TradeTaxonomyRow[] = [
  { tradeCode: "mechanical", label: "Mechanical", keywords: ["mechanical"], parentCode: null, active: true },
  { tradeCode: "plumbing", label: "Plumbing", keywords: ["plumbing"], parentCode: null, active: true },
  { tradeCode: "electrical", label: "Electrical", keywords: ["electrical"], parentCode: null, active: true },
  { tradeCode: "fire_sprinkler", label: "Fire sprinkler", keywords: ["sprinkler"], parentCode: null, active: true },
  { tradeCode: "roofing", label: "Roofing", keywords: ["roof", "roofing", "reroof", "re-roof"], parentCode: null, active: true },
  { tradeCode: "demolition", label: "Demolition", keywords: ["demolition"], parentCode: null, active: true },
  { tradeCode: "signage", label: "Signage", keywords: ["sign", "signage"], parentCode: null, active: true },
];

export const FALLBACK_TRADE_MATCHER: TradeMatcher = buildTradeMatcher(FALLBACK_TRADE_TAXONOMY);
