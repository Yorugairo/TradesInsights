import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// PostGIS geometry (SRID 4326). Values pass as GeoJSON text via
// ST_GeomFromGeoJSON in repositories; M0 only needs the column to exist.
const geometry = customType<{ data: string }>({
  dataType() {
    return "geometry(Geometry,4326)";
  },
});

const now = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ── Sources & ingestion ──────────────────────────────────────────────────────

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    key: text("key").notNull(),
    name: text("name").notNull(),
    authority: text("authority").notNull(),
    priority: text("priority").notNull(),
    landingUrl: text("landing_url").notNull(),
    accessUrl: text("access_url"),
    format: text("format").notNull(),
    accessClass: text("access_class").notNull(),
    cadence: text("cadence").notNull(),
    county: text("county"),
    permittingJurisdiction: text("permitting_jurisdiction"),
    enabled: boolean("enabled").notNull().default(false),
    termsReviewedAt: timestamp("terms_reviewed_at", { withTimezone: true }),
    robotsReviewedAt: timestamp("robots_reviewed_at", { withTimezone: true }),
    /** Non-null = private, account-scoped source (customer bid inbox). */
    accountProfileId: uuid("account_profile_id"),
    createdAt: now(),
  },
  (t) => [uniqueIndex("sources_key_ux").on(t.key)],
);

export const sourceRuns = pgTable(
  "source_runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sourceId: uuid("source_id").notNull().references(() => sources.id),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    status: text("status").notNull().default("running"),
    checkpointJson: jsonb("checkpoint_json"),
    discoveredCount: integer("discovered_count").notNull().default(0),
    fetchedCount: integer("fetched_count").notNull().default(0),
    unchangedCount: integer("unchanged_count").notNull().default(0),
    parsedCount: integer("parsed_count").notNull().default(0),
    rejectedCount: integer("rejected_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    schemaFingerprint: text("schema_fingerprint"),
    metricsJson: jsonb("metrics_json"),
  },
  (t) => [
    index("source_runs_source_ix").on(t.sourceId, t.startedAt),
    index("source_runs_status_ix").on(t.status),
  ],
);

export const rawArtifacts = pgTable(
  "raw_artifacts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sourceId: uuid("source_id").notNull().references(() => sources.id),
    sourceRunId: uuid("source_run_id").notNull().references(() => sourceRuns.id),
    parentArtifactId: uuid("parent_artifact_id"),
    canonicalUrl: text("canonical_url").notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
    sourcePublishedAt: timestamp("source_published_at", { withTimezone: true }),
    contentType: text("content_type").notNull(),
    httpStatus: integer("http_status"),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    headersJson: jsonb("headers_json"),
    parserVersion: text("parser_version"),
    // D5 — the discovery-time context the parser needs (e.g. reportMonth,
    // inspectionDate). Set once at insert, never mutated; lets `replaySource`
    // re-parse the immutable bytes faithfully after a parser fix without
    // re-fetching.
    discoveryMetaJson: jsonb("discovery_meta_json"),
  },
  (t) => [
    // Immutability: one row per distinct content per URL per source.
    uniqueIndex("raw_artifacts_identity_ux").on(t.sourceId, t.canonicalUrl, t.sha256),
    index("raw_artifacts_sha_ix").on(t.sha256),
    index("raw_artifacts_run_ix").on(t.sourceRunId),
    index("raw_artifacts_retrieved_ix").on(t.retrievedAt),
  ],
);

export const sourceRecords = pgTable(
  "source_records",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sourceId: uuid("source_id").notNull().references(() => sources.id),
    rawArtifactId: uuid("raw_artifact_id").notNull().references(() => rawArtifacts.id),
    externalId: text("external_id").notNull(),
    recordType: text("record_type").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    status: text("status").notNull().default("active"),
    rawFieldsJson: jsonb("raw_fields_json").notNull(),
    normalizedJson: jsonb("normalized_json").notNull(),
    normalizedFingerprint: text("normalized_fingerprint").notNull(),
  },
  (t) => [
    uniqueIndex("source_records_external_ux").on(t.sourceId, t.externalId),
    index("source_records_last_seen_ix").on(t.lastSeenAt),
    index("source_records_type_ix").on(t.recordType),
  ],
);

