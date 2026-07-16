CREATE TABLE "bid_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bid_invitation_id" uuid NOT NULL,
	"raw_artifact_id" uuid,
	"document_type" text,
	"access_class" text DEFAULT 'private_authorized' NOT NULL,
	"extraction_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bid_invitation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bid_invitation_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_at" timestamp with time zone,
	"source_message_id" uuid,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bid_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_profile_id" uuid NOT NULL,
	"project_id" uuid,
	"gc_organization_id" uuid,
	"estimator_name" text,
	"estimator_email" text,
	"invitation_status" text DEFAULT 'invited' NOT NULL,
	"bid_due_at" timestamp with time zone,
	"job_walk_at" timestamp with time zone,
	"scope_summary" text,
	"source_message_id" uuid,
	"match_status" text DEFAULT 'unmatched' NOT NULL,
	"confidence" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_profile_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"sender" text,
	"recipients_json" jsonb,
	"subject" text,
	"received_at" timestamp with time zone,
	"raw_artifact_id" uuid,
	"processing_status" text DEFAULT 'received' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bid_documents" ADD CONSTRAINT "bid_documents_bid_invitation_id_bid_invitations_id_fk" FOREIGN KEY ("bid_invitation_id") REFERENCES "public"."bid_invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_documents" ADD CONSTRAINT "bid_documents_raw_artifact_id_raw_artifacts_id_fk" FOREIGN KEY ("raw_artifact_id") REFERENCES "public"."raw_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_invitation_events" ADD CONSTRAINT "bid_invitation_events_bid_invitation_id_bid_invitations_id_fk" FOREIGN KEY ("bid_invitation_id") REFERENCES "public"."bid_invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_invitation_events" ADD CONSTRAINT "bid_invitation_events_source_message_id_inbound_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."inbound_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_invitations" ADD CONSTRAINT "bid_invitations_account_profile_id_account_profiles_id_fk" FOREIGN KEY ("account_profile_id") REFERENCES "public"."account_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_invitations" ADD CONSTRAINT "bid_invitations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_invitations" ADD CONSTRAINT "bid_invitations_gc_organization_id_organizations_id_fk" FOREIGN KEY ("gc_organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_invitations" ADD CONSTRAINT "bid_invitations_source_message_id_inbound_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."inbound_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_account_profile_id_account_profiles_id_fk" FOREIGN KEY ("account_profile_id") REFERENCES "public"."account_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_raw_artifact_id_raw_artifacts_id_fk" FOREIGN KEY ("raw_artifact_id") REFERENCES "public"."raw_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bid_documents_invitation_ix" ON "bid_documents" USING btree ("bid_invitation_id");--> statement-breakpoint
CREATE INDEX "bid_invitation_events_invitation_ix" ON "bid_invitation_events" USING btree ("bid_invitation_id","created_at");--> statement-breakpoint
CREATE INDEX "bid_invitations_account_ix" ON "bid_invitations" USING btree ("account_profile_id","invitation_status");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_messages_provider_ux" ON "inbound_messages" USING btree ("account_profile_id","provider","provider_message_id");