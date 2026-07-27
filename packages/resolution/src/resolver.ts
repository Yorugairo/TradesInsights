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
  crossNameKey,
  extractFeatures,
  laterStage,
  normalizeAddress,
  normalizeOrgName,
  stageOrder,
  type MatchFeatures,
} from "./normalize.js";
import { evaluateFuzzy } from "./fuzzy.js";
import {
  findBoundOrganizationByStrongKey,
  findOrganizationBySourceEntityId,
  persistOrganizationAlias,
  persistOrganizationIdentifiers,
} from "./identifiers.js";

export const RESOLVER_VERSION = "0.3.0"; // M2.2 passes 1–3 + M2.3 passes 4–5

/** Record types that never become projects (canaries, registry listings). */
const NON_PROJECT_RECORD_TYPES = new Set(["source_canary"]);

export type MatchedRule =
  | "official_id"
  | "explicit_reference"
  | "parcel_overlap"
  | "address_name"
  | "proximity_org"
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
  /** The SOURCE this record came from (`sources.id`, not `source_records.id`) —
   * provenance for captured organization aliases. Optional because the alias FK
   * is nullable and older call sites (review re-resolution, tests) don't carry
   * it; absent means the alias is stored with null provenance, never a guess. */
  sourceId?: string | null;
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
    case "inspection":
      return "inspection_activity";
    case "solicitation":
      return "solicitation_published";
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

/**
 * Record the name THIS record published for an org that was resolved by a
 * non-name key (source entity id / strong key) — the collapse cases, where the
 * stored `canonical_name` can legitimately differ from the incoming name.
 *
 * That difference is exactly what the binding matcher needs: before this, the
 * loser of a collapse was discarded and only the canonical was ever matched
 * against the registry, so an org whose canonical drifted from its L&I
 * registration could never bind. Skips names that fold to the SAME cross-system
 * key as the canonical (an alias that matches nothing new is noise).
 */
async function captureNameVariant(
  db: Db,
  organizationId: string,
  rawName: string,
  sourceId: string | null,
): Promise<void> {
  const incoming = crossNameKey(rawName);
  if (!incoming) return;
  const [existing] = await db
    .select({ canonicalName: organizations.canonicalName })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!existing || incoming === crossNameKey(existing.canonicalName)) return;
  await persistOrganizationAlias(db, organizationId, rawName, sourceId);
}

