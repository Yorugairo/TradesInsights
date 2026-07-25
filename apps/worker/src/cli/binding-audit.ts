import "../load-env.js";
import { createDb, createPool, createRegistryPool } from "@otn/db";
import { sql } from "drizzle-orm";
import { createLogger } from "@otn/source-sdk";
import {
  crossNameKey,
  fetchRegistryIdentityRows,
  isGenericName,
  isPersonShapedOrgName,
  nameSimilarity,
} from "@otn/resolution";

// pnpm binding-audit                 (all unbound orgs — the strategic view)
// pnpm binding-audit --scope=primary (just primary contractors)
// pnpm binding-audit --samples=20
//
// WHY THIS EXISTS: 20 of 3,797 organizations are bound to a registry entity —
// 0.5%. The registry side is rich (100% licence, 99.9% phone), the ingestion side
// is healthy, and the JOIN between them barely exists. A 278-row review queue
// cannot bind 3,777 orgs, so the constraint is candidate GENERATION, not review
// throughput. This measures why candidates are not being generated.
//
// THE QUESTION THIS ANSWERS: is `no_registry_name_match` caused by the registry
// holding only ~36% of WA's licensed contractors (26,934 of 75,364 L&I records),
// or by fixable matching? A bucket count alone cannot tell those apart, so every
// unmatched name also gets a NEAR-MATCH probe:
//   near_match_fixable   — a registry name is similar enough that better matching
//                          (aliases, DBA, tokenisation) could plausibly reach it
//   absent_from_registry — nothing in the registry resembles it, so no matching
//                          work will find it; only loading the rest of L&I will
// That split is the difference between "build better matching" and "finish the
// data load", and it is the one number the strategy turns on.
//
// READ-ONLY. No --apply, deliberately: nothing here should be able to bind.
//
// DO NOT FRAME ANY BUCKET AS ENRICHMENT-ADDRESSABLE. `google_name` is NOT a
// match key — the binding index is built from canonicalName, aliases and brands
// only. Google names feed confirmation EVIDENCE and the review tier, never the
// index, so no amount of Google enrichment moves a row out of the unmatched set.
//
// SCORING AUTHORITY IS THE SHARED CODE. Exact keys use the binder's own
// `crossNameKey`; similarity uses the shared `nameSimilarity`. The inverted token
// index below is ONLY a shortlist generator (to avoid 3,777 x 25,545 comparisons)
// — it never decides anything, so it cannot drift into a second normalizer.
function numericArg(name: string, dflt: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const n = Number(hit.slice(name.length + 3));
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function stringArg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

/** Names carrying a parser artifact rather than a business name. */
function isPrefixNoise(name: string): boolean {
  return /^\s*[*]/.test(name) || /^\s*[A-Z ]{3,}:/.test(name);
}

/** Similarity at or above which better matching could plausibly close the gap.
 * Jaccard over significant tokens: 0.5 means half the meaningful words agree,
 * e.g. "OZ CONSTRUCTION" vs "OZ CONSTRUCTION GROUP". Below this the names are
 * usually different businesses, not a normalisation miss. */
const NEAR_MATCH_FLOOR = 0.5;

type Bucket =
  | "prefix_noise"
  | "person_shaped"
  | "generic"
  | "exact_match_ambiguous"
  | "exact_match_no_candidate"
  | "near_match_fixable"
  | "absent_from_registry";

/** Indexing-only tokenisation. Shortlist generation, never a decision. */
const INDEX_STOPWORDS = new Set([
  "LLC", "INC", "CO", "CORP", "CORPORATION", "COMPANY", "LTD", "LP", "LLP", "PLLC",
  "THE", "AND", "OF", "II", "III",
  "CONSTRUCTION", "CONTRACTING", "CONTRACTORS", "CONTRACTOR", "SERVICES", "SERVICE",
  "BUILDERS", "BUILDING", "GROUP", "ENTERPRISES", "SOLUTIONS", "SYSTEMS",
]);
function indexTokens(name: string): string[] {
  return [
    ...new Set(
      name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/)
        .filter((t) => t.length > 2 && !INDEX_STOPWORDS.has(t)),
    ),
  ];
}

/** A token shared by this many entities carries no discriminating signal. */
const TOKEN_FANOUT_CAP = 400;

