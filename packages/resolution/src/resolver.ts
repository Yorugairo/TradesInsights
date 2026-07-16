import { and, eq, inArray, sql } from "drizzle-orm";
import {
  organizations,
  projectEvents,
  projectExternalIds,
  projectRoles,
  projects,
  recordResolutions,
  resolutionReviews,
  sourceRecords,
  sources,
  type Db,
} from "@otn/db";
import { NormalizedSourceRecordSchema, type NormalizedSourceRecord } from "@otn/domain";
import {
  extractFeatures,
  laterStage,
  normalizeAddress,
  normalizeOrgName,
  stageOrder,
  type MatchFeatures,
} from "./normalize.js";

export const RESOLVER_VERSION = "0.2.0"; // M2.2: passes 1–3

/** Record types that never become projects (canaries, registry listings). */
const NON_PROJECT_RECORD_TYPES = new Set(["source_canary"]);

export type MatchedRule =
  | "official_id"
  | "explicit_reference"
  | "parcel_overlap"
  | "new_project";

export interface ResolutionOutcome {
  sourceRecordId: string;
  outcome: "merged" | "created" | "review" | "skipped";
  rule: MatchedRule | null;
  projectId: string | null;
}

interface RecordRow {
  id: string;
  normalized: NormalizedSourceRecord;
  rawFields: Record<string, unknown>;
  firstSeenAt: Date;
}

/** Deterministic record→event mapping (spec §9) for first observation. */
export function eventTypeFor(record: NormalizedSourceRecord): string {
  switch (record.recordType) {
    case "sepa_document":
      return "sepa_determination";
    case "public_notice":
      return "notice_published";
    case "planning_application":
    case "permit_application":
    case "land_use_permit":
      return "application_submitted";
    case "building_permit":
    case "issued_permit":
      return record.issueDate ? "permit_issued" : "permit_applied";
    default:
      return "project_first_seen";
  }
}

function eventDateFor(record: NormalizedSourceRecord): Date | null {
  const d = record.issueDate ?? record.applicationDate ?? record.sourceUpdatedAt;
  return d ? new Date(d) : null;
}

async function registerExternalIds(
  db: Db,
  projectId: string,
  record: NormalizedSourceRecord,
  features: MatchFeatures,
): Promise<void> {
  const rows = [
    {
      projectId,
      authority: record.permittingJurisdiction,
      idType: "primary",
      externalId: record.externalId,
    },
    ...features.referenceIds.map((rid) => ({
      projectId,
      authority: record.permittingJurisdiction,
      idType: "reference",
      externalId: rid,
    })),
  ];
  await db.insert(projectExternalIds).values(rows).onConflictDoNothing();
}

async function upsertOrganizationsAndRoles(
  db: Db,
  projectId: string,
  row: RecordRow,
): Promise<void> {
  for (const org of row.normalized.organizations) {
    const norm = normalizeOrgName(org.name);
    const [existing] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.canonicalName, norm.canonical))
      .limit(1);
    let orgId = existing?.id;
    if (!orgId) {
      const [inserted] = await db
        .insert(organizations)
        .values({ canonicalName: norm.canonical })
        .returning({ id: organizations.id });
      orgId = inserted!.id;
    }
    const [existingRole] = await db
      .select({ projectId: projectRoles.projectId })
      .from(projectRoles)
      .where(
        and(
          eq(projectRoles.projectId, projectId),
          eq(projectRoles.organizationId, orgId),
          eq(projectRoles.role, org.role ?? "unknown"),
        ),
      )
      .limit(1);
    if (existingRole) {
      await db
        .update(projectRoles)
        .set({ lastSeenAt: row.firstSeenAt })
        .where(
          and(
            eq(projectRoles.projectId, projectId),
            eq(projectRoles.organizationId, orgId),
            eq(projectRoles.role, org.role ?? "unknown"),
          ),
        );
    } else {
      await db.insert(projectRoles).values({
        projectId,
        organizationId: orgId,
        role: org.role ?? "unknown",
        sourceRecordId: row.id,
        // Parser-emitted roles quote explicit source text → confirmed.
        confirmed: true,
        confidence: null,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.firstSeenAt,
      });
    }
  }
}

async function emitEvent(
  db: Db,
  projectId: string,
  row: RecordRow,
  opts: { priorStage: string | null; resultingStage: string | null },
): Promise<void> {
  const record = row.normalized;
  await db.insert(projectEvents).values({
    projectId,
    sourceRecordId: row.id,
    eventType: eventTypeFor(record),
    eventDate: eventDateFor(record),
    observedAt: row.firstSeenAt,
    priorStage: opts.priorStage,
    resultingStage: opts.resultingStage,
    materialChange:
      opts.priorStage !== null &&
      opts.resultingStage !== null &&
      opts.priorStage !== opts.resultingStage,
    confirmed: true,
    confidence: null,
  });
}

