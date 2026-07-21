CREATE TABLE "pursuit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pursuit_id" uuid NOT NULL,
	"author_user_id" text NOT NULL,
	"body" text NOT NULL,
	"visibility" text DEFAULT 'account' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pursuit_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pursuit_id" uuid NOT NULL,
	"title" text NOT NULL,
	"task_type" text NOT NULL,
	"owner_user_id" text,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pursuit_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pursuit_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"reason" text,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pursuits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_profile_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"state" text DEFAULT 'discovered' NOT NULL,
	"priority" integer,
	"owner_user_id" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_action_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"estimated_contract_value" double precision,
	"submitted_value" double precision,
	"outcome_value" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pursuit_notes" ADD CONSTRAINT "pursuit_notes_pursuit_id_pursuits_id_fk" FOREIGN KEY ("pursuit_id") REFERENCES "pursuits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pursuit_tasks" ADD CONSTRAINT "pursuit_tasks_pursuit_id_pursuits_id_fk" FOREIGN KEY ("pursuit_id") REFERENCES "pursuits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pursuit_transitions" ADD CONSTRAINT "pursuit_transitions_pursuit_id_pursuits_id_fk" FOREIGN KEY ("pursuit_id") REFERENCES "pursuits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pursuits" ADD CONSTRAINT "pursuits_account_profile_id_account_profiles_id_fk" FOREIGN KEY ("account_profile_id") REFERENCES "account_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pursuits" ADD CONSTRAINT "pursuits_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pursuit_notes_pursuit_ix" ON "pursuit_notes" USING btree ("pursuit_id","created_at");--> statement-breakpoint
CREATE INDEX "pursuit_tasks_pursuit_ix" ON "pursuit_tasks" USING btree ("pursuit_id","status");--> statement-breakpoint
CREATE INDEX "pursuit_transitions_pursuit_ix" ON "pursuit_transitions" USING btree ("pursuit_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pursuits_account_opportunity_ux" ON "pursuits" USING btree ("account_profile_id","opportunity_id");--> statement-breakpoint
CREATE INDEX "pursuits_account_state_ix" ON "pursuits" USING btree ("account_profile_id","state");