import "../load-env.js";
import { createDb, createPool, createRegistryPool } from "@otn/db";
import { sql } from "drizzle-orm";
import { createLogger } from "@otn/source-sdk";
import {
  crossNameKey,
  fetchRegistryIdentityRows,
  isGenericName,
  isPersonShapedOrgName,
} from "@otn/resolution";

// pnpm binding-audit          (read-only — prints the bucket split)
// pnpm binding-audit --samples=20
//
// WHY THIS EXISTS: 215 organizations hold a `primary_contractor` role — they
// pulled the permit — and 169 of them have no binding candidate at all. Not a
// weak candidate: none. "Improve matching" is unfalsifiable; "38 of 169 are
// prefix noise" is a task. This measures which, so the split can decide whether
// targeted matching work is worth building.
//
// READ-ONLY. No --apply, deliberately: nothing here should be able to bind.
//
// DO NOT FRAME ANY BUCKET AS ENRICHMENT-ADDRESSABLE. `google_name` is NOT a
// match key — the binding index is built from canonicalName, aliases and brands
// only. Google names feed confirmation EVIDENCE and the review tier, never the
// index. So no amount of Google enrichment moves a single org out of
// `no_registry_name_match`; enrichment raises confidence on pairs already found
// and never finds new ones. An earlier plan claimed the opposite and it was
// wrong.
//
// This uses the SAME `crossNameKey` the binder uses. A second normalizer that
// drifts is exactly how match keys silently stop matching, so the audit must
// never re-implement one — if this file and the binder ever disagree, this file
// is lying about the binder.
function numericArg(name: string, dflt: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const n = Number(hit.slice(name.length + 3));
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Names carrying a parser artifact rather than a business name. */
function isPrefixNoise(name: string): boolean {
  return /^\s*[*]/.test(name) || /^\s*[A-Z ]{3,}:/.test(name);
}

type Bucket =
  | "prefix_noise"
  | "person_shaped"
  | "generic"
  | "ambiguous_multi_match"
  | "unique_key_no_candidate"
  | "no_registry_name_match";

async function main() {
  const samples = numericArg("samples", 10);
  const logger = createLogger({ app: "binding-audit" });
  const pool = createPool();
  const db = createDb(pool);
  const registryPool = createRegistryPool();
  try {
    if (!registryPool) {
      logger.info({ skipped: true }, "no REGISTRY_DATABASE_URL — binding audit cannot run");
      return;
    }

    // Primary contractors that are unbound AND have no pending candidate.
    const res = await db.execute(sql`
      SELECT o.id, o.canonical_name
      FROM organizations o
      WHERE o.registry_ref IS NULL
        AND EXISTS (SELECT 1 FROM project_roles pr
                    WHERE pr.organization_id = o.id AND pr.role = 'primary_contractor')
        AND NOT EXISTS (SELECT 1 FROM registry_observations ro
                        WHERE ro.organization_id = o.id AND ro.status = 'pending')`);
    const orgs = (res.rows as Record<string, unknown>[]).map((r) => ({
      id: String(r["id"]),
      name: String(r["canonical_name"] ?? ""),
    }));

    // Rebuild the binder's name index: canonicalName + aliases + brands, keyed
    // by crossNameKey. A key reached by more than one ENTITY is ambiguous and
    // the binder drops it — replicated here so `ambiguous_multi_match` means the
    // same thing it means in the binder.
    const registryRows = await fetchRegistryIdentityRows(registryPool);
    const byKey = new Map<string, Set<string>>();
    const addKey = (key: string, entityId: string) => {
      if (!key) return;
      const hit = byKey.get(key);
      if (hit) hit.add(entityId);
      else byKey.set(key, new Set([entityId]));
    };
    for (const row of registryRows) {
      if (row.canonicalName) addKey(crossNameKey(row.canonicalName), row.entityId);
      for (const alias of row.aliases ?? []) {
        if (typeof alias === "string" && alias.length > 0) addKey(crossNameKey(alias), row.entityId);
      }
      for (const brand of row.brands ?? []) addKey(crossNameKey(brand.name), row.entityId);
    }

    const buckets = new Map<Bucket, string[]>();
    const put = (b: Bucket, name: string) => {
      const hit = buckets.get(b);
      if (hit) hit.push(name);
      else buckets.set(b, [name]);
    };

    for (const org of orgs) {
      // Ordered most-specific first: a name can satisfy several tests, and the
      // FIRST reason is the actionable one. "TENANT: DESTINY SIMPSON" is both
      // prefix noise and person-shaped; the parser artifact is the real defect.
      if (isPrefixNoise(org.name)) put("prefix_noise", org.name);
      // `person_shaped` OVERCOUNTS — read it as an upper bound, not a total.
      // `isPersonShapedOrgName` inherits known `BUSINESS_TOKENS` gaps, so plain
      // businesses land here: live samples include "OLYMPIA FIREPLACE & SPA" and
      // "GENESIS BUILDINGS", neither of which is a person. Same gap that made
      // the person-shape REFUSAL unsafe to enable (roadmap P6). Reused here
      // rather than writing a second person test, because two person tests that
      // disagree would be worse than one that is known to over-fire.
      else if (isPersonShapedOrgName(org.name)) put("person_shaped", org.name);
      else if (isGenericName(org.name)) put("generic", org.name);
      else {
        const entities = byKey.get(crossNameKey(org.name));
        if (!entities || entities.size === 0) put("no_registry_name_match", org.name);
        else if (entities.size > 1) put("ambiguous_multi_match", org.name);
        else {
          // A UNIQUE key match that still produced no candidate. Not ambiguity —
          // its own anomaly, and kept in its own bucket because folding it into
          // `ambiguous_multi_match` would misreport the cause. Verified live on
          // 2026-07-25 that these carry NO observation of any status, so it is
          // not a rejected-candidate artifact either: the binder never emitted
          // one. Cause not modelled here (the binder also weighs geography and
          // trust floors) — this bucket is the pointer to go and find out.
          put("unique_key_no_candidate", org.name);
        }
      }
    }

    const counts: Record<string, number> = {};
    for (const [b, names] of buckets) counts[b] = names.length;
    const total = Object.values(counts).reduce((n, v) => n + v, 0);

    logger.info(
      {
        primaryContractorsUnboundNoCandidate: orgs.length,
        bucketed: total,
        counts,
        registryEntities: registryRows.length,
        nameKeys: byKey.size,
      },
      "binding audit — why these primary contractors have no candidate",
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