async function upsertOrganizationsAndRoles(
  db: Db,
  projectId: string,
  row: RecordRow,
): Promise<void> {
  for (const org of row.normalized.organizations) {
    const norm = normalizeOrgName(org.name);
    // Exact same-source clustering first: if a prior record already tied this
    // source entity id (e.g. Pierce applCustSysId) to an organization, reuse
    // it — stronger than a name-key match and immune to name-string drift.
    let orgId = (await findOrganizationBySourceEntityId(db, org.sourceEntityId)) ?? undefined;
    // WS-B.4 — collapse to an existing registry-BOUND org sharing this org's
    // strong key (UBI / contractor number) before falling back to name equality,
    // so name variants of one canonical entity don't spawn duplicates. Never
    // creates a binding; only reuses one the registry already confirmed.
    if (!orgId) {
      orgId =
        (await findBoundOrganizationByStrongKey(db, org.ubi, org.contractorLicense)) ?? undefined;
    }
    // Both tiers above reuse an org resolved by a key OTHER than the name, so
    // the name this record carries may be a variant worth keeping. The two
    // branches below can't produce one: a name match means the names already
    // agree, and an insert makes this name the canonical.
    const collapsedByNonNameKey = orgId !== undefined;
    if (!orgId) {
      const [existing] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.canonicalName, norm.canonical))
        .limit(1);
      orgId = existing?.id;
    }
    if (!orgId) {
      const [inserted] = await db
        .insert(organizations)
        .values({ canonicalName: norm.canonical })
        .returning({ id: organizations.id });
      orgId = inserted!.id;
    }
    // Persist any identifiers the source published for this org (phone / ubi /
    // licence / mailing address / source entity id — optional, additive) with
    // this record as evidence; strong keys backfeed onto the organization for
    // the registry link.
    if (org.phone || org.ubi || org.contractorLicense || org.address || org.sourceEntityId || org.website) {
      await persistOrganizationIdentifiers(db, orgId, row.id, org);
    }
    if (collapsedByNonNameKey) {
      await captureNameVariant(db, orgId, org.name, row.sourceId ?? null);
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

/**
 * IDEMPOTENT since migration 0035 — a repeat of the same event is dropped, and
 * a legitimate re-emit still lands.
 *
 * This used to be a bare INSERT into a table with no unique constraint, on the
 * reasoning that deduping would destroy real data: `applyRecordUpdates`
 * re-processes a record whose content drifted — a Seattle application becoming
 * an issued permit on the same row — and that genuinely emits a second event
 * with the same (projectId, sourceRecordId, eventType). That reasoning was
 * sound about the risk and wrong about the remedy. The distinguishing column is
 * `observed_at`: a re-emit is observed later, a duplicate is observed at the
 * same instant. Measured over 44,111 live rows, keying on the four identity
 * columns alone would have collapsed 2,997 rows; adding `observed_at` collapses
 * 2,861 and preserves the 136 real re-emits.
 *
 * `project_events_dedupe_ux` is therefore
 * (project_id, source_record_id, event_type, event_date, observed_at)
 * NULLS NOT DISTINCT — the NULLS clause because `event_date` is nullable and
 * would otherwise let those rows duplicate freely.
 *
 * Two consequences worth naming. First, the older KNOWN GAP is now benign:
 * `resolveRecord` is still not transactional, so a crash between this insert
 * and the resolution write leaves the event committed and the record
 * unresolved — but the next run's re-emit is now a no-op instead of a duplicate.
 * Second, this call is consequently safe to retry, which it was not before;
 * wrapping it in `withConnectionRetry` is now a free choice rather than a
 * correctness hazard, and is deliberately left for whoever needs it.
 */
async function emitEvent(
  db: Db,
  projectId: string,
  row: RecordRow,
  opts: { priorStage: string | null; resultingStage: string | null },
): Promise<void> {
  const record = row.normalized;
  await db
    .insert(projectEvents)
    .values({
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
    })
    .onConflictDoNothing();
}

/** Write the record's point geometry onto the project when it has none. */
async function fillGeometry(db: Db, projectId: string, row: RecordRow): Promise<void> {
  if (!row.normalized.geometry) return;
  await db.execute(sql`
    UPDATE projects
    SET geometry = ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(row.normalized.geometry)}), 4326)
    WHERE id = ${projectId} AND geometry IS NULL`);
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
  await fillGeometry(db, projectId, row);
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
  await fillGeometry(db, projectId, row);
  // First observation event (spec §9 project_first_seen) plus none-to-stage.
  // `onConflictDoNothing` here is belt-and-braces rather than load-bearing: the
  // project was created microseconds ago so nothing can collide with it. It is
  // present so that every write to `project_events` names the arbiter index and
  // none of them can raise on a duplicate — see `emitEvent` for the reasoning.
  await db
    .insert(projectEvents)
    .values({
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
    })
    .onConflictDoNothing();
  // The record that created the project also carries its own event (a permit
  // that opens a project is still a permit_issued on the timeline).
  const typeEvent = eventTypeFor(record);
  if (typeEvent !== "project_first_seen") {
    await db
      .insert(projectEvents)
      .values({
        projectId,
        sourceRecordId: row.id,
        eventType: typeEvent,
        eventDate: eventDateFor(record),
        observedAt: row.firstSeenAt,
        priorStage: null,
        resultingStage: null,
        materialChange: false,
        confirmed: true,
        confidence: null,
      })
      .onConflictDoNothing();
  }
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

/**
 * Pass 1b: the same authoritative permit number is already sitting in the
 * review queue on ANOTHER source record.
 *
 * `matchByIds` can only see ids that reached `project_external_ids`, and that
 * table is written exclusively by `registerExternalIds` from `mergeIntoProject`
 * and `createProject` — both of which need a project. A record parked in
 * `resolution_reviews` has no project, so its permit number is registered
 * nowhere queryable. The strongest key this system has is therefore INVISIBLE
 * to the resolver for exactly as long as a human has not answered an unrelated
 * question ("which project is this?").
 *
 * A second record carrying that same permit number then matches nothing, and
 * falls through to parcel matching, fuzzy matching, or `createProject` — every
 * one of which is a guess made against a key we already know is authoritative
 * and already know is undecided. Measured live 2026-07-27 on the Pierce PALS
 * hydration lane: 46 records did this. 31 created a SECOND project for a permit
 * we already held, and 15 merged on `parcel_overlap` into a project that
 * diverges from their twin's review candidate. In all 46 the twin's review
 * points somewhere else, so deciding those reviews splits one permit across two
 * projects permanently.
 *
 * So: an authoritative id whose twin is awaiting review means "we do not know
 * yet", and that must outrank every weaker pass rather than fall through them.
 * The record is parked next to its twin instead. This SELF-HEALS in both
 * directions — whichever way the reviewer decides, the twin ends up on a
 * project, that project registers the permit number, and this record's next
 * resolve pass hits `official_id` and merges. Nothing is stranded, and no
 * enrichment is lost: the record and its evidence are already stored, and the
 * review row carries its features, so a licence captured for a parked permit
 * shows up in the queue as the org support the twin was blocked for lacking.
 *
 * Same authority as pass 1 — a bare number is only unique within its
 * jurisdiction, and matching "1073191" across counties would invent twins.
 */
async function pendingReviewForSamePermit(
  db: Db,
  record: NormalizedSourceRecord,
  selfRecordId: string,
): Promise<{ candidateProjectId: string | null } | null> {
  const res = await db.execute(sql`
    SELECT rv.candidate_project_id
    FROM resolution_reviews rv
    JOIN source_records sr ON sr.id = rv.source_record_id
    WHERE rv.status = 'pending'
      AND sr.id <> ${selfRecordId}
      AND sr.external_id = ${record.externalId}
      AND sr.normalized_json->>'permittingJurisdiction' = ${record.permittingJurisdiction}
    ORDER BY rv.created_at
    LIMIT 1`);
  const row = res.rows[0] as { candidate_project_id: string | null } | undefined;
  if (!row) return null;
  return { candidateProjectId: row.candidate_project_id ?? null };
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
    // The content version being applied right now — applyRecordUpdates
    // re-processes this record when the stored fingerprint drifts.
    processedFingerprint: sql`(SELECT normalized_fingerprint FROM source_records WHERE id = ${row.id})`,
  });
}

