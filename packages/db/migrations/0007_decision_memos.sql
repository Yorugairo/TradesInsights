CREATE TABLE "opportunity_decision_memos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"decision_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"memo_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opportunity_decision_memos" ADD CONSTRAINT "opportunity_decision_memos_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_decision_memos_version_ux" ON "opportunity_decision_memos" USING btree ("opportunity_id","decision_version");--> statement-breakpoint
CREATE INDEX "opportunity_decision_memos_opp_ix" ON "opportunity_decision_memos" USING btree ("opportunity_id");