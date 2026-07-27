/**
 * De-routing (2026-07-26) — an opportunity whose (project, account) pair STOPS
 * routing must not stay live at its last score.
 *
 * `scoreAll` only ever wrote the pairs `routeProject` returned, so a project
 * that fell out of an account's routing — territory edit, exclusion rule,
 * keyword reclassification — kept its row untouched forever. Found in
 * production: opportunity 93054ce2 (solis_interiors, weekly_digest, 72.5) still
 * carried algorithmVersion 1.9.0 three releases after 1.12.0, because its
 * shoreline/dock records no longer clear routeSolis's trade-fit gate.
 *
 * The fixture reproduces exactly that transition on one project: it routes to
 * Solis as an interior TI, then its records are rewritten to the shoreline/dock
 * text that made the real row fall out. Nothing here asserts a specific score —
 * only that a live row does not survive de-routing, that manual states are not
 * overturned, and that the sweep never touches a project the run did not read.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import {
  projectEvents,
  projects,
  rawArtifacts,
  sourceRecords,
  sourceRuns,
  type Db,
} from "@otn/db";
import {
  DEROUTE_REASON,
  SCORING_ALGORITHM_VERSION,
  deroutedOpportunities,
  scoreAll,
  scoredByCurrentAlgorithm,
  type LiveOpportunityRow,
} from "@otn/intelligence";
import { buildDigest } from "@otn/delivery";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();

/** Interior TI scope — clears routeSolis's trade-fit gate. */
const ROUTES_TO_SOLIS = {
  title: `DRT-${RUN} tenant improvement drywall and paint buildout`,
  description:
    "interior remodel: gypsum board partitions, level 4 finish, painting throughout the suite",
};
/** The real de-routed row's scope: shoreline/dock work with no interior,
 * commercial, multifamily or SFR vocabulary anywhere in it. */
const ROUTES_NOWHERE = {
  title: `DRT-${RUN} shoreline substantial development permit`,
  description: "environmental checklist for review of a replacement dock on the lake shore",
};

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let artifactId: string;
let solisAccountId: string;
/** No router exists for this key, so the sweep must never consider its rows. */
let routerlessAccountId: string;
/** A second routerless account, kept empty until the digest test, so that
 * test's candidate list is exactly the one row it seeds. */
let digestAccountId: string;

let projectId: string;
let recordId: string;
/** Live opportunity on a project OUTSIDE the scored scope — the control. */
let unscopedProjectId: string;
const createdProjectIds: string[] = [];

async function seedProject(
  name: string,
  scope: { title: string; description: string },
): Promise<{ projectId: string; recordId: string }> {
  const filedAt = new Date(Date.now() - 7 * 86_400_000);
  const [project] = await db
    .insert(projects)
    .values({
      canonicalName: name,
      permittingJurisdiction: `Deroute Test City ${RUN}`,
      county: "Thurston",
      currentStage: "permit_applied",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    })
    .returning({ id: projects.id });
  createdProjectIds.push(project!.id);
  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId,
      rawArtifactId: artifactId,
      externalId: name,
      recordType: "permit",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      rawFieldsJson: {},
      normalizedJson: { ...scope, valuationUsd: 250_000 },
      normalizedFingerprint: `deroute-${name}`,
    })
    .returning({ id: sourceRecords.id });
  await db.execute(sql`
    INSERT INTO record_resolutions
      (source_record_id, project_id, resolver_version, matched_rule, features_json, score, decision, status)
    VALUES (${record!.id}, ${project!.id}, 'test', 'new_project', '{}', 1, 'auto', 'active')`);
  // A recent CONFIRMED permit_applied event: supplies both the freshness clock
  // (appliedAt) and the recency factor, so timing does not decay mid-test.
  await db.insert(projectEvents).values({
    projectId: project!.id,
    sourceRecordId: record!.id,
    eventType: "permit_applied",
    eventDate: filedAt,
    observedAt: filedAt,
    resultingStage: "permit_applied",
    materialChange: true,
    confirmed: true,
    confidence: 1,
  });
  await db.execute(sql`
    INSERT INTO evidence_items
      (source_record_id, raw_artifact_id, fact_path, evidence_text, page_or_section,
       source_url, authority_grade, parser_version)
    VALUES (${record!.id}, ${artifactId}, 'project.scope', ${scope.description}, 'description',
      ${`https://example.invalid/deroute/${name}`}, 'A', 'test')`);
  return { projectId: project!.id, recordId: record!.id };
}