/** Merge a record into a specific project on a human review decision (M2.5). */
export async function mergeIntoProjectForReview(
  db: Db,
  projectId: string,
  row: RecordRow,
): Promise<void> {
  const features = extractFeatures(row.normalized, row.rawFields);
  await mergeIntoProject(db, projectId, row, features);
}

export interface ResolveOptions {
  /** Projects a reviewer has rejected for this record — never re-matched. */
  excludeProjectIds?: string[];
  /**
   * A human is deciding THIS record right now, so pass 1b must not park it
   * behind a sibling that is only waiting on this very decision.
   *
   * Without this the two records hold each other and neither can ever produce a
   * project: A is parked, B arrives and is held pointing at A, and the reject
   * path then re-resolves A — which now sees B's pending review for the same
   * permit and parks A too. `decideReview` marks the row `rejected` BEFORE
   * re-resolving, so "does this record have a pending review" cannot
   * distinguish the two cases; the caller has to say so.
   */
  adjudicating?: boolean;
}

/**
 * What the resolver has DECIDED, before anything is written.
 *
 * Splitting this out is what lets `previewResolution` exist without becoming a
 * second, quietly diverging copy of the pass ladder. The alternative — a
 * read-only function that re-walks passes 1, 1b, 3, 4 and 5 in parallel — was
 * rejected: the two would agree on the day they were written and drift on the
 * first rule change, and a preview that disagrees with the apply is worse than
 * no preview, because it is trusted. There is exactly one pass sequence
 * (`decideResolution`); `resolveRecord` executes its verdict and
 * `previewResolution` reports it.
 */
