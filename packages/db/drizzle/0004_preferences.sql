ALTER TABLE "edit_versions" ADD COLUMN "render_brand" jsonb;--> statement-breakpoint
ALTER TABLE "edits" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "reference_profile" jsonb;--> statement-breakpoint
CREATE INDEX "feedback_events_created_idx" ON "feedback_events" USING btree ("created_at");