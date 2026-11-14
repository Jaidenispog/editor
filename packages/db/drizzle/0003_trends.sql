CREATE TABLE "trend_watches" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"query" text NOT NULL,
	"external_id" text,
	"social_account_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_message" text DEFAULT '' NOT NULL,
	"last_queried_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trend_references" ADD COLUMN "watch_id" text;--> statement-breakpoint
ALTER TABLE "trend_references" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "trend_references" ADD COLUMN "fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trend_references" ADD COLUMN "stale_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trend_references" ADD COLUMN "data" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "trend_references" ADD COLUMN "noted_by" text;--> statement-breakpoint
ALTER TABLE "trend_watches" ADD CONSTRAINT "trend_watches_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trend_watches" ADD CONSTRAINT "trend_watches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trend_watches_provider_query_idx" ON "trend_watches" USING btree ("provider","query");--> statement-breakpoint
ALTER TABLE "trend_references" ADD CONSTRAINT "trend_references_watch_id_trend_watches_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."trend_watches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trend_references" ADD CONSTRAINT "trend_references_noted_by_users_id_fk" FOREIGN KEY ("noted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trend_references_watch_ext_idx" ON "trend_references" USING btree ("watch_id","external_id") WHERE "trend_references"."external_id" is not null;