export type ResolutionDecision =
  | { kind: "skip" }
  | { kind: "merge"; rule: MatchedRule; projectId: string; score: number }
  | {
      kind: "review";
      rule: MatchedRule;
      /** Written to `resolution_reviews.candidate_project_id`. */
      candidateProjectId: string | null;
      /**
       * Reported as `ResolutionOutcome.projectId`. Deliberately NOT always the
       * same as `candidateProjectId`: when several projects share the parcel,
       * the review row still carries the first as a starting point for the
       * human, but the outcome reports null, because naming one of several
       * would claim a choice the resolver did not make.
       */
      outcomeProjectId: string | null;
      score: number;
      reasons: string[];
    }
  | { kind: "create" };

/** Every match pass, in order, with no writes. */
async function decideResolution(
  db: Db,
  row: RecordRow,
  features: MatchFeatures,
  opts: ResolveOptions,
): Promise<ResolutionDecision> {
  const record = row.normalized;
  const excluded = new Set(opts.excludeProjectIds ?? []);
  if (NON_PROJECT_RECORD_TYPES.has(record.recordType)) return { kind: "skip" };

  let idMatch = await matchByIds(db, record, features);
  if (idMatch && excluded.has(idMatch.projectId)) idMatch = null;
  if (idMatch) {
    return { kind: "merge", rule: idMatch.rule, projectId: idMatch.projectId, score: 1 };
  }

  // Pass 1b — BEFORE parcel and fuzzy, deliberately. If the authoritative
  // permit number is already in the queue on another record, every weaker pass
  // below is a guess against a key we know is authoritative and know is
  // undecided. Hold this record next to its twin instead; it re-resolves on
  // `official_id` the moment the twin gets a project.
  const heldByTwin = opts.adjudicating
    ? null
    : await pendingReviewForSamePermit(db, record, row.id);
  if (heldByTwin) {
    return {
      kind: "review",
      rule: "official_id",
      candidateProjectId: heldByTwin.candidateProjectId,
      outcomeProjectId: heldByTwin.candidateProjectId,
      // Not a confidence in a PROJECT — the permit number is certain, the
      // project is exactly what is undecided. The candidate is carried through
      // so this row clusters with its twin in the review cockpit.
      score: 1,
      reasons: ["same_permit_pending_review"],
    };
  }

  const parcelIds = (await matchByParcels(db, record, features)).projectIds.filter(
    (id) => !excluded.has(id),
  );
  if (parcelIds.length === 1) {
    const projectId = parcelIds[0]!;
    // Jurisdiction conflict on a parcel match goes to review, not auto-merge.
    const [candidate] = await db
      .select({ jurisdiction: projects.permittingJurisdiction })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (candidate && candidate.jurisdiction !== record.permittingJurisdiction) {
      return {
        kind: "review",
        rule: "parcel_overlap",
        candidateProjectId: projectId,
        outcomeProjectId: projectId,
        score: 0.7,
        reasons: ["conflicting_jurisdiction"],
      };
    }
    return { kind: "merge", rule: "parcel_overlap", projectId, score: 0.95 };
  }
  if (parcelIds.length > 1) {
    // Multiple parcel-sharing projects (e.g. same address, separate TIs) → review.
    return {
      kind: "review",
      rule: "parcel_overlap",
      candidateProjectId: parcelIds[0]!,
      outcomeProjectId: null,
      score: 0.6,
      reasons: ["multiple_parcel_candidates"],
    };
  }

  // Passes 4–5 (M2.3) — fuzzy address/proximity with spec-§10 review gates.
  let fuzzy = await evaluateFuzzy(db, record, features);
  if (fuzzy && excluded.has(fuzzy.projectId)) fuzzy = null;
  if (fuzzy?.kind === "auto") {
    return { kind: "merge", rule: fuzzy.rule, projectId: fuzzy.projectId, score: fuzzy.score };
  }
  if (fuzzy?.kind === "review") {
    return {
      kind: "review",
      rule: fuzzy.rule,
      candidateProjectId: fuzzy.projectId,
      outcomeProjectId: fuzzy.projectId,
      score: fuzzy.score,
      reasons: fuzzy.reasons,
    };
  }

  return { kind: "create" };
}