async function main() {
  const samples = numericArg("samples", 10);
  const scope = stringArg("scope", "all");
  const primaryOnly = scope === "primary";
  const logger = createLogger({ app: "binding-audit" });
  const pool = createPool();
  const db = createDb(pool);
  const registryPool = createRegistryPool();
  try {
    if (!registryPool) {
      logger.info({ skipped: true }, "no REGISTRY_DATABASE_URL — binding audit cannot run");
      return;
    }

    // Population + the role that matters most for each org. An org can hold
    // several roles; primary_contractor outranks applicant outranks owner,
    // because that is the order of how much the identity is worth.
    const res = await db.execute(sql`
      SELECT o.id, o.canonical_name,
        CASE
          WHEN bool_or(pr.role = 'primary_contractor') THEN 'primary_contractor'
          WHEN bool_or(pr.role = 'applicant')          THEN 'applicant'
          WHEN bool_or(pr.role = 'owner')              THEN 'owner'
          WHEN count(pr.role) > 0                      THEN 'other'
          ELSE 'none'
        END AS top_role,
        (o.registry_ref IS NOT NULL) AS bound,
        EXISTS (SELECT 1 FROM registry_observations ro
                WHERE ro.organization_id = o.id AND ro.status = 'pending') AS has_candidate
      FROM organizations o
      LEFT JOIN project_roles pr ON pr.organization_id = o.id
      GROUP BY o.id, o.canonical_name, o.registry_ref`);

    interface Org { id: string; name: string; role: string; bound: boolean; hasCandidate: boolean }
    const all: Org[] = (res.rows as Record<string, unknown>[]).map((r) => ({
      id: String(r["id"]),
      name: String(r["canonical_name"] ?? ""),
      role: String(r["top_role"]),
      bound: r["bound"] === true,
      hasCandidate: r["has_candidate"] === true,
    }));

    const roleCounts: Record<string, number> = {};
    for (const o of all) roleCounts[o.role] = (roleCounts[o.role] ?? 0) + 1;

    // The population this audit explains: unbound, no candidate. A bound org
    // needs nothing; an org with a candidate is already the reviewer's problem.
    const target = all.filter(
      (o) => !o.bound && !o.hasCandidate && (!primaryOnly || o.role === "primary_contractor"),
    );

    // Binder's exact index: canonicalName + aliases + brands under crossNameKey.
    const registryRows = await fetchRegistryIdentityRows(registryPool);
    const byKey = new Map<string, Set<string>>();
    const nameByEntity = new Map<string, string>();
    const byToken = new Map<string, Set<string>>();
    const addKey = (key: string, entityId: string) => {
      if (!key) return;
      const hit = byKey.get(key);
      if (hit) hit.add(entityId);
      else byKey.set(key, new Set([entityId]));
    };
    const addTokens = (name: string, entityId: string) => {
      for (const t of indexTokens(name)) {
        const hit = byToken.get(t);
        if (hit) hit.add(entityId);
        else byToken.set(t, new Set([entityId]));
      }
    };
    for (const row of registryRows) {
      if (row.canonicalName) {
        addKey(crossNameKey(row.canonicalName), row.entityId);
        addTokens(row.canonicalName, row.entityId);
        nameByEntity.set(row.entityId, row.canonicalName);
      }
      for (const alias of row.aliases ?? []) {
        if (typeof alias === "string" && alias.length > 0) {
          addKey(crossNameKey(alias), row.entityId);
          addTokens(alias, row.entityId);
        }
      }
      for (const brand of row.brands ?? []) {
        addKey(crossNameKey(brand.name), row.entityId);
        addTokens(brand.name, row.entityId);
      }
    }

    const buckets = new Map<Bucket, string[]>();
    const put = (b: Bucket, s: string) => {
      const hit = buckets.get(b);
      if (hit) hit.push(s);
      else buckets.set(b, [s]);
    };
    // Per-role tallies — the numbers Phase 1 is sized on.
    const fixableByRole: Record<string, number> = {};
    const absentByRole: Record<string, number> = {};
    const exactByRole: Record<string, number> = {};

    for (const org of target) {
      // Most-specific reason first: a name can satisfy several tests, and the
      // FIRST one is the actionable defect.
      if (isPrefixNoise(org.name)) { put("prefix_noise", org.name); continue; }
      if (isPersonShapedOrgName(org.name)) { put("person_shaped", org.name); continue; }
      if (isGenericName(org.name)) { put("generic", org.name); continue; }

      const entities = byKey.get(crossNameKey(org.name));
      if (entities && entities.size > 1) { put("exact_match_ambiguous", org.name); continue; }
      if (entities && entities.size === 1) {
        put("exact_match_no_candidate", org.name);
        exactByRole[org.role] = (exactByRole[org.role] ?? 0) + 1;
        continue;
      }

      // No exact key. Shortlist by shared significant token, then score with the
      // SHARED similarity function.
      const shortlist = new Set<string>();
      for (const t of indexTokens(org.name)) {
        const hit = byToken.get(t);
        if (!hit || hit.size > TOKEN_FANOUT_CAP) continue;
        for (const e of hit) shortlist.add(e);
      }
      let best = 0;
      let bestName = "";
      for (const e of shortlist) {
        const rn = nameByEntity.get(e);
        if (!rn) continue;
        const s = nameSimilarity(org.name, rn);
        if (s > best) { best = s; bestName = rn; }
      }
      if (best >= NEAR_MATCH_FLOOR) {
        put("near_match_fixable", `${org.name}  ~${best.toFixed(2)}~  ${bestName}`);
        fixableByRole[org.role] = (fixableByRole[org.role] ?? 0) + 1;
      } else {
        put(
          "absent_from_registry",
          bestName ? `${org.name}  (best ${best.toFixed(2)}: ${bestName})` : org.name,
        );
        absentByRole[org.role] = (absentByRole[org.role] ?? 0) + 1;
      }
    }

    const counts: Record<string, number> = {};
    for (const [b, n] of buckets) counts[b] = n.length;
    const bucketed = Object.values(counts).reduce((n, v) => n + v, 0);

    logger.info(
      {
        scope,
        orgsTotal: all.length,
        bound: all.filter((o) => o.bound).length,
        withPendingCandidate: all.filter((o) => o.hasCandidate).length,
        explained: target.length,
        bucketed,
        byRole: roleCounts,
        counts,
        registryEntities: registryRows.length,
        exactKeys: byKey.size,
      },
      "binding audit — why these organizations have no candidate",
    );

    logger.info(
      {
        // THE PHASE-1 BUSINESS CASE. exact = bindable with today's data and
        // today's matcher. reachable = better matching could plausibly find it.
        // absent = only finishing the L&I load can.
        exactMatchAlreadyAvailable: exactByRole,
        reachableByBetterMatching: fixableByRole,
        needsFullLniLoad: absentByRole,
      },
      "fixable vs absent, split by role",
    );

    for (const [b, names] of [...buckets.entries()].sort((a, b2) => b2[1].length - a[1].length)) {
      logger.info({ bucket: b, count: names.length, samples: names.slice(0, samples) }, `bucket ${b}`);
    }
  } finally {
    await pool.end();
    await registryPool?.end?.();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