export const evidenceItems = pgTable(
  "evidence_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sourceRecordId: uuid("source_record_id").notNull().references(() => sourceRecords.id),
    rawArtifactId: uuid("raw_artifact_id").notNull().references(() => rawArtifacts.id),
    factPath: text("fact_path").notNull(),
    evidenceText: text("evidence_text").notNull(),
    pageOrSection: text("page_or_section"),
    sourceUrl: text("source_url").notNull(),
    authorityGrade: text("authority_grade").notNull(),
    parserVersion: text("parser_version").notNull(),
  },
  (t) => [index("evidence_items_record_ix").on(t.sourceRecordId, t.factPath)],
);

// ── Project graph ────────────────────────────────────────────────────────────

export const developments = pgTable(
  "developments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    canonicalName: text("canonical_name").notNull(),
    developmentType: text("development_type"),
    county: text("county").notNull(),
    geometry: geometry("geometry"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("developments_county_ix").on(t.county)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    developmentId: uuid("development_id").references(() => developments.id),
    parentProjectId: uuid("parent_project_id"),
    canonicalName: text("canonical_name").notNull(),
    projectType: text("project_type"),
    permittingJurisdiction: text("permitting_jurisdiction").notNull(),
    county: text("county").notNull(),
    city: text("city"),
    addressNormalized: text("address_normalized"),
    parcelIds: jsonb("parcel_ids").notNull().default(sql`'[]'::jsonb`),
    geometry: geometry("geometry"),
    /** 'source_record' (a record's own geometry) or 'census_geocoder' (an
     * inference from the address — never overwrites record geometry). */
    geometrySource: text("geometry_source"),
    /** Full geocode-attempt record incl. no-match outcomes (rerun skip). */
    geocodeMetaJson: jsonb("geocode_meta_json"),
    currentStage: text("current_stage").notNull().default("unknown"),
    stageConfidence: doublePrecision("stage_confidence"),
    /** Derived active-campus membership ('<county>:<block>'), stamped/cleared
     * by computeCampusVelocity — rebuildable, like development_id. */
    campusBlock: text("campus_block"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("projects_county_ix").on(t.county),
    index("projects_stage_ix").on(t.currentStage),
    index("projects_jurisdiction_ix").on(t.permittingJurisdiction),
  ],
);

/** P2.3 — single-use, hashed, expiring one-tap email action tokens. */
export const actionTokens = pgTable(
  "action_tokens",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** SHA-256 of the raw token — the raw value never lands in the DB. */
    tokenHash: text("token_hash").notNull(),
    accountProfileId: uuid("account_profile_id").notNull().references(() => accountProfiles.id),
    opportunityId: uuid("opportunity_id").notNull(),
    deliveryId: uuid("delivery_id"),
    /** pursue | dismiss (DB CHECK enforced, migration 0019). */
    action: text("action").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("action_tokens_hash_ux").on(t.tokenHash)],
);

export const projectExternalIds = pgTable(
  "project_external_ids",
  {
    projectId: uuid("project_id").notNull().references(() => projects.id),
    authority: text("authority").notNull(),
    idType: text("id_type").notNull(),
    externalId: text("external_id").notNull(),
  },
  (t) => [
    uniqueIndex("project_external_ids_ux").on(t.authority, t.idType, t.externalId),
    index("project_external_ids_project_ix").on(t.projectId),
  ],
);

export const projectEvents = pgTable(
  "project_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    sourceRecordId: uuid("source_record_id").notNull().references(() => sourceRecords.id),
    eventType: text("event_type").notNull(),
    eventDate: timestamp("event_date", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    priorStage: text("prior_stage"),
    resultingStage: text("resulting_stage"),
    materialChange: boolean("material_change").notNull().default(false),
    confirmed: boolean("confirmed").notNull(),
    confidence: doublePrecision("confidence"),
  },
  (t) => [
    index("project_events_project_ix").on(t.projectId, t.eventDate),
    index("project_events_type_ix").on(t.eventType),
  ],
);