export async function resolveRecord(
  db: Db,
  row: RecordRow,
  opts: ResolveOptions = {},
): Promise<ResolutionOutcome> {
  const features = extractFeatures(row.normalized, row.rawFields);
  const decision = await decideResolution(db, row, features, opts);

  switch (decision.kind) {
    case "skip":
      return { sourceRecordId: row.id, outcome: "skipped", rule: null, projectId: null };

    case "merge":
      await mergeIntoProject(db, decision.projectId, row, features);
      await persistResolution(
        db,
        row,
        decision.projectId,
        decision.rule,
        features,
        decision.score,
      );
      return {
        sourceRecordId: row.id,
        outcome: "merged",
        rule: decision.rule,
        projectId: decision.projectId,
      };

    case "review":
      await db.insert(resolutionReviews).values({
        sourceRecordId: row.id,
        candidateProjectId: decision.candidateProjectId,
        matchedRule: decision.rule,
        featuresJson: features,
        score: decision.score,
        reasonsJson: decision.reasons,
        resolverVersion: RESOLVER_VERSION,
      });
      return {
        sourceRecordId: row.id,
        outcome: "review",
        rule: decision.rule,
        projectId: decision.outcomeProjectId,
      };

    case "create": {
      const projectId = await createProject(db, row, features);
      await persistResolution(db, row, projectId, "new_project", features, 1);
      return { sourceRecordId: row.id, outcome: "created", rule: "new_project", projectId };
    }
  }
}

/** What `resolveRecord` WOULD do with this record right now. Writes nothing. */
export interface ResolutionPreview {
  sourceRecordId: string;
  outcome: ResolutionOutcome["outcome"];
  rule: MatchedRule | null;
  projectId: string | null;
  /** Populated only for a would-be review. */
  reasons: string[];
  score: number | null;
}

/**
 * Ask the resolver what it would decide, without touching the graph.
 *
 * The point of this is re-evaluation: a review parked weeks ago was a verdict
 * on the evidence available THEN. Evidence keeps arriving — a licence, a parcel,
 * a twin finally getting a project — and nothing re-asks the question. This
 * asks it, so `reevaluatePendingReviews` can clear rows that have since become
 * unambiguous instead of letting them accumulate.
 *
 * Shares `decideResolution` with `resolveRecord`, so the two cannot disagree.
 */
export async function previewResolution(
  db: Db,
  row: RecordRow,
  opts: ResolveOptions = {},
): Promise<ResolutionPreview> {
  const features = extractFeatures(row.normalized, row.rawFields);
  const decision = await decideResolution(db, row, features, opts);
  const base = { sourceRecordId: row.id, reasons: [] as string[] };
  switch (decision.kind) {
    case "skip":
      return { ...base, outcome: "skipped", rule: null, projectId: null, score: null };
    case "merge":
      return {
        ...base,
        outcome: "merged",
        rule: decision.rule,
        projectId: decision.projectId,
        score: decision.score,
      };
    case "review":
      return {
        sourceRecordId: row.id,
        outcome: "review",
        rule: decision.rule,
        projectId: decision.outcomeProjectId,
        reasons: decision.reasons,
        score: decision.score,
      };
    case "create":
      return { ...base, outcome: "created", rule: "new_project", projectId: null, score: 1 };
  }
}