async function mergeIntoProject(
  db: Db,
  projectId: string,
  row: RecordRow,
  features: MatchFeatures,
): Promise<void> {
  const record = row.normalized;
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw new Error(`project ${projectId} vanished during merge`);

  const mergedParcels = [
    ...new Set([...(project.parcelIds as string[]), ...features.parcels]),
  ];
  const newStage = laterStage(project.currentStage, record.normalizedStage);
  const stageAdvanced =
    newStage !== project.currentStage && stageOrder(newStage) > -1;

  await db
    .update(projects)
    .set({
      lastSeenAt: row.firstSeenAt > project.lastSeenAt ? row.firstSeenAt : project.lastSeenAt,
      parcelIds: mergedParcels,
      currentStage: newStage,
      addressNormalized:
        project.addressNormalized ??
        (record.addressRaw ? normalizeAddress(record.addressRaw).line : null),
      city: project.city ?? record.city,
    })
    .where(eq(projects.id, projectId));

  await registerExternalIds(db, projectId, record, features);
  await upsertOrganizationsAndRoles(db, projectId, row);
  await emitEvent(db, projectId, row, {
    priorStage: stageAdvanced ? project.currentStage : null,
    resultingStage: stageAdvanced ? newStage : null,
  });
}

async function createProject(db: Db, row: RecordRow, features: MatchFeatures): Promise<string> {
  const record = row.normalized;
  const [inserted] = await db
    .insert(projects)
    .values({
      canonicalName: record.title,
      projectType: record.applicationType ?? record.permitType,
      permittingJurisdiction: record.permittingJurisdiction,
      county: record.county,
      city: record.city,
      addressNormalized: record.addressRaw ? normalizeAddress(record.addressRaw).line : null,
      parcelIds: features.parcels,
      currentStage: stageOrder(record.normalizedStage) > -1 ? record.normalizedStage : "unknown",
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.firstSeenAt,
    })
    .returning({ id: projects.id });
  const projectId = inserted!.id;
  await registerExternalIds(db, projectId, record, features);
  await upsertOrganizationsAndRoles(db, projectId, row);
  // First observation event (spec §9 project_first_seen) plus none-to-stage.
  await db.insert(projectEvents).values({
    projectId,
    sourceRecordId: row.id,
    eventType: "project_first_seen",
    eventDate: eventDateFor(record),
    observedAt: row.firstSeenAt,
    priorStage: null,
    resultingStage: record.normalizedStage,
    materialChange: false,
    confirmed: true,
    confidence: null,
  });
  return projectId;
}

/** Pass 1+2: match by official external id / explicit reference within scope. */
async function matchByIds(
  db: Db,
  record: NormalizedSourceRecord,
  features: MatchFeatures,
): Promise<{ rule: MatchedRule; projectId: string } | null> {
  // Pass 1 — same jurisdiction + official external id.
  const pass1 = await db
    .select({ projectId: projectExternalIds.projectId })
    .from(projectExternalIds)
    .where(
      and(
        eq(projectExternalIds.authority, record.permittingJurisdiction),
        eq(projectExternalIds.externalId, record.externalId),
      ),
    )
    .limit(2);
  if (pass1.length >= 1) return { rule: "official_id", projectId: pass1[0]!.projectId };

  // Pass 2 — explicit references (either direction, any authority: a SEPA
  // record citing a county file number is an explicit cross-source link).
  const candidates = [...features.referenceIds, record.externalId];
  if (candidates.length > 0) {
    const pass2 = await db
      .selectDistinct({ projectId: projectExternalIds.projectId })
      .from(projectExternalIds)
      .where(inArray(projectExternalIds.externalId, candidates))
      .limit(2);
    if (pass2.length === 1) {
      return { rule: "explicit_reference", projectId: pass2[0]!.projectId };
    }
    // >1 distinct projects sharing referenced ids is a conflict → caller reviews.
  }
  return null;
}

/** Pass 3: parcel overlap within the same county. */
async function matchByParcels(
  db: Db,
  record: NormalizedSourceRecord,
  features: MatchFeatures,
): Promise<{ projectIds: string[] }> {
  if (features.parcels.length === 0) return { projectIds: [] };
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.county, record.county),
        sql`${projects.parcelIds} ?| array[${sql.join(
          features.parcels.map((p) => sql`${p}`),
          sql`, `,
        )}]`,
      ),
    )
    .limit(5);
  return { projectIds: rows.map((r) => r.id) };
}

async function persistResolution(
  db: Db,
  row: RecordRow,
  projectId: string,
  rule: MatchedRule,
  features: MatchFeatures,
  score: number,
): Promise<void> {
  await db.insert(recordResolutions).values({
    sourceRecordId: row.id,
    projectId,
    resolverVersion: RESOLVER_VERSION,
    matchedRule: rule,
    featuresJson: features,
    score,
    decision: "auto",
  });
}

