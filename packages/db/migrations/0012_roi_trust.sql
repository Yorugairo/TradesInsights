CREATE TABLE "account_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_profile_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_item_id" uuid,
	"opportunity_id" uuid,
	"correction_type" text NOT NULL,
	"prior_value_json" jsonb,
	"corrected_value_json" jsonb,
	"reason" text,
	"source_record_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"pursuit_id" uuid,
	"outcome_type" text NOT NULL,
	"influenced_by_otn" boolean DEFAULT false NOT NULL,
	"attributable_value" double precision,
	"outcome_at" timestamp with time zone,
	"reason_code" text,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_profile_id" uuid NOT NULL,
	"opportunity_id" uuid,
	"minutes_saved_estimate" double precision,
	"estimation_method" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roi_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_profile_id" uuid NOT NULL,
	"opportunity_id" uuid,
	"pursuit_id" uuid,
	"event_type" text NOT NULL,
	"estimated_value" double precision,
	"metadata_json" jsonb,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_suppressions" ADD CONSTRAINT "account_suppressions_account_profile_id_account_profiles_id_fk" FOREIGN KEY ("account_profile_id") REFERENCES "account_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_corrections" ADD CONSTRAINT "claim_corrections_evidence_item_id_evidence_items_id_fk" FOREIGN KEY ("evidence_item_id") REFERENCES "evidence_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_corrections" ADD CONSTRAINT "claim_corrections_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_corrections" ADD CONSTRAINT "claim_corrections_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_outcomes" ADD CONSTRAINT "opportunity_outcomes_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_outcomes" ADD CONSTRAINT "opportunity_outcomes_pursuit_id_pursuits_id_fk" FOREIGN KEY ("pursuit_id") REFERENCES "pursuits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_time_entries" ADD CONSTRAINT "research_time_entries_account_profile_id_account_profiles_id_fk" FOREIGN KEY ("account_profile_id") REFERENCES "account_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_time_entries" ADD CONSTRAINT "research_time_entries_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roi_events" ADD CONSTRAINT "roi_events_account_profile_id_account_profiles_id_fk" FOREIGN KEY ("account_profile_id") REFERENCES "account_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roi_events" ADD CONSTRAINT "roi_events_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roi_events" ADD CONSTRAINT "roi_events_pursuit_id_pursuits_id_fk" FOREIGN KEY ("pursuit_id") REFERENCES "pursuits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_suppressions_ix" ON "account_suppressions" USING btree ("account_profile_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "claim_corrections_opp_ix" ON "claim_corrections" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "opportunity_outcomes_opp_ix" ON "opportunity_outcomes" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "research_time_entries_account_ix" ON "research_time_entries" USING btree ("account_profile_id");--> statement-breakpoint
CREATE INDEX "roi_events_account_ix" ON "roi_events" USING btree ("account_profile_id","event_type");