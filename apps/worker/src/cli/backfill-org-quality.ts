import "../load-env.js";
import { sql } from "drizzle-orm";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import {
  classifyOrgNameQuality,
  ORG_NAME_QUALITIES,
  type OrgNameQuality,
} from "@otn/resolution";

/**
 * pnpm orgs:backfill-quality — stamp `organizations.name_quality` on every row.
 *
 * One-shot in intent, idempotent in fact: the resolver stamps new organizations
 * as it creates them (migration 0039), so this exists to catch up the ~6,220
 * rows that predate the column, and to re-stamp if the classifier ever changes.
 * Re-running writes only the rows whose stored tier disagrees with the
 * classifier, so a second run reports zero changes and touches nothing.
 *
 * IT ALSO CHECKS ITSELF. The whole point of the column is to replace a regex
 * that lives inside four view bodies; if the TypeScript translation disagrees
 * with the SQL it replaced, rows silently vanish from the cockpit. So the same
 * query that reads the names also asks Postgres to evaluate the ORIGINAL
 * predicates, and the run reports every row where the two disagree. A non-zero
 * drift count is a STOP, not a warning: fix the classifier before applying 0040.
 *
 * Usage:
 *   pnpm orgs:backfill-quality --dry-run   # classify + drift check, write nothing
 *   pnpm orgs:backfill-quality             # apply
 */

/** Write in chunks so one UPDATE never carries the whole table as a parameter. */
const CHUNK = 1000;

// A type alias, not an interface: `db.execute<T>` constrains T to
// Record<string, unknown>, which only aliases satisfy implicitly.
type OrgRow = {
  id: string;
  canonical_name: string | null;
  name_quality: string | null;
  /** Postgres' own verdicts, from the predicates in migrations 0025–0028. */
  sql_placeholder: boolean;
  sql_digits: boolean;
  sql_entity: boolean;
};

/**
 * The classifier and the old predicate must agree about which rows the GC-name
 * lateral would keep. `junk` is the tier the view expressed as "fails the
 * negative checks"; `business` is "matches the entity token list". A row where
 * those two disagree is a translation bug.
 */
function sqlTier(row: OrgRow): OrgNameQuality {
  if (row.sql_placeholder || row.sql_digits) return "junk";
  return row.sql_entity ? "business" : "person_or_unknown";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");

  const logger = createLogger({ app: "backfill-org-quality-cli" });
  const pool = createPool();
  const db = createDb(pool);
  try {
    const res = await db.execute<OrgRow>(sql`
      SELECT id,
             canonical_name,
             name_quality,
             canonical_name ~* '^(NO |NOT |N/A|NA$|UNKNOWN|NONE|OWNER$|SAME AS|TBD|SEE |APPLICANT$|PER PLANS)' AS sql_placeholder,
             canonical_name ~ '[0-9]{3,}' AS sql_digits,
             -- \\. is deliberate: this is a JS template literal, so a single
             -- backslash would be swallowed before Postgres ever sees it and
             -- 'CO.' would match COX/COM. The predicate must reach the server
             -- byte-identical to the one in the migrations.
             canonical_name ~* '(LLC|INC|CORP|COMPANY|CO\\.|LP|LLP|PLLC|LTD|GROUP|CONSTRUCTION|BUILDERS|HOMES|DEVELOPMENT|ELECTRIC|PLUMBING|MECHANICAL|ROOFING|SERVICES|ENTERPRISES|ASSOCIATES|PARTNERS|CITY OF|COUNTY|DISTRICT|AUTHORITY|CHURCH|SCHOOL)' AS sql_entity
      FROM organizations
      ORDER BY id`);

    const counts: Record<OrgNameQuality, number> = {
      business: 0,
      person_or_unknown: 0,
      junk: 0,
    };
    const pending: Record<OrgNameQuality, string[]> = {
      business: [],
      person_or_unknown: [],
      junk: [],
    };
    const drift: { id: string; name: string | null; classifier: string; predicate: string }[] = [];

    for (const row of res.rows) {
      const tier = classifyOrgNameQuality(row.canonical_name);
      counts[tier] += 1;
      // An empty/blank name is `junk` to the classifier and `person_or_unknown`
      // to the predicate (which has nothing to match) — the old view dropped it
      // either way, so it is not drift. Every other disagreement is.
      const predicate = sqlTier(row);
      if (predicate !== tier && (row.canonical_name ?? "").trim() !== "") {
        if (drift.length < 25) {
          drift.push({ id: row.id, name: row.canonical_name, classifier: tier, predicate });
        }
      }
      if (row.name_quality !== tier) pending[tier].push(row.id);
    }

    const toWrite = ORG_NAME_QUALITIES.reduce((n, t) => n + pending[t].length, 0);
    logger.info(
      { dryRun, scanned: res.rows.length, counts, toWrite, driftSamples: drift.length },
      "org name quality classified",
    );
    if (drift.length > 0) {
      logger.error(
        { drift },
        "CLASSIFIER DISAGREES WITH THE VIEW PREDICATE — do not apply 0040 until this is zero",
      );
      process.exitCode = 1;
      return;
    }

    if (dryRun) {
      logger.info({ dryRun: true, toWrite }, "dry run — nothing written; re-run without --dry-run");
      return;
    }

    for (const tier of ORG_NAME_QUALITIES) {
      const ids = pending[tier];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        // Ids travel as ONE jsonb parameter (the project-trades.ts idiom), not
        // as a JS array: drizzle expands an array binding into N placeholders,
        // which turns `= ANY(...)` into a row-constructor and fails outright.
        await db.execute(sql`
          UPDATE organizations
          SET name_quality = ${tier}
          WHERE id IN (
            SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(batch)}::jsonb)
          )`);
      }
    }
    logger.info({ counts, written: toWrite }, "org name quality backfilled");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