// ── Organizations ────────────────────────────────────────────────────────────

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    canonicalName: text("canonical_name").notNull(),
    legalName: text("legal_name"),
    ubi: text("ubi"),
    contractorRegistration: text("contractor_registration"),
    /** One Trade Network registry ID (P1.4) — set only by authorized import. */
    registryRef: text("registry_ref"),
    organizationType: text("organization_type"),
    website: text("website"),
    status: text("status"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (t) => [
    index("organizations_name_ix").on(t.canonicalName),
    index("organizations_ubi_ix").on(t.ubi),
  ],
);

export const organizationAliases = pgTable(
  "organization_aliases",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    alias: text("alias").notNull(),
    sourceId: uuid("source_id").references(() => sources.id),
  },
  (t) => [index("organization_aliases_alias_ix").on(t.alias)],
);

export const projectRoles = pgTable(
  "project_roles",
  {
    projectId: uuid("project_id").notNull().references(() => projects.id),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    role: text("role").notNull(),
    sourceRecordId: uuid("source_record_id").notNull().references(() => sourceRecords.id),
    confirmed: boolean("confirmed").notNull(),
    confidence: doublePrecision("confidence"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("project_roles_project_ix").on(t.projectId)],
);

// ── Accounts & opportunities ─────────────────────────────────────────────────

export const accountProfiles = pgTable(
  "account_profiles",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id").references(() => organizations.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    capabilitiesJson: jsonb("capabilities_json").notNull(),
    territoryJson: jsonb("territory_json").notNull(),
    exclusionsJson: jsonb("exclusions_json").notNull().default(sql`'{}'::jsonb`),
    capacityJson: jsonb("capacity_json").notNull().default(sql`'{}'::jsonb`),
    deliveryConfigJson: jsonb("delivery_config_json").notNull(),
  },
  (t) => [uniqueIndex("account_profiles_key_ux").on(t.key)],
);

export const accountRules = pgTable(
  "account_rules",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    accountProfileId: uuid("account_profile_id").notNull().references(() => accountProfiles.id),
    ruleType: text("rule_type").notNull(),
    ruleJson: jsonb("rule_json").notNull(),
    version: integer("version").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("account_rules_version_ux").on(t.accountProfileId, t.ruleType, t.version),
  ],
);

/**
 * S0 (strengthening addendum §5) — versioned capacity snapshots. A snapshot is
 * effective over [effective_from, effective_to); effective_to null = current.
 * Re-scoring reads the snapshot effective at scoring time, so the same project
 * scores differently under different capacity states while historical scores
 * are never rewritten. `provisional` flags placeholder values pending customer
 * calibration (governing rule: never present a guess as confirmed).
 */
export const accountCapacitySnapshots = pgTable(
  "account_capacity_snapshots",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    accountProfileId: uuid("account_profile_id").notNull().references(() => accountProfiles.id),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    availableCrews: integer("available_crews"),
    backlogState: text("backlog_state"),
    preferredStartWindow: text("preferred_start_window"),
    minimumContractValue: doublePrecision("minimum_contract_value"),
    idealContractValue: doublePrecision("ideal_contract_value"),
    maximumContractValue: doublePrecision("maximum_contract_value"),
    maximumTravelMinutes: integer("maximum_travel_minutes"),
    acceptsPublicWork: boolean("accepts_public_work"),
    bondingLimit: doublePrecision("bonding_limit"),
    tradeCapacityJson: jsonb("trade_capacity_json"),
    provisional: boolean("provisional").notNull().default(false),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: now(),
  },
  (t) => [
    index("account_capacity_snapshots_account_ix").on(t.accountProfileId, t.effectiveFrom),
  ],
);

