import { sql } from "drizzle-orm";
import { type Db } from "@otn/db";

/**
 * pnpm audit:data — the graph's health, as a command instead of a chat session.
 *
 * Every number in `.claude/PRPs/plans/data-hygiene-round-2.plan.md` was produced
 * by hand-typed SQL against hosted production on 2026-07-28. That worked exactly
 * once: it cannot be re-run, diffed, or scheduled, so the next round would have
 * started with the same archaeology. This file is that session, committed.
 *
 * TWO KINDS OF NUMBER, AND CONFLATING THEM IS THE FAILURE MODE THIS AVOIDS:
 *
 *   INVARIANTS are claims the system makes about itself. A NULL corroboration
 *   means the derivation pass did not run; a duplicate event means the dedupe
 *   index is not doing its job. These EXIT NON-ZERO, because they are broken.
 *
 *   METRICS are facts about the world. 57% of organization names are people
 *   because sole proprietors pull their own permits; 83% of projects carry no
 *   trade code because `BUILDING` is not a trade. Neither is a defect, and a
 *   command that failed on them would be muted within a week. These are
 *   REPORTED and never fatal.
 *
 * READ-ONLY BY CONSTRUCTION. Nothing here writes, and in particular the trade
 * residue is computed with its own query rather than by calling
 * `deriveProjectTrades`, which is reset-then-derive and would rewrite every
 * project's tags as a side effect of asking a question.
 *
 * The entrypoint lives in cli/data-audit.ts; everything here is importable
 * without side effects so the invariant logic can be unit-tested.
 */

/** Unresolved-and-unqueued records tolerated before the invariant trips. A few
 * in flight between a resolve run and a review write is normal; a pile is not. */
const UNRESOLVED_TOLERANCE = 10;

/** How many rows each "top N" list carries — enough to see shape, short enough to read. */
const TOP_N = 15;

type Row = Record<string, unknown>;

const num = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string => (v === null || v === undefined ? "—" : String(v));
const pct = (n: number, d: number): string => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);

async function one(db: Db, query: ReturnType<typeof sql>): Promise<Row> {
  const res = await db.execute(query);
  return (res.rows[0] as Row | undefined) ?? {};
}

async function many(db: Db, query: ReturnType<typeof sql>): Promise<Row[]> {
  const res = await db.execute(query);
  return res.rows as Row[];
}

export interface DataAudit {
  invariants: {
    corroborationNull: number;
    eventDedupeSurplus: number;
    unresolvedNotInReview: number;
    unresolvedTolerance: number;
  };
  coverage: {
    projects: number;
    located: number;
    /**
     * Never geocoded AND geocodable — no geometry, no attempt record, but an
     * address to work from. THE ONLY ONE OF THE THREE THAT IS A BACKLOG: it is
     * a row the nightly pass could have located and did not.
     */
    neverAttemptedWithAddress: number;
    /** No geometry, no attempt, and no address to attempt with. Structural. */
    neverAttemptedNoAddress: number;
    /** Geocoded and came back empty. A source-data fact, not a backlog. */
    attemptedNoMatch: number;
    events: number;
  };
  organizations: {
    total: number;
    byQuality: { quality: string; count: number }[];
    /** Normalized-name groups covering more than one organization row. */
    collisionGroups: { normalizedName: string; organizations: number }[];
  };
  /** T5 — junk-named orgs that carry something a junk row should not carry. */
  junkOrgSafety: {
    junkTotal: number;
    withRegistryRef: number;
    withIdentifiers: number;
    withAccountRelationship: number;
    violators: { id: string; name: string; why: string }[];
  };
  reviews: {
    pending: number;
    byRule: { rule: string; count: number }[];
    byAwaiting: { awaiting: string; count: number }[];
    comparandaUpgraded: number;
  };
  trades: {
    projects: number;
    tagged: number;
    untagged: number;
    untaggable: number;
    topUnmatched: { permitType: string; projects: number }[];
  };
  valuation: {
    byState: { state: string; opportunities: number; withoutValuation: number }[];
    bySource: { source: string; records: number; withoutValuation: number }[];
  };
}

