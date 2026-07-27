import "../load-env.js";
import { writeFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";

// pnpm pals:hydrate:export [--out=pals-hydrate-seed.json] [--limit=250] [--all]
//                          [--account=<key>] [--recent-first]
//
// Phase A0 (queue-cockpit plan, owner-approved scale 2026-07-24): emit the
// permit ids the PALS capture script should hydrate. Pierce's open-data layer
// (`pierce_permits_arcgis`) publishes NO contacts and NO contractor licence —
// but its external_id IS the PALS applPermitId, and PALS' own permit-header
// endpoint returns `contrLicNum`, the authoritative contractor licence. A
// licence is a STRONG key: identifiers.ts stamps organizations
// .contractor_registration (NULL-only) and linkRegistry binds
// `contractor_number_exact` deterministically — no review row, no new rule.
//
// ORDERED BY WHAT A CAPTURE IS WORTH, NOT BY DATE. This used to be
// recent-permits-first, and the first live batch showed what that costs: 250
// captures produced 43 successful hydrations covering 38 projects, of which
// exactly ONE was a priority opportunity for the account that needed it. The
// pool is 6,145 permits and the capture window is small and rate-limited — PALS
// declined the session after 54 attempts — so the ordering IS the yield.
//
// A capture is worth the most when the project it lands on has NO organization
// at all AND already backs a high-scoring opportunity: that is a customer-facing
// row currently reading "no contractor named". It is worth the least when the
// project already names somebody. Hence the tiers:
//
//   0  no org, backs a priority opportunity   (>= PRIORITY_SCORE)
//   1  no org, backs a weekly-digest one      (>= WEEKLY_SCORE)
//   2  no org, no qualifying opportunity
//   3  the project already names an organization
//
// Recency still breaks ties inside a tier, because a stale permit is a worse
// lead than a fresh one — it is a tie-breaker now rather than the whole sort.
// `--recent-first` restores the original date-only ordering for a straight
// coverage sweep.
//
// `--account=<key>` scopes the opportunity lookup to one account (the account
// whose radar you are trying to fill). Without it any account's opportunity
// counts, which is right for general coverage and wrong when you are buying
// down a specific customer's blank rows.
//
// `--limit` caps the BATCH; the summary always reports the FULL remaining pool,
// its permit-type mix AND the tier histogram, so each batch doubles as the A0
// yield measurement.
//
// Lookup-class hard rule (spec §5): this list only ever contains permits we
// already hold — the capture script must never crawl or discover on its own.
// Ordering changes which of those we ask about first; it never widens the set.
//
// ...and "we already hold it" is not the same as "it has a project". A permit
// whose open-data record is parked in the review queue has neither a project
// nor a registered external id, so a PALS record for it matches nothing and
// CREATES one — a second project for a permit we already hold. Those are
// excluded here and counted as `deferredParkedInReview`. See the pool CTE.

/** Score at or above which an opportunity is a priority row (spec §18 bands). */
const PRIORITY_SCORE = 80;
/** …and the weekly-digest band beneath it. */
const WEEKLY_SCORE = 65;
async function main() {
  const logger = createLogger({ app: "pals-hydrate-export" });
  const args = process.argv.slice(2);
  const outArg = args.find((a) => a.startsWith("--out="));
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const accountArg = args.find((a) => a.startsWith("--account="));
  const out = outArg ? outArg.slice("--out=".length) : "pals-hydrate-seed.json";
  const all = args.includes("--all");
  const recentFirst = args.includes("--recent-first");
  const account = accountArg ? accountArg.slice("--account=".length) : null;
  const limit = all ? null : Math.max(1, Number(limitArg?.slice("--limit=".length) ?? 250));

  // Fail loudly on a typo'd account key rather than silently ordering as if no
  // account had been named — the two produce very different batches, and the
  // difference would only surface as a wasted capture window days later.
  if (account !== null && account.trim() === "") {
    console.error("--account= requires a value (an account_profiles.key)");
    process.exit(1);
  }

  const pool = createPool();
  const db = createDb(pool);
  try {
    // The account filter is applied INSIDE the opportunity lookup, not as a
    // WHERE on the pool: a permit with no opportunity at all must still appear
    // (tier 2), it just sorts below the ones that have one.
    const accountFilter = account
      ? sql`AND o.account_profile_id = (SELECT id FROM account_profiles WHERE key = ${account})`
      : sql``;

    // One scan, three outputs: the ordered id list, the full-pool type mix, and
    // the tier histogram that says what this batch is actually worth.
    const res = await db.execute(sql`
      WITH pool AS (
        SELECT sr.id AS record_id, sr.external_id,
               coalesce(sr.normalized_json->>'permitType', 'unknown') AS permit_type,
               coalesce(sr.normalized_json->>'issueDate', sr.normalized_json->>'applicationDate') AS d
        FROM source_records sr
        JOIN sources s ON s.id = sr.source_id
        WHERE s.key = 'pierce_permits_arcgis'
          AND sr.external_id ~ '^[0-9]+$'
          AND NOT EXISTS (
            SELECT 1 FROM source_records e
            JOIN sources es ON es.id = e.source_id
            WHERE es.key = 'pierce_pals_contractor' AND e.external_id = sr.external_id)
          -- A permit whose OWN open-data record is still parked in the review
          -- queue has no project yet, so it has registered no external id — and
          -- matchByIds therefore cannot see it. Hydrating it anyway makes the
          -- PALS record fall through id AND parcel matching and CREATE A SECOND
          -- PROJECT for a permit we already hold. Measured live 2026-07-27: 31
          -- of 408 PALS records did exactly that, and all 31 point at a
          -- different project than the pending review's candidate, so accepting
          -- any of those reviews splits one permit across two projects
          -- permanently.
          --
          -- Deferred, not dropped: once a reviewer adjudicates the record it
          -- gets a project, registers its id, and re-enters this pool on the
          -- next export. The count is reported so the deferral is visible.
          AND NOT EXISTS (
            SELECT 1 FROM resolution_reviews rv
            WHERE rv.source_record_id = sr.id AND rv.status = 'pending')
      ),
      scored AS (
        SELECT p.external_id, p.permit_type, p.d,
               -- A record that resolved to no project has no org either, and
               -- lands in tier 2 rather than being dropped.
               EXISTS (
                 SELECT 1
                 FROM record_resolutions rr
                 JOIN project_roles pr ON pr.project_id = rr.project_id
                 WHERE rr.source_record_id = p.record_id AND rr.status = 'active'
                   AND pr.role IN ('primary_contractor', 'applicant', 'owner')
               ) AS has_org,
               (
                 SELECT max(o.current_score)
                 FROM record_resolutions rr
                 JOIN opportunities o ON o.project_id = rr.project_id
                 WHERE rr.source_record_id = p.record_id AND rr.status = 'active'
                 ${accountFilter}
               ) AS best_score
        FROM pool p
      )
      SELECT external_id, permit_type, d, has_org, best_score,
             CASE
               WHEN NOT has_org AND best_score >= ${PRIORITY_SCORE} THEN 0
               WHEN NOT has_org AND best_score >= ${WEEKLY_SCORE}   THEN 1
               WHEN NOT has_org                                     THEN 2
               ELSE 3
             END AS tier
      FROM scored
      ORDER BY
        ${recentFirst ? sql`d DESC NULLS LAST` : sql`tier ASC, best_score DESC NULLS LAST, d DESC NULLS LAST`},
        external_id DESC`);
    const rows = res.rows as {
      external_id: string;
      permit_type: string;
      d: string | null;
      has_org: boolean;
      best_score: number | null;
      tier: number;
    }[];

    // What the review-queue guard held back. Counted and reported rather than
    // silently absent: a pool that quietly shrank would read as "we are nearly
    // done hydrating Pierce" when the truth is that some of it is waiting on a
    // human. It was a fifth of the pool when the guard landed (1,232 of 6,015
    // on 2026-07-27), so this is not a rounding error.
    const deferred = await db.execute(sql`
      SELECT count(*)::int AS n
      FROM source_records sr
      JOIN sources s ON s.id = sr.source_id
      WHERE s.key = 'pierce_permits_arcgis'
        AND sr.external_id ~ '^[0-9]+$'
        AND NOT EXISTS (
          SELECT 1 FROM source_records e
          JOIN sources es ON es.id = e.source_id
          WHERE es.key = 'pierce_pals_contractor' AND e.external_id = sr.external_id)
        AND EXISTS (
          SELECT 1 FROM resolution_reviews rv
          WHERE rv.source_record_id = sr.id AND rv.status = 'pending')`);
    const deferredParkedInReview = Number((deferred.rows[0] as { n: number } | undefined)?.n ?? 0);

    const byPermitType: Record<string, number> = {};
    for (const r of rows) byPermitType[r.permit_type] = (byPermitType[r.permit_type] ?? 0) + 1;
    const batch = limit === null ? rows : rows.slice(0, limit);

    /** What the batch is worth, by tier — the number to read after a run. */
    const tierLabel = (t: number) =>
      t === 0 ? "0_no_org_priority" : t === 1 ? "1_no_org_weekly" : t === 2 ? "2_no_org_unscored" : "3_already_named";
    const byTier: Record<string, number> = {};
    const batchByTier: Record<string, number> = {};
    for (const r of rows) byTier[tierLabel(r.tier)] = (byTier[tierLabel(r.tier)] ?? 0) + 1;
    for (const r of batch) batchByTier[tierLabel(r.tier)] = (batchByTier[tierLabel(r.tier)] ?? 0) + 1;

    const payload = {
      generatedAt: new Date().toISOString(),
      source: "pierce_permits_arcgis",
      // How this batch was chosen, recorded IN the seed: a capture window is
      // expensive and days may pass before anyone asks why a batch yielded what
      // it did. The answer should travel with the list, not live in a shell
      // history.
      ordering: recentFirst ? "recent_first" : "value_first",
      account: account ?? null,
      remainingPool: rows.length,
      deferredParkedInReview,
      batchSize: batch.length,
      byPermitType,
      poolByTier: byTier,
      batchByTier,
      // Numbers, not strings: the capture script and the adapter both treat
      // applPermitId as an integer id.
      permitIds: batch.map((r) => Number(r.external_id)),
    };
    await writeFile(out, JSON.stringify(payload, null, 2));
    logger.info(
      {
        out,
        ordering: payload.ordering,
        account,
        remainingPool: rows.length,
        deferredParkedInReview,
        batchSize: batch.length,
        batchByTier,
      },
      "PALS hydrate seed written — feed it to scripts/pals-header-capture.mjs",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