export const opportunities = pgTable(
  "opportunities",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    accountProfileId: uuid("account_profile_id").notNull().references(() => accountProfiles.id),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    currentScore: doublePrecision("current_score"),
    scoreVersion: text("score_version"),
    route: text("route"),
    state: text("state").notNull().default("new"),
    firstQualifiedAt: timestamp("first_qualified_at", { withTimezone: true }),
    lastMaterialChangeAt: timestamp("last_material_change_at", { withTimezone: true }),
    rationaleJson: jsonb("rationale_json"),
  },
  (t) => [
    uniqueIndex("opportunities_account_project_ux").on(t.accountProfileId, t.projectId),
    index("opportunities_state_ix").on(t.accountProfileId, t.state),
  ],
);

export const opportunityEvidence = pgTable(
  "opportunity_evidence",
  {
    opportunityId: uuid("opportunity_id").notNull().references(() => opportunities.id),
    evidenceItemId: uuid("evidence_item_id").notNull().references(() => evidenceItems.id),
    claimType: text("claim_type").notNull(),
    confirmed: boolean("confirmed").notNull(),
    confidence: doublePrecision("confidence"),
  },
  (t) => [index("opportunity_evidence_opp_ix").on(t.opportunityId)],
);

/**
 * S1 (strengthening addendum §3) — persisted, versioned opportunity decision
 * memos. A new version is written only when the assembled content hash changes
 * (regenerate is idempotent). The memo is an assembly over stored gate /
 * extraction / verification / capacity / score rows — AI is never the system of
 * record; `memo_json` feeds the UI and never overwrites parsed facts.
 */
export const opportunityDecisionMemos = pgTable(
  "opportunity_decision_memos",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    opportunityId: uuid("opportunity_id").notNull().references(() => opportunities.id),
    decisionVersion: integer("decision_version").notNull(),
    contentHash: text("content_hash").notNull(),
    memoJson: jsonb("memo_json").notNull(),
    generatedAt: now(),
  },
  (t) => [
    uniqueIndex("opportunity_decision_memos_version_ux").on(t.opportunityId, t.decisionVersion),
    index("opportunity_decision_memos_opp_ix").on(t.opportunityId),
  ],
);

export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    opportunityId: uuid("opportunity_id").notNull().references(() => opportunities.id),
    userId: text("user_id").notNull(),
    relevant: boolean("relevant"),
    newToCustomer: boolean("new_to_customer"),
    timely: boolean("timely"),
    worthPursuing: boolean("worth_pursuing"),
    dispositionReason: text("disposition_reason"),
    notes: text("notes"),
    createdAt: now(),
  },
  (t) => [index("feedback_opportunity_ix").on(t.opportunityId)],
);

// ── Pursuit workflow (S2, strengthening addendum §4) ─────────────────────────
// An operational pipeline over qualified opportunities. Transitions are
// validated + audited server-side; human-only states can never be moved into by
// an AI job. Every active pursuit has a state and an owner.

export const pursuits = pgTable(
  "pursuits",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    accountProfileId: uuid("account_profile_id").notNull().references(() => accountProfiles.id),
    opportunityId: uuid("opportunity_id").notNull().references(() => opportunities.id),
    state: text("state").notNull().default("discovered"),
    priority: integer("priority"),
    ownerUserId: text("owner_user_id").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().default(sql`now()`),
    nextActionAt: timestamp("next_action_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    estimatedContractValue: doublePrecision("estimated_contract_value"),
    submittedValue: doublePrecision("submitted_value"),
    outcomeValue: doublePrecision("outcome_value"),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pursuits_account_opportunity_ux").on(t.accountProfileId, t.opportunityId),
    index("pursuits_account_state_ix").on(t.accountProfileId, t.state),
  ],
);

