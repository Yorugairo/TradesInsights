import "../load-env.js";
import { sql } from "drizzle-orm";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { crossNameKey, persistOrganizationAlias } from "@otn/resolution";

// pnpm alias:backfill         (read-only — prints what WOULD be captured)
// pnpm alias:backfill:apply   (writes the aliases)
//
// One-time history pass for organization alias capture (migration 0031). The
// resolver now records a name variant as it collapses one, but every collapse
// that already happened threw its variant away — this recovers them from the
// source records still on disk.
//
// PRECISION OVER RECALL. A permit names several parties (owner, applicant,
// contractor) in one `organizations` array, so "every name on a record this org
// appears on" would hand a plumber the developer's name and manufacture a false
// binding candidate. Instead a name is claimed for an org ONLY when the
// (record, role) pair it holds resolves to exactly one distinct party name —
// then `project_roles` saying "this org held that role on that record" makes the
// attribution unambiguous. Records where two parties share a role are skipped,
// not guessed at.
//
// Idempotent: aliases dedupe on (organization_id, alias), so a rerun writes 0.

interface CandidateRow {
  org_id: string;
  canonical_name: string;
  party_name: string;
  source_id: string | null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const logger = createLogger({ app: apply ? "alias-backfill-apply" : "alias-backfill-preview" });
  const pool = createPool();
  const db = createDb(pool);
  try {
    const res = await db.execute(sql`
      WITH party AS (
        SELECT sr.id AS source_record_id,
               coalesce(e->>'role', 'unknown') AS role,
               trim(e->>'name') AS name
        FROM source_records sr
        CROSS JOIN LATERAL jsonb_array_elements(sr.normalized_json->'organizations') e
        WHERE jsonb_typeof(sr.normalized_json->'organizations') = 'array'
          AND nullif(trim(e->>'name'), '') IS NOT NULL
      ),
      unambiguous AS (
        SELECT source_record_id, role, min(name) AS name
        FROM party
        GROUP BY source_record_id, role
        HAVING count(DISTINCT name) = 1
      )
      SELECT DISTINCT
             pr.organization_id AS org_id,
             o.canonical_name,
             u.name AS party_name,
             sr.source_id
      FROM project_roles pr
      JOIN organizations o ON o.id = pr.organization_id
      JOIN unambiguous u
        ON u.source_record_id = pr.source_record_id AND u.role = pr.role
      JOIN source_records sr ON sr.id = pr.source_record_id`);

    const rows = res.rows as unknown as CandidateRow[];
    // Only names that fold to a DIFFERENT cross-system key than the canonical
    // are match keys worth storing; anything else is a restatement of a name
    // the binding matcher already tries.
    const variants = rows.filter((r) => {
      const key = crossNameKey(r.party_name);
      return key.length > 0 && key !== crossNameKey(r.canonical_name);
    });

    let created = 0;
    if (apply) {
      for (const r of variants) {
        if (await persistOrganizationAlias(db, r.org_id, r.party_name, r.source_id)) created += 1;
      }
    } else {
      for (const r of variants.slice(0, 25)) {
        logger.info({ org: r.canonical_name, alias: r.party_name }, "would capture alias");
      }
      if (variants.length > 25) {
        logger.info({ notShown: variants.length - 25 }, "…more variants not printed");
      }
    }

    logger.info(
      {
        mode: apply ? "apply" : "preview (dry run — no writes)",
        partyNamesExamined: rows.length,
        variants: variants.length,
        orgsAffected: new Set(variants.map((v) => v.org_id)).size,
        aliasesCreated: apply ? created : null,
      },
      "alias backfill complete",
    );
    if (variants.length === 0) logger.info({}, "no name variants found");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