export async function resolveRecord(db: Db, row: RecordRow): Promise<ResolutionOutcome> {
  const record = row.normalized;
  if (NON_PROJECT_RECORD_TYPES.has(record.recordType)) {
    return { sourceRecordId: row.id, outcome: "skipped", rule: null, projectId: null };
  }
  const features = extractFeatures(record, row.rawFields);

  const idMatch = await matchByIds(db, record, features);
  if (idMatch) {
    await mergeIntoProject(db, idMatch.projectId, row, features);
    await persistResolution(db, row, idMatch.projectId, idMatch.rule, features, 1);
    return { sourceRecordId: row.id, outcome: "merged", rule: idMatch.rule, projectId: idMatch.projectId };
  }

  const parcelMatch = await matchByParcels(db, record, features);
  if (parcelMatch.projectIds.length === 1) {
    const projectId = parcelMatch.projectIds[0]!;
    // Jurisdiction conflict on a parcel match goes to review, not auto-merge.
    const [candidate] = await db
      .select({ jurisdiction: projects.permittingJurisdiction })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (candidate && candidate.jurisdiction !== record.permittingJurisdiction) {
      await db.insert(resolutionReviews).values({
        sourceRecordId: row.id,
        candidateProjectId: projectId,
        matchedRule: "parcel_overlap",
        featuresJson: features,
        score: 0.7,
        reasonsJson: ["conflicting_jurisdiction"],
        resolverVersion: RESOLVER_VERSION,
      });
      return { sourceRecordId: row.id, outcome: "review", rule: "parcel_overlap", projectId };
    }
    await mergeIntoProject(db, projectId, row, features);
    await persistResolution(db, row, projectId, "parcel_overlap", features, 0.95);
    return { sourceRecordId: row.id, outcome: "merged", rule: "parcel_overlap", projectId };
  }
  if (parcelMatch.projectIds.length > 1) {
    // Multiple parcel-sharing projects (e.g. same address, separate TIs) → review.
    await db.insert(resolutionReviews).values({
      sourceRecordId: row.id,
      candidateProjectId: parcelMatch.projectIds[0]!,
      matchedRule: "parcel_overlap",
      featuresJson: features,
      score: 0.6,
      reasonsJson: ["multiple_parcel_candidates"],
      resolverVersion: RESOLVER_VERSION,
    });
    return { sourceRecordId: row.id, outcome: "review", rule: "parcel_overlap", projectId: null };
  }

  const projectId = await createProject(db, row, features);
  await persistResolution(db, row, projectId, "new_project", features, 1);
  return { sourceRecordId: row.id, outcome: "created", rule: "new_project", projectId };
}

export interface ResolveRunSummary {
  processed: number;
  merged: number;
  created: number;
  review: number;
  skipped: number;
  errors: number;
}

/** Resolve every source record without an active resolution, oldest first. */
export async function resolveUnresolved(
  db: Db,
  opts: {
    limit?: number;
    /** Test-priority sources are excluded by default. */
    includeTestSources?: boolean;
    logger?: { info(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
  } = {},
): Promise<ResolveRunSummary> {
  const limit = opts.limit ?? 10_000;
  const rows = await db
    .select({
      id: sourceRecords.id,
      normalizedJson: sourceRecords.normalizedJson,
      rawFieldsJson: sourceRecords.rawFieldsJson,
      firstSeenAt: sourceRecords.firstSeenAt,
      sourceKey: sources.key,
    })
    .from(sourceRecords)
    .innerJoin(sources, eq(sources.id, sourceRecords.sourceId))
    .where(
      sql`NOT EXISTS (SELECT 1 FROM record_resolutions rr WHERE rr.source_record_id = ${sourceRecords.id} AND rr.status = 'active')
          AND NOT EXISTS (SELECT 1 FROM resolution_reviews rv WHERE rv.source_record_id = ${sourceRecords.id} AND rv.status = 'pending')
          ${opts.includeTestSources ? sql`` : sql`AND ${sources.priority} != 'test'`}`,
    )
    .orderBy(sourceRecords.firstSeenAt)
    .limit(limit);

  const summary: ResolveRunSummary = {
    processed: 0, merged: 0, created: 0, review: 0, skipped: 0, errors: 0,
  };
  for (const r of rows) {
    summary.processed++;
    try {
      const validated = NormalizedSourceRecordSchema.parse(r.normalizedJson);
      const outcome = await resolveRecord(db, {
        id: r.id,
        normalized: validated,
        rawFields: (r.rawFieldsJson ?? {}) as Record<string, unknown>,
        firstSeenAt: r.firstSeenAt,
      });
      summary[outcome.outcome === "merged" ? "merged" : outcome.outcome === "created" ? "created" : outcome.outcome === "review" ? "review" : "skipped"]++;
    } catch (err) {
      summary.errors++;
      opts.logger?.error({ sourceRecordId: r.id, err: String(err) }, "resolution failed");
    }
  }
  opts.logger?.info(summary, "resolution run complete");
  return summary;
}
