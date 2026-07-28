import "./env.js";
import { sql } from "drizzle-orm";
import { createDb, createPool, type Db } from "./client.js";

/**
 * The E2E CORPUS — a deterministic dataset the Playwright suite asserts against.
 *
 * WHY THIS EXISTS. `apps/web/e2e` ran against the hosted production database. It
 * read real customer rows, and it WROTE to them: measured 2026-07-27, 30 of 30
 * `claim_corrections` and 30 of 30 `opportunity_outcomes` rows were test output,
 * feeding the customer's ROI scorecard and the "Won" figure on /app/pipeline.
 *
 * Run order — each step assumes the previous one:
 *
 *   pnpm infra:up && pnpm db:migrate && pnpm db:seed && pnpm db:seed:e2e
 *
 * `db:seed` supplies sources (38 from config/sources.yaml), their coverage
 * entries and the three account profiles. This file supplies everything the
 * pipeline would normally produce: projects, opportunities, evidence, roles and
 * a pending review cluster.
 *
 * IDEMPOTENT. Every insert is keyed and upserted, so re-running converges rather
 * than accumulating — the same contract `seed.ts` holds.
 *
 * ── Two decisions worth knowing before editing ─────────────────────────────
 *
 * 1. **No `permittingJurisdiction: "Test Jurisdiction"`.** The vitest fixtures
 *    use that string deliberately, because production aggregates filter it out
 *    (`corporate-family.ts:268`: `AND p.permitting_jurisdiction != 'Test
 *    Jurisdiction'`). This corpus must be VISIBLE to those aggregates or the
 *    league-table and rollup assertions fail against it. Isolation comes from
 *    running on a different database, not from a sentinel string.
 *
 * 2. **Opportunities are inserted directly, not scored.** Running `scoreAll`
 *    would make the fixtures a function of the current scoring version, so a
 *    weight change would silently rewrite the data the assertions depend on and
 *    the suite would fail for a reason that has nothing to do with the web app.
 *    Scores here are chosen to straddle the band thresholds (80 / 65) so the
 *    band control, the summary tiles and `ScoreBar` all have something to show.
 */

/** Marks every row this file owns, so re-runs can find and replace them. */
const E2E_TAG = "e2e-corpus";

/** Stable external-id prefix — the natural key for upserts. */
const XID = (n: string): string => `${E2E_TAG}:${n}`;

type Seeded = { accountId: string; sourceId: string; artifactId: string };

/**
 * Select-by-natural-key, insert if absent, return the id.
 *
 * NOT `ON CONFLICT DO NOTHING`. Measured against the real schema, only four of
 * the tables this file writes carry a natural unique key —
 * `source_records (source_id, external_id)`,
 * `opportunities (account_profile_id, project_id)`,
 * `raw_artifacts (source_id, canonical_url, sha256)` and a five-column dedupe on
 * `project_events`. `projects`, `organizations`, `evidence_items`,
 * `project_roles` and `resolution_reviews` have none, so `ON CONFLICT DO
 * NOTHING` on those is a no-op that inserts every time: the first version of
 * this file claimed idempotency and would have duplicated the corpus on every
 * run. Explicit select-then-insert holds regardless of index shape.
 */
async function ensure(
  db: Db,
  table: string,
  where: ReturnType<typeof sql>,
  insert: ReturnType<typeof sql>,
): Promise<string> {
  const found = await db.execute(
    sql`SELECT id FROM ${sql.raw(table)} WHERE ${where} LIMIT 1`,
  );
  const hit = found.rows[0] as { id: string } | undefined;
  if (hit) return hit.id;
  const created = await db.execute(insert);
  const row = created.rows[0] as { id: string } | undefined;
  if (!row) throw new Error(`insert into ${table} returned no id`);
  return row.id;
}

async function accountId(db: Db, key: string): Promise<string> {
  const res = await db.execute(sql`SELECT id FROM account_profiles WHERE key = ${key}`);
  const row = res.rows[0] as { id: string } | undefined;
  if (!row) {
    throw new Error(
      `account_profiles has no row for "${key}". Run \`pnpm db:seed\` before \`pnpm db:seed:e2e\`.`,
    );
  }
  return row.id;
}

/**
 * A source run and one raw artifact to hang records off.
 *
 * `raw_artifacts.source_run_id` is NOT NULL, so a bare artifact is not an
 * option — provenance is structural here, which is the point of the schema.
 */
