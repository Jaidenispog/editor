CREATE TABLE "search_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"property" text NOT NULL,
	"granularity" text NOT NULL,
	"period_start" date NOT NULL,
	"kind" text NOT NULL,
	"key" text DEFAULT '' NOT NULL,
	"clicks" integer,
	"impressions" integer,
	"position" real,
	"value" bigint,
	"value_threshold" bigint,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "website_audits" ADD COLUMN "requested_by" text;--> statement-breakpoint
ALTER TABLE "website_audits" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "website_audits" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "website_audits" ADD COLUMN "summary" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "website_edits" ADD COLUMN "source" text DEFAULT 'audit_rule' NOT NULL;--> statement-breakpoint
ALTER TABLE "website_edits" ADD COLUMN "finding_key" text;--> statement-breakpoint
ALTER TABLE "website_edits" ADD COLUMN "dedupe_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "website_edits" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "website_edits" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "website_edits" ADD COLUMN "apply_result" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "website_edits" ADD COLUMN "reverts_edit_id" text;--> statement-breakpoint
ALTER TABLE "website_edits" ADD COLUMN "ai_options" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "website_edits" ADD COLUMN "ai_drafted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "website_edits" ADD COLUMN "status_message" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "website_edits" ADD COLUMN "status_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "search_metrics_row_idx" ON "search_metrics" USING btree ("source","property","granularity","period_start","kind","key");--> statement-breakpoint
CREATE INDEX "search_metrics_lookup_idx" ON "search_metrics" USING btree ("source","property","kind","period_start");--> statement-breakpoint
ALTER TABLE "website_audits" ADD CONSTRAINT "website_audits_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_edits" ADD CONSTRAINT "website_edits_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_edits" ADD CONSTRAINT "website_edits_reverts_edit_id_website_edits_id_fk" FOREIGN KEY ("reverts_edit_id") REFERENCES "public"."website_edits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "website_audits_one_active_idx" ON "website_audits" USING btree ((true)) WHERE "website_audits"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "website_edits_open_dedupe_idx" ON "website_edits" USING btree ("dedupe_key") WHERE "website_edits"."status" in ('proposed', 'approved', 'applying', 'apply_failed') and "website_edits"."dedupe_key" <> '';--> statement-breakpoint
CREATE INDEX "website_edits_status_idx" ON "website_edits" USING btree ("status","created_at");