export const pursuitTransitions = pgTable(
  "pursuit_transitions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    pursuitId: uuid("pursuit_id").notNull().references(() => pursuits.id),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    reason: text("reason"),
    metadataJson: jsonb("metadata_json"),
    createdAt: now(),
  },
  (t) => [index("pursuit_transitions_pursuit_ix").on(t.pursuitId, t.createdAt)],
);

export const pursuitTasks = pgTable(
  "pursuit_tasks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    pursuitId: uuid("pursuit_id").notNull().references(() => pursuits.id),
    title: text("title").notNull(),
    taskType: text("task_type").notNull(),
    ownerUserId: text("owner_user_id"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    status: text("status").notNull().default("open"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    metadataJson: jsonb("metadata_json"),
    createdAt: now(),
  },
  (t) => [index("pursuit_tasks_pursuit_ix").on(t.pursuitId, t.status)],
);

export const pursuitNotes = pgTable(
  "pursuit_notes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    pursuitId: uuid("pursuit_id").notNull().references(() => pursuits.id),
    authorUserId: text("author_user_id").notNull(),
    body: text("body").notNull(),
    visibility: text("visibility").notNull().default("account"),
    createdAt: now(),
  },
  (t) => [index("pursuit_notes_pursuit_ix").on(t.pursuitId, t.createdAt)],
);

// ── Invitation ingestion (S3, strengthening addendum §6) ─────────────────────
// Provider-agnostic intake of customer-AUTHORIZED bid invitations (.eml upload,
// inbound-email webhook, CSV). Never scrapes portals/credentials. Every row is
// account-scoped private evidence; deadline changes create events and never
// overwrite history.

export const inboundMessages = pgTable(
  "inbound_messages",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    accountProfileId: uuid("account_profile_id").notNull().references(() => accountProfiles.id),
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    sender: text("sender"),
    recipientsJson: jsonb("recipients_json"),
    subject: text("subject"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    rawArtifactId: uuid("raw_artifact_id").references(() => rawArtifacts.id),
    processingStatus: text("processing_status").notNull().default("received"),
    createdAt: now(),
  },
  (t) => [
    // Idempotency: a duplicate forwarded message is ingested once per account.
    uniqueIndex("inbound_messages_provider_ux").on(t.accountProfileId, t.provider, t.providerMessageId),
  ],
);

export const bidInvitations = pgTable(
  "bid_invitations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    accountProfileId: uuid("account_profile_id").notNull().references(() => accountProfiles.id),
    projectId: uuid("project_id").references(() => projects.id),
    gcOrganizationId: uuid("gc_organization_id").references(() => organizations.id),
    estimatorName: text("estimator_name"),
    estimatorEmail: text("estimator_email"),
    invitationStatus: text("invitation_status").notNull().default("invited"),
    bidDueAt: timestamp("bid_due_at", { withTimezone: true }),
    jobWalkAt: timestamp("job_walk_at", { withTimezone: true }),
    scopeSummary: text("scope_summary"),
    sourceMessageId: uuid("source_message_id").references(() => inboundMessages.id),
    matchStatus: text("match_status").notNull().default("unmatched"),
    confidence: doublePrecision("confidence"),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("bid_invitations_account_ix").on(t.accountProfileId, t.invitationStatus)],
);

export const bidInvitationEvents = pgTable(
  "bid_invitation_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    bidInvitationId: uuid("bid_invitation_id").notNull().references(() => bidInvitations.id),
    eventType: text("event_type").notNull(),
    eventAt: timestamp("event_at", { withTimezone: true }),
    sourceMessageId: uuid("source_message_id").references(() => inboundMessages.id),
    metadataJson: jsonb("metadata_json"),
    createdAt: now(),
  },
  (t) => [index("bid_invitation_events_invitation_ix").on(t.bidInvitationId, t.createdAt)],
);

export const bidDocuments = pgTable(
  "bid_documents",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    bidInvitationId: uuid("bid_invitation_id").notNull().references(() => bidInvitations.id),
    rawArtifactId: uuid("raw_artifact_id").references(() => rawArtifacts.id),
    documentType: text("document_type"),
    accessClass: text("access_class").notNull().default("private_authorized"),
    extractionStatus: text("extraction_status").notNull().default("pending"),
    createdAt: now(),
  },
  (t) => [index("bid_documents_invitation_ix").on(t.bidInvitationId)],
);

