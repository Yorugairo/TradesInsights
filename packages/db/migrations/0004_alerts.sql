CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_type" text NOT NULL,
	"subject_key" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"details_json" jsonb,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_idempotency_ux" ON "alerts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "alerts_open_ix" ON "alerts" USING btree ("alert_type","resolved_at");