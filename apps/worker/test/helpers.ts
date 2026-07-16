import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  coverageEntries,
  createDb,
  createPool,
  evidenceItems,
  modelRuns,
  projectEvents,
  projectExternalIds,
  projectRoles,
  projects,
  rawArtifacts,
  recordResolutions,
  resolutionReviews,
  sourceRecords,
  sourceRuns,
  sources,
  type Db,
} from "@otn/db";
import { getSourceConfig } from "@otn/config";
import type pg from "pg";

const MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..",
  "packages", "db", "migrations",
);

export async function testDb(): Promise<{ db: Db; pool: pg.Pool }> {
  const pool = createPool();
  const db = createDb(pool);
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, pool };
}

/** Upserts a source row from config and clears its ingestion data for a deterministic test. */
export async function resetSource(db: Db, key: string): Promise<string> {
  const cfg = getSourceConfig(key);
  const [row] = await db
    .insert(sources)
    .values({
      key: cfg.key,
      name: cfg.name,
      authority: cfg.authority,
      priority: cfg.priority,
      landingUrl: cfg.landing_url,
      accessUrl: cfg.access_url,
      format: cfg.format,
      accessClass: cfg.access_class,
      cadence: cfg.cadence,
      county: cfg.county,
      permittingJurisdiction: cfg.permitting_jurisdiction,
      enabled: cfg.enabled,
      termsReviewedAt: cfg.terms_reviewed_at ? new Date(cfg.terms_reviewed_at) : null,
      robotsReviewedAt: cfg.robots_reviewed_at ? new Date(cfg.robots_reviewed_at) : null,
    })
    .onConflictDoUpdate({ target: sources.key, set: { enabled: cfg.enabled } })
    .returning({ id: sources.id });
  if (!row) throw new Error(`failed to upsert source ${key}`);

  await db
    .insert(coverageEntries)
    .values({ sourceId: row.id, county: cfg.county, status: "enabled" })
    .onConflictDoNothing();

  const recordIds = (
    await db
      .select({ id: sourceRecords.id })
      .from(sourceRecords)
      .where(eq(sourceRecords.sourceId, row.id))
  ).map((r) => r.id);
  if (recordIds.length > 0) {
    await db.delete(evidenceItems).where(inArray(evidenceItems.sourceRecordId, recordIds));
    // M2 resolution rows reference source records — clear them first.
    await db.delete(projectEvents).where(inArray(projectEvents.sourceRecordId, recordIds));
    await db.delete(projectRoles).where(inArray(projectRoles.sourceRecordId, recordIds));
    await db.delete(recordResolutions).where(inArray(recordResolutions.sourceRecordId, recordIds));
    await db.delete(resolutionReviews).where(inArray(resolutionReviews.sourceRecordId, recordIds));
  }
  await db.delete(sourceRecords).where(eq(sourceRecords.sourceId, row.id));
  await db.delete(rawArtifacts).where(eq(rawArtifacts.sourceId, row.id));
  await db.delete(sourceRuns).where(eq(sourceRuns.sourceId, row.id));
  return row.id;
}

/** Delete test-created projects and every row referencing them (tests only). */
export async function deleteTestProjects(db: Db, projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return;
  await db.delete(modelRuns).where(inArray(modelRuns.projectId, projectIds));
  await db.delete(projectEvents).where(inArray(projectEvents.projectId, projectIds));
  await db.delete(projectRoles).where(inArray(projectRoles.projectId, projectIds));
  await db.delete(projectExternalIds).where(inArray(projectExternalIds.projectId, projectIds));
  await db.delete(recordResolutions).where(inArray(recordResolutions.projectId, projectIds));
  await db
    .delete(resolutionReviews)
    .where(inArray(resolutionReviews.candidateProjectId, projectIds));
  await db.delete(projects).where(inArray(projects.id, projectIds));
}
