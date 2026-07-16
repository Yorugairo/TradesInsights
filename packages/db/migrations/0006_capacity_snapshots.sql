CREATE TABLE "account_capacity_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_profile_id" uuid NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"available_crews" integer,
	"backlog_state" text,
	"preferred_start_window" text,
	"minimum_contract_value" double precision,
	"ideal_contract_value" double precision,
	"maximum_contract_value" double precision,
	"maximum_travel_minutes" integer,
	"accepts_public_work" boolean,
	"bonding_limit" double precision,
	"trade_capacity_json" jsonb,
	"provisional" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_capacity_snapshots" ADD CONSTRAINT "account_capacity_snapshots_account_profile_id_account_profiles_id_fk" FOREIGN KEY ("account_profile_id") REFERENCES "public"."account_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_capacity_snapshots_account_ix" ON "account_capacity_snapshots" USING btree ("account_profile_id","effective_from");