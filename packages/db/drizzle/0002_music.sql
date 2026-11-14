CREATE TABLE "music_references" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'spotify' NOT NULL,
	"url" text NOT NULL,
	"item_type" text NOT NULL,
	"external_id" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "music_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"track_id" text NOT NULL,
	"edit_version_id" text NOT NULL,
	"purpose" text NOT NULL,
	"platform" text DEFAULT '' NOT NULL,
	"licence_snapshot" jsonb NOT NULL,
	"clearance" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edit_versions" ADD COLUMN "variant_exports" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "music_tracks" ADD COLUMN "genres" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "music_references" ADD CONSTRAINT "music_references_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "music_usage" ADD CONSTRAINT "music_usage_track_id_music_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."music_tracks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "music_usage" ADD CONSTRAINT "music_usage_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "music_references_provider_ext_idx" ON "music_references" USING btree ("provider","item_type","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "music_usage_version_purpose_idx" ON "music_usage" USING btree ("edit_version_id","purpose","platform");--> statement-breakpoint
CREATE INDEX "music_usage_track_idx" ON "music_usage" USING btree ("track_id","created_at");