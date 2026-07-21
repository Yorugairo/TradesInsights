CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE "account_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"capabilities_json" jsonb NOT NULL,
	"territory_json" jsonb NOT NULL,
	"exclusions_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capacity_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"delivery_config_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_profile_id" uuid NOT NULL,
	"rule_type" text NOT NULL,
	"rule_json" jsonb NOT NULL,
	"version" integer NOT NULL,
	"effective_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coverage_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"county" text,
	"permitting_jurisdiction" text,
	"record_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"last_success_at" timestamp with time zone,
	"freshness_state" text DEFAULT 'amber' NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_profile_id" uuid NOT NULL,
	"delivery_type" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"rendered_content" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"idempotency_key" text NOT NULL,
	"sent_at" timestamp with time zone,
	"metadata_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "delivery_items" (
	"delivery_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"project_event_id" uuid,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "developments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_name" text NOT NULL,
	"development_type" text,
	"county" text NOT NULL,
	"geometry" geometry(Geometry,4326),
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_record_id" uuid NOT NULL,
	"raw_artifact_id" uuid NOT NULL,
	"fact_path" text NOT NULL,
	"evidence_text" text NOT NULL,
	"page_or_section" text,
	"source_url" text NOT NULL,
	"authority_grade" text NOT NULL,
	"parser_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"relevant" boolean,
	"new_to_customer" boolean,
	"timely" boolean,
	"worth_pursuing" boolean,
	"disposition_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_profile_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"current_score" double precision,
	"score_version" text,
	"route" text,
	"state" text DEFAULT 'new' NOT NULL,
	"first_qualified_at" timestamp with time zone,
	"last_material_change_at" timestamp with time zone,
	"rationale_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "opportunity_evidence" (
	"opportunity_id" uuid NOT NULL,
	"evidence_item_id" uuid NOT NULL,
	"claim_type" text NOT NULL,
	"confirmed" boolean NOT NULL,
	"confidence" double precision
);
--> statement-breakpoint
CREATE TABLE "organization_aliases" (
	"organization_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"source_id" uuid
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_name" text NOT NULL,
	"legal_name" text,
	"ubi" text,
	"contractor_registration" text,
	"organization_type" text,
	"website" text,
	"status" text,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_date" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"prior_stage" text,
	"resulting_stage" text,
	"material_change" boolean DEFAULT false NOT NULL,
	"confirmed" boolean NOT NULL,
	"confidence" double precision
);
--> statement-breakpoint
CREATE TABLE "project_external_ids" (
	"project_id" uuid NOT NULL,
	"authority" text NOT NULL,
	"id_type" text NOT NULL,
	"external_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_roles" (
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"role" text NOT NULL,
	"source_record_id" uuid NOT NULL,
	"confirmed" boolean NOT NULL,
	"confidence" double precision,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"development_id" uuid,
	"parent_project_id" uuid,
	"canonical_name" text NOT NULL,
	"project_type" text,
	"permitting_jurisdiction" text NOT NULL,
	"county" text NOT NULL,
	"city" text,
	"address_normalized" text,
	"parcel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"geometry" geometry(Geometry,4326),
	"current_stage" text DEFAULT 'unknown' NOT NULL,
	"stage_confidence" double precision,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"parent_artifact_id" uuid,
	"canonical_url" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"source_published_at" timestamp with time zone,
	"content_type" text NOT NULL,
	"http_status" integer,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"headers_json" jsonb,
	"parser_version" text
);
--> statement-breakpoint
CREATE TABLE "source_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"raw_artifact_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"record_type" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"source_updated_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"raw_fields_json" jsonb NOT NULL,
	"normalized_json" jsonb NOT NULL,
	"normalized_fingerprint" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"checkpoint_json" jsonb,
	"discovered_count" integer DEFAULT 0 NOT NULL,
	"fetched_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"parsed_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"schema_fingerprint" text,
	"metrics_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"authority" text NOT NULL,
	"priority" text NOT NULL,
	"landing_url" text NOT NULL,
	"access_url" text,
	"format" text NOT NULL,
	"access_class" text NOT NULL,
	"cadence" text NOT NULL,
	"county" text,
	"permitting_jurisdiction" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"terms_reviewed_at" timestamp with time zone,
	"robots_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_profiles" ADD CONSTRAINT "account_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_rules" ADD CONSTRAINT "account_rules_account_profile_id_account_profiles_id_fk" FOREIGN KEY ("account_profile_id") REFERENCES "account_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_entries" ADD CONSTRAINT "coverage_entries_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_account_profile_id_account_profiles_id_fk" FOREIGN KEY ("account_profile_id") REFERENCES "account_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_project_event_id_project_events_id_fk" FOREIGN KEY ("project_event_id") REFERENCES "project_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_raw_artifact_id_raw_artifacts_id_fk" FOREIGN KEY ("raw_artifact_id") REFERENCES "raw_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_account_profile_id_account_profiles_id_fk" FOREIGN KEY ("account_profile_id") REFERENCES "account_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_evidence" ADD CONSTRAINT "opportunity_evidence_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_evidence" ADD CONSTRAINT "opportunity_evidence_evidence_item_id_evidence_items_id_fk" FOREIGN KEY ("evidence_item_id") REFERENCES "evidence_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_aliases" ADD CONSTRAINT "organization_aliases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_aliases" ADD CONSTRAINT "organization_aliases_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_external_ids" ADD CONSTRAINT "project_external_ids_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_roles" ADD CONSTRAINT "project_roles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_roles" ADD CONSTRAINT "project_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_roles" ADD CONSTRAINT "project_roles_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_development_id_developments_id_fk" FOREIGN KEY ("development_id") REFERENCES "developments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_artifacts" ADD CONSTRAINT "raw_artifacts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_artifacts" ADD CONSTRAINT "raw_artifacts_source_run_id_source_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "source_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_raw_artifact_id_raw_artifacts_id_fk" FOREIGN KEY ("raw_artifact_id") REFERENCES "raw_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_runs" ADD CONSTRAINT "source_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_profiles_key_ux" ON "account_profiles" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "account_rules_version_ux" ON "account_rules" USING btree ("account_profile_id","rule_type","version");--> statement-breakpoint
CREATE UNIQUE INDEX "coverage_entries_source_ux" ON "coverage_entries" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_idempotency_ux" ON "deliveries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "delivery_items_delivery_ix" ON "delivery_items" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "developments_county_ix" ON "developments" USING btree ("county");--> statement-breakpoint
CREATE INDEX "evidence_items_record_ix" ON "evidence_items" USING btree ("source_record_id","fact_path");--> statement-breakpoint
CREATE INDEX "feedback_opportunity_ix" ON "feedback" USING btree ("opportunity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_account_project_ux" ON "opportunities" USING btree ("account_profile_id","project_id");--> statement-breakpoint
CREATE INDEX "opportunities_state_ix" ON "opportunities" USING btree ("account_profile_id","state");--> statement-breakpoint
CREATE INDEX "opportunity_evidence_opp_ix" ON "opportunity_evidence" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "organization_aliases_alias_ix" ON "organization_aliases" USING btree ("alias");--> statement-breakpoint
CREATE INDEX "organizations_name_ix" ON "organizations" USING btree ("canonical_name");--> statement-breakpoint
CREATE INDEX "organizations_ubi_ix" ON "organizations" USING btree ("ubi");--> statement-breakpoint
CREATE INDEX "project_events_project_ix" ON "project_events" USING btree ("project_id","event_date");--> statement-breakpoint
CREATE INDEX "project_events_type_ix" ON "project_events" USING btree ("event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "project_external_ids_ux" ON "project_external_ids" USING btree ("authority","id_type","external_id");--> statement-breakpoint
CREATE INDEX "project_external_ids_project_ix" ON "project_external_ids" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_roles_project_ix" ON "project_roles" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "projects_county_ix" ON "projects" USING btree ("county");--> statement-breakpoint
CREATE INDEX "projects_stage_ix" ON "projects" USING btree ("current_stage");--> statement-breakpoint
CREATE INDEX "projects_jurisdiction_ix" ON "projects" USING btree ("permitting_jurisdiction");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_artifacts_identity_ux" ON "raw_artifacts" USING btree ("source_id","canonical_url","sha256");--> statement-breakpoint
CREATE INDEX "raw_artifacts_sha_ix" ON "raw_artifacts" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "raw_artifacts_run_ix" ON "raw_artifacts" USING btree ("source_run_id");--> statement-breakpoint
CREATE INDEX "raw_artifacts_retrieved_ix" ON "raw_artifacts" USING btree ("retrieved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_records_external_ux" ON "source_records" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "source_records_last_seen_ix" ON "source_records" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "source_records_type_ix" ON "source_records" USING btree ("record_type");--> statement-breakpoint
CREATE INDEX "source_runs_source_ix" ON "source_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "source_runs_status_ix" ON "source_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_key_ux" ON "sources" USING btree ("key");