// ── GC relationship intelligence (S4, strengthening addendum §7) ─────────────
// Account-specific relationship state, contacts, and interactions. Kept strictly
// distinct from the shared graph's public project_roles: a public role is what
// the record says; relationship_state is what the customer tells us. Blocked /
// do_not_pursue organizations suppress that account's alerts.

export const accountOrganizationRelationships = pgTable(
  "account_organization_relationships",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    accountProfileId: uuid("account_profile_id").notNull().references(() => accountProfiles.id),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    relationshipState: text("relationship_state").notNull().default("unknown"),
    relationshipOwnerUserId: text("relationship_owner_user_id"),
    firstContactAt: timestamp("first_contact_at", { withTimezone: true }),
    lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
    preferred: boolean("preferred").notNull().default(false),
    blocked: boolean("blocked").notNull().default(false),
    notes: text("notes"),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("account_org_relationship_ux").on(t.accountProfileId, t.organizationId),
  ],
);

export const organizationContacts = pgTable(
  "organization_contacts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    /** NULL = a GLOBAL public-business contact (e.g. adopted from the One
     * Trade Network registry / Google profile) visible to every account;
     * customer-supplied contacts stay account-scoped. DB CHECK enforces that
     * NULL is only legal with sourceType 'public_business' (migration 0020). */
    accountProfileId: uuid("account_profile_id").references(() => accountProfiles.id),
    name: text("name").notNull(),
    role: text("role"),
    email: text("email"),
    phone: text("phone"),
    // Provenance: 'public_business' (public source) vs 'customer_supplied' — kept
    // distinct so a public listing is never presented as a verified relationship.
    sourceType: text("source_type").notNull(),
    sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id),
    customerVerified: boolean("customer_verified").notNull().default(false),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [index("organization_contacts_account_ix").on(t.accountProfileId, t.organizationId)],
);

export const relationshipInteractions = pgTable(
  "relationship_interactions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    relationshipId: uuid("relationship_id").notNull().references(() => accountOrganizationRelationships.id),
    interactionType: text("interaction_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    projectId: uuid("project_id").references(() => projects.id),
    pursuitId: uuid("pursuit_id").references(() => pursuits.id),
    summary: text("summary"),
    createdBy: text("created_by"),
    createdAt: now(),
  },
  (t) => [index("relationship_interactions_rel_ix").on(t.relationshipId, t.occurredAt)],
);

// ── Outcome / ROI + trust controls (S5, strengthening addendum §8/§9) ────────
// Every metric reproduces from stored events; no manually edited aggregates.
// Attributable revenue requires an explicit human influenced_by_otn flag.

export const opportunityOutcomes = pgTable(
  "opportunity_outcomes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    opportunityId: uuid("opportunity_id").notNull().references(() => opportunities.id),
    pursuitId: uuid("pursuit_id").references(() => pursuits.id),
    outcomeType: text("outcome_type").notNull(),
    influencedByOtn: boolean("influenced_by_otn").notNull().default(false),
    attributableValue: doublePrecision("attributable_value"),
    outcomeAt: timestamp("outcome_at", { withTimezone: true }),
    reasonCode: text("reason_code"),
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: now(),
  },
  (t) => [index("opportunity_outcomes_opp_ix").on(t.opportunityId)],
);

export const roiEvents = pgTable(
  "roi_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    accountProfileId: uuid("account_profile_id").notNull().references(() => accountProfiles.id),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id),
    pursuitId: uuid("pursuit_id").references(() => pursuits.id),
    eventType: text("event_type").notNull(),
    estimatedValue: doublePrecision("estimated_value"),
    metadataJson: jsonb("metadata_json"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [index("roi_events_account_ix").on(t.accountProfileId, t.eventType)],
);

export const researchTimeEntries = pgTable(
  "research_time_entries",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    accountProfileId: uuid("account_profile_id").notNull().references(() => accountProfiles.id),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id),
    minutesSavedEstimate: doublePrecision("minutes_saved_estimate"),
    estimationMethod: text("estimation_method"),
    createdAt: now(),
  },
  (t) => [index("research_time_entries_account_ix").on(t.accountProfileId)],
);