export async function collect(db: Db): Promise<DataAudit> {
  const inv = await one(
    db,
    sql`SELECT
      (SELECT count(*) FROM projects WHERE corroboration IS NULL) AS corroboration_null,
      -- Surplus on the 0035 five-column key. The index makes this structurally
      -- zero; the check exists so a future migration that drops or weakens it
      -- announces itself instead of quietly re-admitting 2,997 duplicates.
      (SELECT COALESCE(sum(n - 1), 0) FROM (
         SELECT count(*) AS n FROM project_events
         GROUP BY project_id, source_record_id, event_type, event_date, observed_at
         HAVING count(*) > 1) d) AS event_dedupe_surplus,
      -- A public record that resolved to nothing AND is not queued for a human
      -- has fallen out of the pipeline entirely: nothing will ever look at it.
      (SELECT count(*) FROM source_records sr
        JOIN sources s ON s.id = sr.source_id AND s.account_profile_id IS NULL
        WHERE NOT EXISTS (SELECT 1 FROM record_resolutions rr
                           WHERE rr.source_record_id = sr.id AND rr.status = 'active')
          AND NOT EXISTS (SELECT 1 FROM resolution_reviews rv
                           WHERE rv.source_record_id = sr.id AND rv.status = 'pending')
      ) AS unresolved_not_in_review`,
  );

  const cov = await one(
    db,
    sql`SELECT
      (SELECT count(*) FROM projects) AS projects,
      (SELECT count(*) FROM projects WHERE geometry IS NOT NULL) AS located,
      -- THREE DIFFERENT FACTS, and collapsing them was this audit's first bug.
      -- "1,200 projects unlocated" reads as a 1,200-row backlog; it is 552 rows
      -- with no address to geocode, 646 that were geocoded and came back empty,
      -- and TWO that are genuinely waiting. Only the last number is work.
      -- A no-match attempt leaves meta behind; never-asked rows have neither.
      (SELECT count(*) FROM projects
        WHERE geometry IS NULL AND geocode_meta_json IS NULL
          AND address_normalized IS NOT NULL AND address_normalized <> ''
      ) AS never_attempted_with_address,
      (SELECT count(*) FROM projects
        WHERE geometry IS NULL AND geocode_meta_json IS NULL
          AND (address_normalized IS NULL OR address_normalized = '')
      ) AS never_attempted_no_address,
      (SELECT count(*) FROM projects
        WHERE geometry IS NULL AND geocode_meta_json IS NOT NULL) AS attempted_no_match,
      (SELECT count(*) FROM project_events) AS events`,
  );

  const orgTotal = num((await one(db, sql`SELECT count(*) AS n FROM organizations`))["n"]);
  const byQuality = await many(
    db,
    sql`SELECT COALESCE(name_quality, '(unclassified)') AS quality, count(*) AS n
        FROM organizations GROUP BY 1 ORDER BY 2 DESC`,
  );
  // Collision groups fold case and punctuation only. This is a REPORT, never a
  // merge input: the registry proved the point at scale — 853 name-variant
  // groups there shared zero UBIs, so name equality is not entity equality.
  const collisions = await many(
    db,
    sql`SELECT lower(regexp_replace(canonical_name, '[^a-zA-Z0-9]+', ' ', 'g')) AS norm,
               count(*) AS n
        FROM organizations
        GROUP BY 1 HAVING count(*) > 1
        ORDER BY 2 DESC, 1
        LIMIT ${TOP_N}`,
  );

  const junkCounts = await one(
    db,
    sql`SELECT
      (SELECT count(*) FROM organizations WHERE name_quality = 'junk') AS junk_total,
      (SELECT count(*) FROM organizations
        WHERE name_quality = 'junk' AND registry_ref IS NOT NULL) AS with_registry_ref,
      (SELECT count(*) FROM organizations o WHERE o.name_quality = 'junk'
        AND EXISTS (SELECT 1 FROM organization_identifiers oi
                     WHERE oi.organization_id = o.id)) AS with_identifiers,
      (SELECT count(*) FROM organizations o WHERE o.name_quality = 'junk'
        AND EXISTS (SELECT 1 FROM account_organization_relationships r
                     WHERE r.organization_id = o.id)) AS with_account_relationship`,
  );
  // Named, not just counted: a violator is an OWNER decision (is this row junk,
  // or is the classifier wrong?), and neither answer is available from a count.
  const violators = await many(
    db,
    sql`SELECT o.id, o.canonical_name AS name,
               concat_ws(' + ',
                 CASE WHEN o.registry_ref IS NOT NULL THEN 'registry_ref' END,
                 CASE WHEN EXISTS (SELECT 1 FROM organization_identifiers oi
                                    WHERE oi.organization_id = o.id) THEN 'identifiers' END,
                 CASE WHEN EXISTS (SELECT 1 FROM account_organization_relationships r
                                    WHERE r.organization_id = o.id) THEN 'account_relationship' END
               ) AS why
        FROM organizations o
        WHERE o.name_quality = 'junk'
          AND (o.registry_ref IS NOT NULL
               OR EXISTS (SELECT 1 FROM organization_identifiers oi WHERE oi.organization_id = o.id)
               OR EXISTS (SELECT 1 FROM account_organization_relationships r
                           WHERE r.organization_id = o.id))
        ORDER BY o.canonical_name
        LIMIT 50`,
  );

  const pending = num(
    (await one(db, sql`SELECT count(*) AS n FROM resolution_reviews WHERE status = 'pending'`))["n"],
  );
  const byRule = await many(
    db,
    sql`SELECT matched_rule AS rule, count(*) AS n
        FROM resolution_reviews WHERE status = 'pending'
        GROUP BY 1 ORDER BY 2 DESC`,
  );
  const byAwaiting = await many(
    db,
    sql`SELECT COALESCE(features_json->>'awaiting', '(untagged)') AS awaiting, count(*) AS n
        FROM resolution_reviews WHERE status = 'pending'
        GROUP BY 1 ORDER BY 2 DESC`,
  );
  const upgraded = num(
    (
      await one(
        db,
        sql`SELECT count(*) AS n FROM resolution_reviews
            WHERE status = 'pending' AND features_json->>'comparanda' = 'org_roles'`,
      )
    )["n"],
  );

  const tradeCounts = await one(
    db,
    sql`SELECT
      (SELECT count(*) FROM projects) AS projects,
      (SELECT count(*) FROM projects WHERE trade_codes IS NOT NULL) AS tagged,
      -- Untaggable: no public permit type on ANY active public resolution.
      -- Without this the untagged count reads as failure rather than absence.
      (SELECT count(*) FROM projects p WHERE NOT EXISTS (
         SELECT 1 FROM record_resolutions rr
         JOIN source_records sr ON sr.id = rr.source_record_id
         JOIN sources s ON s.id = sr.source_id AND s.account_profile_id IS NULL
         WHERE rr.project_id = p.id AND rr.status = 'active'
           AND sr.normalized_json ->> 'permitType' IS NOT NULL)) AS untaggable`,
  );
  // The residue, read-only: permit types carried by projects that ended up with
  // no trade codes. Deliberately NOT a to-do list — see project-trades.ts.
  const topUnmatched = await many(
    db,
    sql`SELECT upper(sr.normalized_json ->> 'permitType') AS permit_type,
               count(DISTINCT rr.project_id) AS projects
        FROM record_resolutions rr
        JOIN source_records sr ON sr.id = rr.source_record_id
        JOIN sources s ON s.id = sr.source_id AND s.account_profile_id IS NULL
        JOIN projects p ON p.id = rr.project_id
        WHERE rr.status = 'active'
          AND sr.normalized_json ->> 'permitType' IS NOT NULL
          AND p.trade_codes IS NULL
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${TOP_N}`,
  );

  // Reported PER STATE rather than as one "priority" figure: the band is a
  // config threshold, so a single number would silently re-define itself the
  // next time a delivery cutoff moves. Archive is excluded — an archived
  // opportunity's missing valuation is not a gap anyone will act on.
  const valuationByState = await many(
    db,
    sql`SELECT o.state,
               count(*) AS opportunities,
               count(*) FILTER (WHERE NOT EXISTS (
                 SELECT 1 FROM record_resolutions rr
                 JOIN source_records sr ON sr.id = rr.source_record_id
                 JOIN sources s ON s.id = sr.source_id AND s.account_profile_id IS NULL
                 WHERE rr.project_id = o.project_id AND rr.status = 'active'
                   AND sr.normalized_json ->> 'valuationUsd' IS NOT NULL)) AS without_valuation
        FROM opportunities o
        WHERE o.state <> 'archive'
        GROUP BY 1 ORDER BY 2 DESC`,
  );
  // Per-source null rate: this is the actionable half of D4. A source publishing
  // no valuations at all is a parser target; a source publishing some is not.
  const valuationBySource = await many(
    db,
    sql`SELECT s.key AS source,
               count(*) AS records,
               count(*) FILTER (WHERE sr.normalized_json ->> 'valuationUsd' IS NULL)
                 AS without_valuation
        FROM source_records sr
        JOIN sources s ON s.id = sr.source_id AND s.account_profile_id IS NULL
        GROUP BY 1 ORDER BY 2 DESC`,
  );

  return {
    invariants: {
      corroborationNull: num(inv["corroboration_null"]),
      eventDedupeSurplus: num(inv["event_dedupe_surplus"]),
      unresolvedNotInReview: num(inv["unresolved_not_in_review"]),
      unresolvedTolerance: UNRESOLVED_TOLERANCE,
    },
    coverage: {
      projects: num(cov["projects"]),
      located: num(cov["located"]),
      neverAttemptedWithAddress: num(cov["never_attempted_with_address"]),
      neverAttemptedNoAddress: num(cov["never_attempted_no_address"]),
      attemptedNoMatch: num(cov["attempted_no_match"]),
      events: num(cov["events"]),
    },
    organizations: {
      total: orgTotal,
      byQuality: byQuality.map((r) => ({ quality: str(r["quality"]), count: num(r["n"]) })),
      collisionGroups: collisions.map((r) => ({
        normalizedName: str(r["norm"]),
        organizations: num(r["n"]),
      })),
    },
    junkOrgSafety: {
      junkTotal: num(junkCounts["junk_total"]),
      withRegistryRef: num(junkCounts["with_registry_ref"]),
      withIdentifiers: num(junkCounts["with_identifiers"]),
      withAccountRelationship: num(junkCounts["with_account_relationship"]),
      violators: violators.map((r) => ({
        id: str(r["id"]),
        name: str(r["name"]),
        why: str(r["why"]),
      })),
    },
    reviews: {
      pending,
      byRule: byRule.map((r) => ({ rule: str(r["rule"]), count: num(r["n"]) })),
      byAwaiting: byAwaiting.map((r) => ({ awaiting: str(r["awaiting"]), count: num(r["n"]) })),
      comparandaUpgraded: upgraded,
    },
    trades: {
      projects: num(tradeCounts["projects"]),
      tagged: num(tradeCounts["tagged"]),
      untagged: num(tradeCounts["projects"]) - num(tradeCounts["tagged"]),
      untaggable: num(tradeCounts["untaggable"]),
      topUnmatched: topUnmatched.map((r) => ({
        permitType: str(r["permit_type"]),
        projects: num(r["projects"]),
      })),
    },
    valuation: {
      byState: valuationByState.map((r) => ({
        state: str(r["state"]),
        opportunities: num(r["opportunities"]),
        withoutValuation: num(r["without_valuation"]),
      })),
      bySource: valuationBySource.map((r) => ({
        source: str(r["source"]),
        records: num(r["records"]),
        withoutValuation: num(r["without_valuation"]),
      })),
    },
  };
}