async function seedProvenance(db: Db): Promise<Seeded> {
  const src = await db.execute(sql`
    SELECT id FROM sources WHERE key = 'tacoma_permits_arcgis' LIMIT 1`);
  const sourceRow = src.rows[0] as { id: string } | undefined;
  if (!sourceRow) {
    throw new Error(
      "sources has no 'tacoma_permits_arcgis' row. Run `pnpm db:seed` before `pnpm db:seed:e2e`.",
    );
  }
  const sourceId = sourceRow.id;

  const runId = await ensure(
    db,
    "source_runs",
    sql`source_id = ${sourceId} AND schema_fingerprint = ${XID("run")}`,
    sql`INSERT INTO source_runs (source_id, status, started_at, completed_at,
          discovered_count, fetched_count, parsed_count, schema_fingerprint)
        VALUES (${sourceId}, 'succeeded', now() - interval '2 hours',
          now() - interval '2 hours', 8, 8, 8, ${XID("run")})
        RETURNING id`,
  );

  const artifactId = await ensure(
    db,
    "raw_artifacts",
    sql`canonical_url = ${XID("artifact")}`,
    // `sha256` is NOT NULL — it is the content hash the artifact store keys on.
    // A fixed literal is correct here: the corpus artifact has fixed content.
    sql`INSERT INTO raw_artifacts (source_id, source_run_id, canonical_url, retrieved_at,
          content_type, http_status, storage_key, byte_size, sha256, parser_version)
        VALUES (${sourceId}, ${runId}, ${XID("artifact")}, now() - interval '2 hours',
          'application/json', 200, ${XID("artifact")}, 1024,
          ${"e2e" + "0".repeat(61)}, 'e2e-1')
        RETURNING id`,
  );

  return { accountId: "", sourceId, artifactId };
}

/**
 * Same contract for tables with NO `id` column.
 *
 * `project_roles` is one: it is a pure join row keyed by
 * (project, organization, role) and has neither a surrogate id nor a primary
 * key. `ensure()` fails on it with `column "id" does not exist`.
 */
async function ensureRow(
  db: Db,
  table: string,
  where: ReturnType<typeof sql>,
  insert: ReturnType<typeof sql>,
): Promise<void> {
  const found = await db.execute(
    sql`SELECT 1 AS present FROM ${sql.raw(table)} WHERE ${where} LIMIT 1`,
  );
  if (found.rows.length > 0) return;
  await db.execute(insert);
}

/**
 * The projects.
 *
 * Shapes chosen so that, between them, they satisfy every geography and search
 * assertion in `app.spec.ts`:
 *   - `pierce-tenant`  → Pierce county AND the word "tenant" (two assertions)
 *   - `king-geo`       → King county WITH geometry (map + geometry-coverage)
 *   - the rest         → volume, so `total > items.length` at limit=5
 */
const PROJECTS: {
  slug: string;
  name: string;
  county: string;
  jurisdiction: string;
  city: string;
  stage: string;
  lon: number | null;
  lat: number | null;
}[] = [
  { slug: "pierce-tenant", name: "Tenant improvement — Level 2 office fit-out", county: "Pierce", jurisdiction: "City of Tacoma", city: "Tacoma", stage: "permit_applied", lon: -122.4443, lat: 47.2529 },
  { slug: "king-geo", name: "Interior remodel — clinic suite 300", county: "King", jurisdiction: "City of Seattle", city: "Seattle", stage: "permit_issued", lon: -122.3321, lat: 47.6062 },
  { slug: "pierce-two", name: "Retail shell and core — Union Avenue", county: "Pierce", jurisdiction: "City of Tacoma", city: "Tacoma", stage: "permit_applied", lon: -122.4601, lat: 47.2401 },
  { slug: "thurston-one", name: "Fire station apparatus bay addition", county: "Thurston", jurisdiction: "City of Olympia", city: "Olympia", stage: "entitlement", lon: -122.9007, lat: 47.0379 },
  { slug: "king-two", name: "Warehouse conversion to light manufacturing", county: "King", jurisdiction: "City of Kent", city: "Kent", stage: "preapplication", lon: -122.2348, lat: 47.3809 },
  { slug: "pierce-three", name: "Multifamily corridor refinish — Phase 2", county: "Pierce", jurisdiction: "City of Lakewood", city: "Lakewood", stage: "permit_issued", lon: -122.5185, lat: 47.1718 },
  { slug: "snohomish-one", name: "Medical office tenant improvement", county: "Snohomish", jurisdiction: "City of Everett", city: "Everett", stage: "permit_applied", lon: -122.2021, lat: 47.9789 },
];