export const accountSuppressions = pgTable(
  "account_suppressions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    accountProfileId: uuid("account_profile_id").notNull().references(() => accountProfiles.id),
    targetType: text("target_type").notNull(), // 'project' | 'organization'
    targetId: uuid("target_id").notNull(),
    reason: text("reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: now(),
  },
  (t) => [index("account_suppressions_ix").on(t.accountProfileId, t.targetType, t.targetId)],
);

export const claimCorrections = pgTable(
  "claim_corrections",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    evidenceItemId: uuid("evidence_item_id").references(() => evidenceItems.id),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id),
    correctionType: text("correction_type").notNull(),
    priorValueJson: jsonb("prior_value_json"),
    correctedValueJson: jsonb("corrected_value_json"),
    reason: text("reason"),
    sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id),
    createdBy: text("created_by"),
    createdAt: now(),
  },
  (t) => [index("claim_corrections_opp_ix").on(t.opportunityId)],
);

// ── Delivery & coverage ──────────────────────────────────────────────────────

export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    accountProfileId: uuid("account_profile_id").notNull().references(() => accountProfiles.id),
    deliveryType: text("delivery_type").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    renderedContent: text("rendered_content"),
    status: text("status").notNull().default("draft"),
    idempotencyKey: text("idempotency_key").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    metadataJson: jsonb("metadata_json"),
  },
  (t) => [uniqueIndex("deliveries_idempotency_ux").on(t.idempotencyKey)],
);

export const deliveryItems = pgTable(
  "delivery_items",
  {
    deliveryId: uuid("delivery_id").notNull().references(() => deliveries.id),
    opportunityId: uuid("opportunity_id").notNull().references(() => opportunities.id),
    projectEventId: uuid("project_event_id").references(() => projectEvents.id),
    position: integer("position").notNull(),
  },
  (t) => [index("delivery_items_delivery_ix").on(t.deliveryId)],
);

export const coverageEntries = pgTable(
  "coverage_entries",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sourceId: uuid("source_id").notNull().references(() => sources.id),
    county: text("county"),
    permittingJurisdiction: text("permitting_jurisdiction"),
    recordTypes: jsonb("record_types").notNull().default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("planned"),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    freshnessState: text("freshness_state").notNull().default("amber"),
    notes: text("notes"),
  },
  (t) => [uniqueIndex("coverage_entries_source_ux").on(t.sourceId)],
);

// ── Resolution (M2, spec §10) ────────────────────────────────────────────────
// Not in the spec §7 table list, but required by §10 ("record the resolver
// version, features, score, merge decision, and evidence; support split/undo")
// and the §17 review-queue API. Recorded as a schema extension in
// docs/architecture.md.

export const recordResolutions = pgTable(
  "record_resolutions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sourceRecordId: uuid("source_record_id").notNull().references(() => sourceRecords.id),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    resolverVersion: text("resolver_version").notNull(),
    /** official_id | explicit_reference | parcel_overlap | address_name | proximity_org | development_phase | new_project | review_merge */
    matchedRule: text("matched_rule").notNull(),
    featuresJson: jsonb("features_json").notNull(),
    score: doublePrecision("score").notNull(),
    /** auto | review_approved */
    decision: text("decision").notNull(),
    /** active | undone — undo never deletes source records or this history row. */
    status: text("status").notNull().default("active"),
    /** The record content version last applied to the graph — when it drifts
     * from source_records.normalized_fingerprint, applyRecordUpdates
     * re-processes the record (stage change, roles, geometry). */
    processedFingerprint: text("processed_fingerprint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoneReason: text("undone_reason"),
  },
  (t) => [
    uniqueIndex("record_resolutions_active_ux")
      .on(t.sourceRecordId)
      .where(sql`status = 'active'`),
    index("record_resolutions_project_ix").on(t.projectId),
  ],
);

