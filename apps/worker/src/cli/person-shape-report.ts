import "../load-env.js";
import { sql } from "drizzle-orm";
import { createDb, createPool, createRegistryPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import {
  buildPrincipalPersonIndex,
  crossNameKey,
  fetchRegistryIdentityRows,
  isPersonShapedOrgName,
} from "@otn/resolution";

// pnpm person-shape:report        (READ-ONLY — always; there is no --apply)
//
// Measures what a person-shaped refusal WOULD cost if the binding loop applied
// one. It deliberately has no apply mode: the refusal is gated on the completed
// L&I load (roadmap P6), and this exists to keep that gap measurable rather than
// to act on it.
//
// The number that matters is `personShapedWithRegistryMatch` — orgs this test
// calls people that nonetheless match a real registry entity. Every one is a
// company the refusal would silently drop, and at 35.7% L&I coverage most such
// companies cannot even be detected, because their L&I record was never loaded.
//
// Flags:
//   --limit=N     cap the sample listed (default 40); does not affect counts
function numericArg(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.slice(name.length + 3));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface UnboundOrg {
  name: string;
  projects: number;
  isPrimaryContractor: boolean;
}

async function loadUnboundOrgs(db: ReturnType<typeof createDb>): Promise<UnboundOrg[]> {
  const res = await db.execute(sql`
    SELECT o.canonical_name AS name,
           (SELECT count(DISTINCT pr.project_id) FROM project_roles pr
             WHERE pr.organization_id = o.id)::int AS projects,
           EXISTS (SELECT 1 FROM project_roles pr
                    WHERE pr.organization_id = o.id
                      AND pr.role = 'primary_contractor') AS is_pc
      FROM organizations o
     WHERE o.registry_ref IS NULL
       AND o.canonical_name IS NOT NULL`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    name: String(r["name"]),
    projects: Number(r["projects"] ?? 0),
    isPrimaryContractor: r["is_pc"] === true,
  }));
}

async function main() {
  const logger = createLogger({ app: "person-shape-report" });
  const sampleSize = numericArg("limit", 40);
  const pool = createPool();
  const db = createDb(pool);
  const registryPool = createRegistryPool();
  try {
    if (!registryPool) {
      // Mirrors strict-bind: the seam being unset is a skip, not a crash.
      logger.info({ skipped: true }, "no REGISTRY_DATABASE_URL — person-shape report cannot run");
      return;
    }

    // Build the SAME name index the binding loop builds, so "would have matched"
    // means what the matcher means. Two-token minimum mirrors the loop's guard.
    const registryRows = await fetchRegistryIdentityRows(registryPool);
    const byNameKey = new Set<string>();
    const addKey = (key: string) => {
      if (key && key.split(" ").length >= 2) byNameKey.add(key);
    };
    for (const row of registryRows) {
      if (row.canonicalName) addKey(crossNameKey(row.canonicalName));
      for (const alias of row.aliases ?? []) {
        if (typeof alias === "string" && alias.length > 0) addKey(crossNameKey(alias));
      }
    }
    const matchesRegistry = (name: string): boolean => {
      const key = crossNameKey(name);
      return key.split(" ").length >= 2 && byNameKey.has(key);
    };

    // THE SURNAME ALLOWLIST, which this report holds the rows to build. Without
    // it the person test degrades to "2-3 tokens" and calls CAPITOL FIRE
    // PROTECTION, WSP USA and GENESIS BUILDINGS people — inflating
    // `personShaped` and therefore OVERSTATING the very cost this report exists
    // to measure. Empty set is guarded: `personCoreKey` returns null for any
    // surname absent from a SUPPLIED set, so an empty one would call every
    // person a business — the opposite error, and a silent one.
    const knownSurnames = buildPrincipalPersonIndex(registryRows).surnames;
    const surnameGate = knownSurnames.size > 0 ? knownSurnames : undefined;

    const orgs = await loadUnboundOrgs(db);
    const personShaped = orgs.filter((o) => isPersonShapedOrgName(o.name, surnameGate));
    const businessShaped = orgs.filter((o) => !isPersonShapedOrgName(o.name, surnameGate));
    const personShapedMatching = personShaped.filter((o) => matchesRegistry(o.name));
    const businessShapedMatching = businessShaped.filter((o) => matchesRegistry(o.name));
    const matchableTotal = personShapedMatching.length + businessShapedMatching.length;
    const primaryContractors = orgs.filter((o) => o.isPrimaryContractor);

    logger.info(
      {
        mode: "report (read-only — no refusal is applied anywhere)",
        registryNameKeys: byNameKey.size,
        unboundOrgs: orgs.length,
        personShaped: personShaped.length,
        businessShaped: businessShaped.length,
        // The cost of refusing: companies this test calls people, that a real
        // registry entity would have matched.
        personShapedWithRegistryMatch: personShapedMatching.length,
        businessShapedWithRegistryMatch: businessShapedMatching.length,
        matchableTotal,
        shareOfMatchesLostIfRefused:
          matchableTotal === 0
            ? null
            : Math.round((personShapedMatching.length / matchableTotal) * 1000) / 10,
        primaryContractors: primaryContractors.length,
        surnameAllowlist: knownSurnames.size,
        primaryContractorsPersonShaped: primaryContractors.filter((o) =>
          isPersonShapedOrgName(o.name, surnameGate),
        ).length,
      },
      "person-shape report",
    );

    // The names are the actionable part: each one is either a denylist gap worth
    // closing or a genuine person worth confirming.
    for (const org of personShapedMatching.slice(0, sampleSize)) {
      logger.info(
        { org: org.name, projects: org.projects, primaryContractor: org.isPrimaryContractor },
        "person-shaped BUT matches a registry entity — refusal would drop this",
      );
    }
    if (personShapedMatching.length > sampleSize) {
      logger.info(
        { shown: sampleSize, total: personShapedMatching.length },
        "sample truncated — pass --limit= to see more",
      );
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
