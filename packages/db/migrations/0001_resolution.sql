CREATE TABLE "record_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_record_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"resolver_version" text NOT NULL,
	"matched_rule" text NOT NULL,
	"features_json" jsonb NOT NULL,
	"score" double precision NOT NULL,
	"decision" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_reason" text
);
--> statement-breakpoint
CREATE TABLE "resolution_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_record_id" uuid NOT NULL,
	"candidate_project_id" uuid,
	"matched_rule" text NOT NULL,
	"features_json" jsonb NOT NULL,
	"score" double precision NOT NULL,
	"reasons_json" jsonb NOT NULL,
	"resolver_version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"decision_note" text
);
--> statement-breakpoint
ALTER TABLE "record_resolutions" ADD CONSTRAINT "record_resolutions_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_resolutions" ADD CONSTRAINT "record_resolutions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_reviews" ADD CONSTRAINT "resolution_reviews_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_reviews" ADD CONSTRAINT "resolution_reviews_candidate_project_id_projects_id_fk" FOREIGN KEY ("candidate_project_id") REFERENCES "projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "record_resolutions_active_ux" ON "record_resolutions" USING btree ("source_record_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "record_resolutions_project_ix" ON "record_resolutions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "resolution_reviews_status_ix" ON "resolution_reviews" USING btree ("status");--> statement-breakpoint
CREATE INDEX "resolution_reviews_record_ix" ON "resolution_reviews" USING btree ("source_record_id");