export const resolutionReviews = pgTable(
  "resolution_reviews",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sourceRecordId: uuid("source_record_id").notNull().references(() => sourceRecords.id),
    candidateProjectId: uuid("candidate_project_id").references(() => projects.id),
    matchedRule: text("matched_rule").notNull(),
    featuresJson: jsonb("features_json").notNull(),
    score: doublePrecision("score").notNull(),
    /** Spec §10 review triggers that fired (conflicting_parcels, generic_name, …). */
    reasonsJson: jsonb("reasons_json").notNull(),
    resolverVersion: text("resolver_version").notNull(),
    /** pending | merged | rejected */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by"),
    decisionNote: text("decision_note"),
  },
  (t) => [
    index("resolution_reviews_status_ix").on(t.status),
    index("resolution_reviews_record_ix").on(t.sourceRecordId),
  ],
);

// ── Private-artifact access audit (spec §20) ─────────────────────────────────

/**
 * Every read of a customer's private invitation artifact/evidence is logged
 * (spec §20 "audit access to customer invitation artifacts"). Append-only.
 */
export const artifactAccessLog = pgTable(
  "artifact_access_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    rawArtifactId: uuid("raw_artifact_id").notNull().references(() => rawArtifacts.id),
    /** The account that OWNS the private artifact. */
    accountProfileId: uuid("account_profile_id").notNull().references(() => accountProfiles.id),
    /** Session identity that read it (account key or admin). */
    accessedBy: text("accessed_by").notNull(),
    purpose: text("purpose").notNull(),
    createdAt: now(),
  },
  (t) => [index("artifact_access_log_artifact_ix").on(t.rawArtifactId)],
);

// ── Operational alerts (spec §21 M4.7) ───────────────────────────────────────

/**
 * Spend/health/stale/delivery alerts. Idempotent by `idempotency_key`
 * (type:subject:period) so scheduled re-evaluation never duplicates an
 * alert; `resolved_at` closes it without deleting history.
 */
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** spend_budget | source_red | source_stale | delivery_unsent */
    alertType: text("alert_type").notNull(),
    subjectKey: text("subject_key").notNull(),
    /** warning | critical */
    severity: text("severity").notNull(),
    message: text("message").notNull(),
    detailsJson: jsonb("details_json"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: now(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("alerts_idempotency_ux").on(t.idempotencyKey),
    index("alerts_open_ix").on(t.alertType, t.resolvedAt),
  ],
);

// ── Model runs (spec §13 AI contract) ────────────────────────────────────────

/**
 * One row per model invocation (or per blocked/rejected attempt). AI is never
 * the system of record: the validated §13 payload lives in result_json for the
 * verifier/UI; it never overwrites parsed facts. Cost rows are the input to
 * the monthly budget check, so every spending call must be recorded here.
 */
export const modelRuns = pgTable(
  "model_runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** extraction | verification | brief_draft */
    jobType: text("job_type").notNull(),
    projectId: uuid("project_id").references(() => projects.id),
    accountProfileId: uuid("account_profile_id").references(() => accountProfiles.id),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: doublePrecision("cost_usd"),
    latencyMs: integer("latency_ms"),
    /** SHA-256 of the raw model output text. */
    resultHash: text("result_hash"),
    /** Zod-validated §13 payload (facts/inferences/missingCriticalFacts). */
    resultJson: jsonb("result_json"),
    /** succeeded | rejected | blocked | error */
    status: text("status").notNull(),
    error: text("error"),
    createdAt: now(),
  },
  (t) => [
    index("model_runs_project_ix").on(t.projectId, t.jobType),
    index("model_runs_month_ix").on(t.createdAt),
  ],
);