async function solisOpportunity(
  forProjectId = projectId,
): Promise<{ state: string; rationale: Record<string, unknown> | null } | null> {
  const res = await db.execute(sql`
    SELECT state, rationale_json FROM opportunities
    WHERE account_profile_id = ${solisAccountId} AND project_id = ${forProjectId}`);
  const row = res.rows[0] as
    | { state: string; rationale_json: Record<string, unknown> | null }
    | undefined;
  return row ? { state: row.state, rationale: row.rationale_json } : null;
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  sourceId = await resetSource(db, "fake_source");
  const [run] = await db
    .insert(sourceRuns)
    .values({ sourceId, status: "succeeded" })
    .returning({ id: sourceRuns.id });
  const [artifact] = await db
    .insert(rawArtifacts)
    .values({
      sourceId,
      sourceRunId: run!.id,
      canonicalUrl: `https://example.invalid/deroute/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/deroute-${RUN}`,
      sha256: `d${RUN}`.padEnd(64, "7").toLowerCase(),
      byteSize: 2,
      headersJson: {},
      parserVersion: "test",
    })
    .returning({ id: rawArtifacts.id });
  artifactId = artifact!.id;

  const solis = await db.execute(
    sql`SELECT id FROM account_profiles WHERE key = 'solis_interiors'`,
  );
  solisAccountId = (solis.rows[0] as { id: string } | undefined)!.id;

  const routerless = await db
    .execute(
      sql`INSERT INTO account_profiles (key, name, active, capabilities_json, territory_json, delivery_config_json)
          VALUES
            (${`test_deroute_${RUN.toLowerCase()}`}, ${`Deroute ${RUN}`}, true,
             '[]'::jsonb, '{}'::jsonb, '{}'::jsonb),
            (${`test_deroute_dg_${RUN.toLowerCase()}`}, ${`Deroute digest ${RUN}`}, true,
             '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)
          RETURNING id, key`,
    )
    .then((r) => r.rows as { id: string; key: string }[]);
  routerlessAccountId = routerless.find((a) => !a.key.includes("_dg_"))!.id;
  digestAccountId = routerless.find((a) => a.key.includes("_dg_"))!.id;

  ({ projectId, recordId } = await seedProject(`DRT-${RUN}-main`, ROUTES_TO_SOLIS));
  ({ projectId: unscopedProjectId } = await seedProject(
    `DRT-${RUN}-unscoped`,
    ROUTES_NOWHERE,
  ));
});

