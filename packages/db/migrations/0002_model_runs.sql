CREATE TABLE "model_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_type" text NOT NULL,
	"project_id" uuid,
	"account_profile_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" double precision,
	"latency_ms" integer,
	"result_hash" text,
	"result_json" jsonb,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_runs" ADD CONSTRAINT "model_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_runs" ADD CONSTRAINT "model_runs_account_profile_id_account_profiles_id_fk" FOREIGN KEY ("account_profile_id") REFERENCES "account_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_runs_project_ix" ON "model_runs" USING btree ("project_id","job_type");--> statement-breakpoint
CREATE INDEX "model_runs_month_ix" ON "model_runs" USING btree ("created_at");