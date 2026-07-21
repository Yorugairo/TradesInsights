CREATE TABLE "artifact_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_artifact_id" uuid NOT NULL,
	"account_profile_id" uuid NOT NULL,
	"accessed_by" text NOT NULL,
	"purpose" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "account_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "artifact_access_log" ADD CONSTRAINT "artifact_access_log_raw_artifact_id_raw_artifacts_id_fk" FOREIGN KEY ("raw_artifact_id") REFERENCES "raw_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_access_log" ADD CONSTRAINT "artifact_access_log_account_profile_id_account_profiles_id_fk" FOREIGN KEY ("account_profile_id") REFERENCES "account_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_access_log_artifact_ix" ON "artifact_access_log" USING btree ("raw_artifact_id");