afterAll(async () => {
  await db.execute(
    sql`DELETE FROM opportunities WHERE project_id = ANY(${sql`ARRAY[${sql.join(
      createdProjectIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`})`,
  );
  await db.execute(
    sql`DELETE FROM account_profiles WHERE id IN (${routerlessAccountId}, ${digestAccountId})`,
  );
  await db.execute(sql`
    DELETE FROM evidence_items WHERE source_record_id IN (
      SELECT id FROM source_records WHERE source_id = ${sourceId})`);
  await deleteTestProjects(db, createdProjectIds);
  await pool.end();
});

describe("scoreAll de-route sweep", () => {
  it("scores the project into a live state while it still routes to Solis", async () => {
    const summary = await scoreAll(db, { projectIds: [projectId] });

    const opp = await solisOpportunity();
    expect(opp).not.toBeNull();
    // The premise of every assertion below: the row starts out DELIVERABLE.
    expect(opp!.state).not.toBe("archive");
    expect(opp!.rationale?.["algorithmVersion"]).toBe(SCORING_ALGORITHM_VERSION);
    expect(opp!.rationale?.["deroute"]).toBeUndefined();
    expect(summary.deroutedArchived).toBe(0);
  });

  it("archives the row, with a reason, once the project stops routing", async () => {
    // A live control row on a project this run will NOT read.
    await db.execute(sql`
      INSERT INTO opportunities (account_profile_id, project_id, current_score, state, rationale_json)
      VALUES (${solisAccountId}, ${unscopedProjectId}, 70, 'weekly_digest', '{"algorithmVersion":"0.0.0"}'::jsonb)
      ON CONFLICT (account_profile_id, project_id) DO UPDATE SET state = 'weekly_digest'`);
    // ...and one on the in-scope project for an account with NO router, which
    // never routes anything and so must never be swept.
    await db.execute(sql`
      INSERT INTO opportunities (account_profile_id, project_id, current_score, state)
      VALUES (${routerlessAccountId}, ${projectId}, 70, 'weekly_digest')
      ON CONFLICT (account_profile_id, project_id) DO UPDATE SET state = 'weekly_digest'`);

    // The reclassification: same project, records now describe shoreline/dock
    // work, so routeSolis's trade-fit gate rejects it.
    await db.execute(sql`
      UPDATE source_records
      SET normalized_json = ${JSON.stringify({ ...ROUTES_NOWHERE, valuationUsd: 250_000 })}::jsonb
      WHERE id = ${recordId}`);

    const summary = await scoreAll(db, { projectIds: [projectId] });

    const opp = await solisOpportunity();
    expect(opp!.state).toBe("archive");
    expect(summary.deroutedArchived).toBe(1);
    expect(summary.byAccount["solis_interiors"]?.derouted).toBe(1);

    // The row is kept and explained, not deleted or blanked: the reason sits
    // BESIDE the last real score rather than replacing it.
    const deroute = opp!.rationale?.["deroute"] as Record<string, unknown>;
    expect(deroute["reason"]).toBe(DEROUTE_REASON);
    expect(deroute["previousState"]).not.toBe("archive");
    expect(deroute["atAlgorithmVersion"]).toBe(SCORING_ALGORITHM_VERSION);
    expect(deroute["archivedAt"]).toBeTruthy();
    expect(opp!.rationale?.["components"]).toBeTruthy();

    // Scope safety: a project this run never read is untouched, even though its
    // pair also does not route and its score is three versions old.
    const control = await solisOpportunity(unscopedProjectId);
    expect(control!.state).toBe("weekly_digest");

    // An account with no router never routes anything — that is a config gap,
    // not a verdict on the project, so its row survives too.
    const routerless = await db.execute(sql`
      SELECT state FROM opportunities
      WHERE account_profile_id = ${routerlessAccountId} AND project_id = ${projectId}`);
    expect((routerless.rows[0] as { state: string }).state).toBe("weekly_digest");
  });

  it("never overturns a manual promote or dismiss", async () => {
    // The owner promotes the (still non-routing) row back into the live list.
    await db.execute(sql`
      UPDATE opportunities SET state = 'promoted'
      WHERE account_profile_id = ${solisAccountId} AND project_id = ${projectId}`);

    const summary = await scoreAll(db, { projectIds: [projectId] });

    expect((await solisOpportunity())!.state).toBe("promoted");
    expect(summary.deroutedArchived).toBe(0);

    await db.execute(sql`
      UPDATE opportunities SET state = 'dismissed'
      WHERE account_profile_id = ${solisAccountId} AND project_id = ${projectId}`);
    await scoreAll(db, { projectIds: [projectId] });
    expect((await solisOpportunity())!.state).toBe("dismissed");
  });

  it("re-scores and clears the marker if the pair starts routing again", async () => {
    await db.execute(sql`
      UPDATE opportunities SET state = 'archive'
      WHERE account_profile_id = ${solisAccountId} AND project_id = ${projectId}`);
    await db.execute(sql`
      UPDATE source_records
      SET normalized_json = ${JSON.stringify({ ...ROUTES_TO_SOLIS, valuationUsd: 250_000 })}::jsonb
      WHERE id = ${recordId}`);

    await scoreAll(db, { projectIds: [projectId] });

    const opp = await solisOpportunity();
    expect(opp!.state).not.toBe("archive");
    // The marker recorded a condition that no longer holds; it must not linger.
    expect(opp!.rationale?.["deroute"]).toBeUndefined();
  });
});

describe("deroutedOpportunities (selection rule)", () => {
  const row = (account: string, project: string): LiveOpportunityRow => ({
    id: `${account}-${project}`,
    accountProfileId: account,
    projectId: project,
  });

  it("selects only pairs whose project WAS scored and did not route", () => {
    const live = [row("a", "p1"), row("a", "p2"), row("b", "p1"), row("a", "p3")];
    const routed = new Set(["a::p1"]);
    const scored = new Set(["p1", "p2"]);

    const out = deroutedOpportunities(live, routed, scored).map((r) => r.id);
    // a::p1 routed; a::p3 was never scored by this run — neither is evidence of
    // de-routing. a::p2 and b::p1 were re-scored and came back empty.
    expect(out.sort()).toEqual(["a-p2", "b-p1"]);
  });

  it("selects nothing when the run scored nothing", () => {
    expect(deroutedOpportunities([row("a", "p1")], new Set(), new Set())).toEqual([]);
  });
});

describe("scoredByCurrentAlgorithm (delivery guard)", () => {
  it("passes only a rationale stamped with the running version", () => {
    expect(scoredByCurrentAlgorithm({ algorithmVersion: SCORING_ALGORITHM_VERSION })).toBe(true);
    expect(scoredByCurrentAlgorithm({ algorithmVersion: "1.9.0" })).toBe(false);
  });

  it("refuses a rationale that records no version at all", () => {
    // Unknown provenance is not the same as current provenance. scoreAll stamps
    // every row it touches, so a live row without a version cannot be vouched for.
    expect(scoredByCurrentAlgorithm(null)).toBe(false);
    expect(scoredByCurrentAlgorithm({})).toBe(false);
    expect(scoredByCurrentAlgorithm({ algorithmVersion: undefined })).toBe(false);
    expect(scoredByCurrentAlgorithm("1.12.0")).toBe(false);
  });
});

describe("digest withholds a stale-scored opportunity", () => {
  it("counts it in suppressed.staleScore instead of ranking it", async () => {
    // The production shape of the bug: a live, digest-band row whose score came
    // from a superseded algorithm version.
    await db.execute(sql`
      INSERT INTO opportunities (account_profile_id, project_id, current_score, state, rationale_json)
      VALUES (${digestAccountId}, ${unscopedProjectId}, 72.5, 'weekly_digest',
              '{"algorithmVersion":"1.9.0","route":"gc_relationship_radar"}'::jsonb)
      ON CONFLICT (account_profile_id, project_id) DO UPDATE
        SET state = 'weekly_digest', rationale_json = EXCLUDED.rationale_json`);

    const model = await buildDigest(db, digestAccountId, {
      start: new Date(Date.now() - 7 * 86_400_000),
      end: new Date(),
    });

    expect(model.candidateCount).toBe(1);
    expect(model.suppressed.staleScore).toBe(1);
    // It reaches no customer-facing section, and it is not silently dropped —
    // it is disclosed in the coverage/caveat count.
    const delivered = [
      ...model.sections.priorityNew,
      ...model.sections.stageChanges,
      ...model.sections.missingFacts,
      ...model.sections.monitoring,
      ...model.reviewQueue,
      ...model.easyWins,
    ];
    expect(delivered).toHaveLength(0);
    // The guard runs BEFORE the publication gate, so a stale row costs no query
    // and is never miscounted as a gate failure.
    expect(model.suppressed.gateFailed).toBe(0);
  });
});