/**
 * Guard for sources whose records may enter the SHARED project graph.
 * Account-scoped private records (customer bid inboxes) stay out: merging
 * them would let a private invitation move a shared project's stage/events,
 * leaking one account's private signal to others (M4.6 scaffold boundary).
 * The access_class check holds even when the account binding is NULL (a
 * not-yet-activated or unbound inbox source): private-CLASS data never
 * enters the shared graph on any binding state.
 */
export function sharedGraphSourceGuard() {
  return sql`(${sources.accountProfileId} IS NULL AND ${sources.accessClass} != 'private_authorized')`;
}

export interface ResolveRunSummary {
  processed: number;
  merged: number;
  created: number;
  review: number;
  skipped: number;
  /**
   * WHICH records failed, not just how many.
   *
   * This was a bare count, and the cost of that showed up on 2026-07-27: a run
   * reported `errors: 15` and the fifteen ids were unrecoverable — the per-row
   * `logger.error` had scrolled, and nothing was persisted. The failures turned
   * out to be transient and cleared on a re-run, but that was luck, not
   * knowledge; there was no way to tell a transient fault from fifteen
   * permanently malformed records without the ids.
   *
   * Shape mirrors `BulkDecisionSummary.errors` (review.ts) so the two error
   * lists read the same. The summary is written into the maintenance run's
   * durable metrics by the caller.
   */
  errors: { sourceRecordId: string; error: string }[];
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
      sourceId: sourceRecords.sourceId,
      sourceKey: sources.key,
    })
    .from(sourceRecords)
    .innerJoin(sources, eq(sources.id, sourceRecords.sourceId))
    .where(
      sql`NOT EXISTS (SELECT 1 FROM record_resolutions rr WHERE rr.source_record_id = ${sourceRecords.id} AND rr.status = 'active')
          AND NOT EXISTS (SELECT 1 FROM resolution_reviews rv WHERE rv.source_record_id = ${sourceRecords.id} AND rv.status = 'pending')
          ${opts.includeTestSources ? sql`` : sql`AND ${sources.priority} != 'test'`}
          AND ${sharedGraphSourceGuard()}`,
    )
    .orderBy(sourceRecords.firstSeenAt)
    .limit(limit);

  const summary: ResolveRunSummary = {
    processed: 0, merged: 0, created: 0, review: 0, skipped: 0, errors: [],
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
        sourceId: r.sourceId,
      });
      summary[outcome.outcome === "merged" ? "merged" : outcome.outcome === "created" ? "created" : outcome.outcome === "review" ? "review" : "skipped"]++;
    } catch (err) {
      // Both: the log line stays for tailing a live run, and the id is carried
      // out in the summary so it survives the run.
      summary.errors.push({ sourceRecordId: r.id, error: String(err) });
      opts.logger?.error({ sourceRecordId: r.id, err: String(err) }, "resolution failed");
    }
  }
  opts.logger?.info(summary, "resolution run complete");
  return summary;
}

export interface RecordUpdateSummary {
  checked: number;
  stageAdvanced: number;
  refreshed: number;
  errors: number;
}

/**
 * Stage-change follow-through: re-process actively-resolved records whose
 * CONTENT changed since they were applied to the graph (the runner updates
 * normalized_json + fingerprint in place when a source republishes a record —
 * e.g. a Seattle application becoming an issued permit on the same row).
 * Without this pass those transitions were invisible: resolveUnresolved skips
 * records with an active resolution, so the project stayed at its first-seen
 * stage forever and the digest's "material stage changes" section only ever
 * saw brand-new records.
 *
 * For each drifted record: advance the project stage when the record states a
 * LATER stage (spec §9 — never regress a stage from a single record), emit
 * the stage-change event (materialChange when it actually advanced), refresh
 * roles and geometry, and mark the content version processed. A NULL
 * processed_fingerprint (rows from before migration 0015) is treated as
 * drifted, so the first pass heals history.
 */
