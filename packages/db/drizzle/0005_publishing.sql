ALTER TABLE "publish_targets" ALTER COLUMN "account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "social_accounts" ALTER COLUMN "access_token_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "publish_posts" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "publish_posts" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publish_posts" ADD COLUMN "status_message" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD COLUMN "method" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD COLUMN "delivery" text DEFAULT 'publish' NOT NULL;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD COLUMN "media_variant" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD COLUMN "media_key" text;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD COLUMN "manual_step" text;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD COLUMN "status_message" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD COLUMN "is_verification" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD COLUMN "confirmed_by" text;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD COLUMN "provider_state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "provider" text DEFAULT 'meta_graph' NOT NULL;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "connection_id" text;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "direct_publish_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "publish_posts" ADD CONSTRAINT "publish_posts_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD CONSTRAINT "publish_targets_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publish_posts_version_idx" ON "publish_posts" USING btree ("edit_version_id");--> statement-breakpoint
CREATE INDEX "publish_posts_project_idx" ON "publish_posts" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_targets_post_platform_idx" ON "publish_targets" USING btree ("post_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_targets_idempotency_idx" ON "publish_targets" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "publish_targets_external_post_idx" ON "publish_targets" USING btree ("platform","external_post_id");--> statement-breakpoint
CREATE INDEX "social_accounts_connection_idx" ON "social_accounts" USING btree ("connection_id");