/**
 * Which invariants are broken. EMPTY IS THE ONLY PASSING RESULT — everything
 * else in the report is a fact about the world and can never appear here.
 */
export function failedInvariants(a: DataAudit): string[] {
  const failures: string[] = [];
  if (a.invariants.corroborationNull > 0) {
    failures.push(
      `corroboration NULL on ${a.invariants.corroborationNull} project(s) — the derivation pass has not run`,
    );
  }
  if (a.invariants.eventDedupeSurplus > 0) {
    failures.push(
      `${a.invariants.eventDedupeSurplus} duplicate project_event(s) on the 0035 key — the unique index is not holding`,
    );
  }
  if (a.invariants.unresolvedNotInReview > a.invariants.unresolvedTolerance) {
    failures.push(
      `${a.invariants.unresolvedNotInReview} public record(s) neither resolved nor queued (tolerance ${a.invariants.unresolvedTolerance}) — they have fallen out of the pipeline`,
    );
  }
  return failures;
}

export function render(a: DataAudit): string {
  const L: string[] = [];
  const head = (t: string) => L.push("", t, "-".repeat(t.length));
  const kv = (k: string, v: string | number) => L.push(`  ${k.padEnd(34)} ${v}`);

  head("Invariants (a failure here is a bug, not a fact)");
  kv("corroboration NULL", a.invariants.corroborationNull);
  kv("duplicate events (0035 key)", a.invariants.eventDedupeSurplus);
  kv(
    "unresolved and unqueued",
    `${a.invariants.unresolvedNotInReview} (tolerance ${a.invariants.unresolvedTolerance})`,
  );

  head("Coverage");
  kv("projects", a.coverage.projects);
  kv("located", `${a.coverage.located} (${pct(a.coverage.located, a.coverage.projects)})`);
  kv("unlocated: never asked, HAS address", `${a.coverage.neverAttemptedWithAddress}  ← the only backlog`);
  kv("unlocated: no address to geocode", a.coverage.neverAttemptedNoAddress);
  kv("unlocated: asked, no match", a.coverage.attemptedNoMatch);
  kv("project events", a.coverage.events);

  head("Organization name quality");
  kv("organizations", a.organizations.total);
  for (const q of a.organizations.byQuality) {
    kv(`  ${q.quality}`, `${q.count} (${pct(q.count, a.organizations.total)})`);
  }
  L.push(
    "  NOTE person_or_unknown is a sole proprietor, not a defect — it is excluded",
    "       from GC-NAME surfaces and from nothing else.",
  );
  if (a.organizations.collisionGroups.length > 0) {
    L.push(`  name-collision groups (top ${TOP_N}, review only — never a merge input):`);
    for (const c of a.organizations.collisionGroups) {
      L.push(`    ${String(c.organizations).padStart(3)}  ${c.normalizedName}`);
    }
  }

  head("Junk-org safety sweep (T5)");
  kv("junk-named organizations", a.junkOrgSafety.junkTotal);
  kv("…carrying registry_ref", a.junkOrgSafety.withRegistryRef);
  kv("…carrying identifiers", a.junkOrgSafety.withIdentifiers);
  kv("…in an account relationship", a.junkOrgSafety.withAccountRelationship);
  if (a.junkOrgSafety.violators.length === 0) {
    L.push("  no violators — the junk tier is safe to filter everywhere.");
  } else {
    L.push("  VIOLATORS (owner decision — nothing is deleted, ever):");
    for (const v of a.junkOrgSafety.violators) L.push(`    ${v.name}  [${v.why}]  ${v.id}`);
  }

  head("Review queue");
  kv("pending", a.reviews.pending);
  for (const r of a.reviews.byRule) kv(`  ${r.rule}`, r.count);
  L.push("  by awaiting-tag:");
  for (const w of a.reviews.byAwaiting) kv(`  ${w.awaiting}`, w.count);
  kv("upgraded to org-role comparison", a.reviews.comparandaUpgraded);

  head("Trade tagging");
  kv("projects tagged", `${a.trades.tagged} (${pct(a.trades.tagged, a.trades.projects)})`);
  kv("untagged", a.trades.untagged);
  kv("…of which untaggable", `${a.trades.untaggable} (no public permit type at all)`);
  L.push(`  top unmatched permit types (top ${TOP_N} — NOT a vocabulary to-do list):`);
  for (const u of a.trades.topUnmatched) {
    L.push(`    ${String(u.projects).padStart(6)}  ${u.permitType}`);
  }

  head("Stated valuation");
  for (const s of a.valuation.byState) {
    kv(
      s.state,
      `${s.opportunities} opportunities, ${s.withoutValuation} without a stated valuation (${pct(s.withoutValuation, s.opportunities)})`,
    );
  }
  L.push("  per PUBLIC source (parser targets rank by this — nothing is ever invented):");
  for (const s of a.valuation.bySource) {
    L.push(
      `    ${s.source.padEnd(28)} ${String(s.records).padStart(7)} records  ${pct(s.withoutValuation, s.records)} without valuation`,
    );
  }

  return L.join("\n");
}