export async function applyRecordUpdates(
  db: Db,
  opts: {
    limit?: number;
    includeTestSources?: boolean;
    /** Restrict to specific records (targeted re-runs; test isolation). */
    sourceRecordIds?: string[];
    logger?: { info(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
  } = {},
): Promise<RecordUpdateSummary> {
  const limit = opts.limit ?? 10_000;
  const idFilter =
    opts.sourceRecordIds && opts.sourceRecordIds.length > 0
      ? sql`AND ${sourceRecords.id} IN (${sql.join(
          opts.sourceRecordIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``;
  const rows = await db
    .select({
      resolutionId: recordResolutions.id,
      projectId: recordResolutions.projectId,
      recordId: sourceRecords.id,
      normalizedJson: sourceRecords.normalizedJson,
      rawFieldsJson: sourceRecords.rawFieldsJson,
      lastSeenAt: sourceRecords.lastSeenAt,
      sourceId: sourceRecords.sourceId,
      fingerprint: sourceRecords.normalizedFingerprint,
    })
    .from(recordResolutions)
    .innerJoin(sourceRecords, eq(sourceRecords.id, recordResolutions.sourceRecordId))
    .innerJoin(sources, eq(sources.id, sourceRecords.sourceId))
    .where(
      sql`${recordResolutions.status} = 'active'
          AND ${recordResolutions.processedFingerprint} IS DISTINCT FROM ${sourceRecords.normalizedFingerprint}
          ${opts.includeTestSources ? sql`` : sql`AND ${sources.priority} != 'test'`}
          ${idFilter}
          AND ${sharedGraphSourceGuard()}`,
    )
    .orderBy(sourceRecords.lastSeenAt)
    .limit(limit);

  const summary: RecordUpdateSummary = { checked: 0, stageAdvanced: 0, refreshed: 0, errors: 0 };
  for (const r of rows) {
    summary.checked++;
    try {
      const record = NormalizedSourceRecordSchema.parse(r.normalizedJson);
      const row: RecordRow = {
        id: r.recordId,
        normalized: record,
        rawFields: (r.rawFieldsJson ?? {}) as Record<string, unknown>,
        // Observation time of THIS content version (when the update was fetched).
        firstSeenAt: r.lastSeenAt,
        sourceId: r.sourceId,
      };
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, r.projectId))
        .limit(1);
      if (!project) throw new Error(`project ${r.projectId} missing for update`);

      const newStage = laterStage(project.currentStage, record.normalizedStage);
      const advanced = newStage !== project.currentStage && stageOrder(newStage) > -1;
      if (advanced) {
        await db
          .update(projects)
          .set({ currentStage: newStage, lastSeenAt: r.lastSeenAt })
          .where(eq(projects.id, r.projectId));
        await emitEvent(db, r.projectId, row, {
          priorStage: project.currentStage,
          resultingStage: newStage,
        });
        summary.stageAdvanced++;
        opts.logger?.info(
          {
            projectId: r.projectId,
            sourceRecordId: r.recordId,
            priorStage: project.currentStage,
            resultingStage: newStage,
          },
          "record update advanced project stage",
        );
      } else {
        await db
          .update(projects)
          .set({ lastSeenAt: r.lastSeenAt })
          .where(eq(projects.id, r.projectId));
      }
      // Non-stage refreshes: new orgs/roles and geometry the update may carry.
      await upsertOrganizationsAndRoles(db, r.projectId, row);
      await fillGeometry(db, r.projectId, row);
      await db
        .update(recordResolutions)
        .set({ processedFingerprint: r.fingerprint })
        .where(eq(recordResolutions.id, r.resolutionId));
      summary.refreshed++;
    } catch (err) {
      summary.errors++;
      opts.logger?.error({ sourceRecordId: r.recordId, err: String(err) }, "record update failed");
    }
  }
  opts.logger?.info(summary, "record updates applied");
  return summary;
}