async function seedProjects(db: Db, p: Seeded): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const proj of PROJECTS) {
    // Geometry via PostGIS constructors — a bare literal will not cast.
    const geom =
      proj.lon === null || proj.lat === null
        ? sql`NULL`
        : sql`ST_SetSRID(ST_MakePoint(${proj.lon}, ${proj.lat}), 4326)`;
    const geomSource = proj.lon === null ? sql`NULL` : sql`'stated_parcel'`;

    const projectId = await ensure(
      db,
      "projects",
      sql`address_normalized = ${XID(proj.slug)}`,
      sql`INSERT INTO projects (canonical_name, permitting_jurisdiction, county, city,
            address_normalized, current_stage, geometry, geometry_source,
            first_seen_at, last_seen_at)
          VALUES (${proj.name}, ${proj.jurisdiction}, ${proj.county}, ${proj.city},
            ${XID(proj.slug)}, ${proj.stage}, ${geom}, ${geomSource},
            now() - interval '40 days', now() - interval '3 days')
          RETURNING id`,
    );
    ids.set(proj.slug, projectId);

    // One source record per project. `source_records` DOES have a natural key,
    // so this one can use ON CONFLICT.
    const rec = await db.execute(sql`
      INSERT INTO source_records (source_id, raw_artifact_id, external_id, record_type,
        first_seen_at, last_seen_at, status, raw_fields_json, normalized_json,
        normalized_fingerprint)
      VALUES (${p.sourceId}, ${p.artifactId}, ${XID(proj.slug)}, 'permit',
        now() - interval '40 days', now() - interval '3 days', 'active',
        '{}'::jsonb,
        ${JSON.stringify({ title: proj.name, valuationUsd: 415000, issueDate: "2026-06-01" })}::jsonb,
        ${XID(proj.slug)})
      ON CONFLICT (source_id, external_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
      RETURNING id`);
    const recordId = (rec.rows[0] as { id: string }).id;

    // Evidence. `unsupportedFactCount` must be 0 (app.spec.ts:200), so every
    // fact the page shows carries a graded, cited row.
    await ensure(
      db,
      "evidence_items",
      sql`source_record_id = ${recordId} AND fact_path = 'title'`,
      sql`INSERT INTO evidence_items (source_record_id, raw_artifact_id, fact_path,
            evidence_text, page_or_section, source_url, authority_grade, parser_version)
          VALUES (${recordId}, ${p.artifactId}, 'title',
            ${`${proj.name} — permit record`}, 'title field',
            ${`https://example.invalid/${proj.slug}`}, 'A', 'e2e-1')
          RETURNING id`,
    );

    await ensure(
      db,
      "record_resolutions",
      sql`source_record_id = ${recordId} AND status = 'active'`,
      sql`INSERT INTO record_resolutions (source_record_id, project_id, resolver_version,
            matched_rule, features_json, score, decision, status)
          VALUES (${recordId}, ${projectId}, 'e2e-1', 'external_id_exact',
            '{}'::jsonb, 1.0, 'auto', 'active')
          RETURNING id`,
    );

    // Stage events with dates — the lead-time backtest reads these
    // (app.spec.ts:269). `project_events` has a five-column dedupe index.
    await db.execute(sql`
      INSERT INTO project_events (project_id, source_record_id, event_type, event_date,
        observed_at, resulting_stage, material_change, confirmed, confidence)
      VALUES (${projectId}, ${recordId}, 'project_first_seen',
        now() - interval '40 days', now() - interval '40 days',
        ${proj.stage}, true, true, 1.0)
      ON CONFLICT DO NOTHING`);
  }

  return ids;
}

/**
 * One organization holding roles on TWO projects, so the league table has a row
 * at `min=2` (app.spec.ts:284). A single-project org would leave it empty.
 */
async function seedOrganization(db: Db, _p: Seeded, projects: Map<string, string>): Promise<void> {
  const ORG = "Northwest Interiors Group LLC";
  const orgId = await ensure(
    db,
    "organizations",
    sql`canonical_name = ${ORG}`,
    sql`INSERT INTO organizations (canonical_name, organization_type)
        VALUES (${ORG}, 'contractor') RETURNING id`,
  );

  for (const slug of ["pierce-tenant", "king-geo", "pierce-two"]) {
    const projectId = projects.get(slug);
    if (!projectId) continue;
    const rec = await db.execute(sql`
      SELECT id FROM source_records WHERE external_id = ${XID(slug)} LIMIT 1`);
    const recordId = (rec.rows[0] as { id: string } | undefined)?.id;
    if (!recordId) continue;

    await ensureRow(
      db,
      "project_roles",
      sql`project_id = ${projectId} AND organization_id = ${orgId} AND role = 'primary_contractor'`,
      sql`INSERT INTO project_roles (project_id, organization_id, role, source_record_id,
            confirmed, confidence, first_seen_at, last_seen_at)
          VALUES (${projectId}, ${orgId}, 'primary_contractor', ${recordId}, true, 1.0,
            now() - interval '40 days', now() - interval '3 days')`,
    );
  }
}

/**
 * Opportunities, inserted directly rather than scored — see the header note.
 *
 * Scores straddle both band thresholds on purpose: two above 80
 * (priority_review), three between 65 and 79 (weekly_digest), one below, and one
 * deliberately UNSCORED so the "Not yet scored" tile and `ScoreBar`'s dashed
 * unknown state have real data behind them instead of only unit-test coverage.
 */
const OPPORTUNITIES: { slug: string; score: number | null; state: string; account: string }[] = [
  { slug: "pierce-tenant", score: 92, state: "priority_review", account: "solis_interiors" },
  { slug: "king-geo", score: 84, state: "priority_review", account: "solis_interiors" },
  { slug: "pierce-two", score: 71, state: "weekly_digest", account: "solis_interiors" },
  { slug: "thurston-one", score: 68, state: "weekly_digest", account: "solis_interiors" },
  { slug: "king-two", score: 66, state: "weekly_digest", account: "solis_interiors" },
  { slug: "pierce-three", score: 41, state: "archive", account: "solis_interiors" },
  { slug: "snohomish-one", score: null, state: "weekly_digest", account: "solis_interiors" },
  // `lacey_glass_commercial` needs MORE THAN FIVE, not just a couple.
  // app.spec.ts:233 asserts `total > items.length` at limit=5, so five or fewer
  // makes the page-1 slice equal the total and the pagination assertion fails —
  // it caught exactly that with 2. It also needs at least one project WITH
  // geometry, because the map test (app.spec.ts:254) logs in as this account
  // and asserts an SVG marker renders.
  { slug: "king-geo", score: 88, state: "priority_review", account: "lacey_glass_commercial" },
  { slug: "pierce-tenant", score: 74, state: "weekly_digest", account: "lacey_glass_commercial" },
  { slug: "pierce-two", score: 72, state: "weekly_digest", account: "lacey_glass_commercial" },
  { slug: "thurston-one", score: 69, state: "weekly_digest", account: "lacey_glass_commercial" },
  { slug: "king-two", score: 67, state: "weekly_digest", account: "lacey_glass_commercial" },
  { slug: "snohomish-one", score: 66, state: "weekly_digest", account: "lacey_glass_commercial" },
  { slug: "pierce-three", score: 81, state: "priority_review", account: "lacey_glass_commercial" },
];

async function seedOpportunities(db: Db, projects: Map<string, string>): Promise<void> {
  const accounts = new Map<string, string>();
  for (const key of ["solis_interiors", "lacey_glass_commercial"]) {
    accounts.set(key, await accountId(db, key));
  }

  for (const opp of OPPORTUNITIES) {
    const projectId = projects.get(opp.slug);
    const acct = accounts.get(opp.account);
    if (!projectId || !acct) continue;

    await db.execute(sql`
      INSERT INTO opportunities (account_profile_id, project_id, current_score,
        score_version, route, state, first_qualified_at, last_material_change_at,
        rationale_json)
      VALUES (${acct}, ${projectId}, ${opp.score}, 'e2e-1', 'interior_trades',
        ${opp.state}, now() - interval '30 days', now() - interval '3 days',
        ${JSON.stringify({ components: { timing: 1, geography: 0.9 }, signals: ["e2e_corpus"] })}::jsonb)
      ON CONFLICT (account_profile_id, project_id) DO UPDATE
        SET current_score = EXCLUDED.current_score,
            state = EXCLUDED.state,
            last_material_change_at = EXCLUDED.last_material_change_at`);
  }
}

/**
 * A pending review cluster, so `/app/admin/review` has a `cluster-reject`
 * control to find (app.spec.ts:369).
 *
 * Deliberately a record that resolved to NO project: an unresolved record with a
 * candidate is exactly what the triage queue is for.
 */
async function seedReviewCluster(db: Db, p: Seeded, projects: Map<string, string>): Promise<void> {
  const candidate = projects.get("pierce-tenant");
  if (!candidate) return;

  const rec = await db.execute(sql`
    INSERT INTO source_records (source_id, raw_artifact_id, external_id, record_type,
      first_seen_at, last_seen_at, status, raw_fields_json, normalized_json,
      normalized_fingerprint)
    VALUES (${p.sourceId}, ${p.artifactId}, ${XID("review-1")}, 'permit',
      now() - interval '5 days', now() - interval '1 day', 'active', '{}'::jsonb,
      ${JSON.stringify({ title: "Tenant improvement — suite 210 (address match pending)" })}::jsonb,
      ${XID("review-1")})
    ON CONFLICT (source_id, external_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
    RETURNING id`);
  const recordId = (rec.rows[0] as { id: string }).id;

  const reviewId = await ensure(
    db,
    "resolution_reviews",
    sql`source_record_id = ${recordId}`,
    // The reason must be one of `HUMAN_DECIDABLE_REASONS`
    // (packages/resolution/src/review.ts:242). `classifyResolutionReviewState`
    // marks anything else `awaiting_evidence`, the review page renders no
    // decision control for those, and `cluster-reject` is then absent — which
    // is what the first version of this corpus produced.
    sql`INSERT INTO resolution_reviews (source_record_id, candidate_project_id, matched_rule,
          features_json, score, reasons_json, resolver_version, status)
        VALUES (${recordId}, ${candidate}, 'address_name', '{}'::jsonb, 0.62,
          ${JSON.stringify(["same_address_name_mismatch"])}::jsonb, 'e2e-1', 'pending')
        RETURNING id`,
  );

  // `ensure` only INSERTS when absent, so a corpus edit to these values would
  // not reach a database seeded by an earlier version. Converge explicitly —
  // presence-idempotent is not the same as value-idempotent, and the difference
  // showed up as a stale `reasons_json` keeping the review non-actionable.
  await db.execute(sql`
    UPDATE resolution_reviews
    SET reasons_json = ${JSON.stringify(["same_address_name_mismatch"])}::jsonb,
        matched_rule = 'address_name',
        status = 'pending',
        candidate_project_id = ${candidate}
    WHERE id = ${reviewId}`);
}

async function main(): Promise<void> {
  const pool = createPool();
  const db = createDb(pool);

  const dsn = process.env.DATABASE_URL ?? "";
  // The corpus inserts fixture projects and opportunities into shared tables.
  // Doing that to the hosted database is the exact problem this file exists to
  // end, so refuse rather than warn.
  if (dsn && !/localhost|127\.0\.0\.1/.test(dsn) && process.env.ALLOW_REMOTE_TEST_DB !== "1") {
    throw new Error(
      [
        "",
        "  Refusing to seed the e2e corpus into a NON-LOCAL database.",
        `  DATABASE_URL points at: ${dsn.replace(/:[^:@/]+@/, ":***@")}`,
        "",
        "  This inserts fixture projects and opportunities into shared tables.",
        "  Start the local stack and retry:   pnpm infra:up && pnpm db:migrate && pnpm db:seed",
        "",
      ].join("\n"),
    );
  }

  const provenance = await seedProvenance(db);
  const projects = await seedProjects(db, provenance);
  await seedOrganization(db, provenance, projects);
  await seedOpportunities(db, projects);
  await seedReviewCluster(db, provenance, projects);

  const counts = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM projects)              AS projects,
      (SELECT count(*)::int FROM opportunities)         AS opportunities,
      (SELECT count(*)::int FROM evidence_items)        AS evidence,
      (SELECT count(*)::int FROM project_roles)         AS roles,
      (SELECT count(*)::int FROM resolution_reviews
         WHERE status = 'pending')                      AS pending_reviews`);
  console.log("e2e corpus seeded:", counts.rows[0]);

  await pool.end();
}

main().catch((err: unknown) => {
  // Print the CAUSE, not just the message. Drizzle wraps the driver error, so
  // `err.message` is the SQL text and the actual reason ("column x does not
  // exist", "null value violates not-null") lives one level down. Swallowing it
  // cost several blind iterations while writing this file.
  const e = err as { message?: string; cause?: { message?: string; detail?: string; code?: string } };
  console.error(e.message ?? String(err));
  if (e.cause) {
    console.error(`  cause: ${e.cause.code ?? ""} ${e.cause.message ?? ""}`);
    if (e.cause.detail) console.error(`  detail: ${e.cause.detail}`);
  }
  process.exit(1);
});
