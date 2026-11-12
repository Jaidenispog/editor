CREATE TABLE "ai_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd_cents" real DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" text PRIMARY KEY NOT NULL,
	"square_booking_id" text NOT NULL,
	"square_version" integer DEFAULT 0 NOT NULL,
	"customer_id" text,
	"location_id" text DEFAULT '' NOT NULL,
	"team_member_id" text,
	"service_name" text DEFAULT '' NOT NULL,
	"service_variation_id" text,
	"start_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"completion_source" text DEFAULT 'none' NOT NULL,
	"completed_at" timestamp with time zone,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"square_customer_id" text,
	"given_name" text DEFAULT '' NOT NULL,
	"family_name" text DEFAULT '' NOT NULL,
	"email" text,
	"phone" text,
	"marketing_consent" boolean,
	"marketing_consent_source" text DEFAULT '' NOT NULL,
	"marketing_consent_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"review_requests_opt_out" boolean DEFAULT false NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edit_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"edit_id" text NOT NULL,
	"version_no" integer NOT NULL,
	"parent_version_id" text,
	"origin" text NOT NULL,
	"instruction" text DEFAULT '' NOT NULL,
	"plan_source" text,
	"planner_model" text,
	"plan" jsonb,
	"validation" jsonb,
	"status" text DEFAULT 'planning' NOT NULL,
	"status_message" text DEFAULT '' NOT NULL,
	"preview_key" text,
	"preview_duration_sec" real,
	"export_status" text DEFAULT 'none' NOT NULL,
	"export_key" text,
	"export_byte_size" bigint,
	"export_message" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edits" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"style_id" text NOT NULL,
	"slot" integer NOT NULL,
	"is_favourite" boolean DEFAULT false NOT NULL,
	"current_version_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text,
	"customer_id" text,
	"booking_id" text,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"body_html" text NOT NULL,
	"body_text" text NOT NULL,
	"purpose" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"provider_message_id" text,
	"error" text,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"subject" text NOT NULL,
	"body_markdown" text NOT NULL,
	"is_commercial" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"project_id" text,
	"edit_id" text,
	"edit_version_id" text,
	"style_id" text,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"settings" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"status_message" text DEFAULT '' NOT NULL,
	"planner_used" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'not_configured' NOT NULL,
	"external_account_id" text,
	"display_name" text DEFAULT '' NOT NULL,
	"access_token_encrypted" text,
	"refresh_token_encrypted" text,
	"token_expires_at" timestamp with time zone,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"project_id" text,
	"ref_id" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"boss_job_id" text,
	"worker_id" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"email_lower" text NOT NULL,
	"ip_address" text DEFAULT '' NOT NULL,
	"succeeded" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"original_key" text NOT NULL,
	"proxy_key" text,
	"thumbnail_key" text,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"status_message" text DEFAULT '' NOT NULL,
	"probe" jsonb,
	"analysis" jsonb,
	"manual_labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"clip_label" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "music_tracks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"title" text NOT NULL,
	"artist" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"catalogue_provider" text,
	"catalogue_track_id" text,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"duration_sec" real,
	"bpm" real,
	"beats" jsonb,
	"moods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"licence" jsonb NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"status_message" text DEFAULT '' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"client_name" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"last_settings" jsonb,
	"style_support" jsonb,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"edit_version_id" text NOT NULL,
	"created_by" text NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"cover_time_sec" real,
	"cover_key" text,
	"mode" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"music_check" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"account_id" text NOT NULL,
	"platform" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"external_container_id" text,
	"external_post_id" text,
	"published_url" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_id" text,
	"customer_id" text,
	"channel" text NOT NULL,
	"email_message_id" text,
	"status" text NOT NULL,
	"skip_reason" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_review_id" text NOT NULL,
	"rating" integer,
	"reviewer_name" text DEFAULT '' NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"review_created_at" timestamp with time zone,
	"reply_text" text,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"ip_address" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"username" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text,
	"token_expires_at" timestamp with time zone,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trend_references" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'format' NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text DEFAULT '' NOT NULL,
	"source_kind" text DEFAULT 'curated' NOT NULL,
	"last_verified_at" timestamp with time zone NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"total_bytes" bigint NOT NULL,
	"part_size_bytes" integer NOT NULL,
	"part_count" integer NOT NULL,
	"received_parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"driver_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"asset_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'staff' NOT NULL,
	"disabled_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature_valid" boolean NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_edits" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_id" text,
	"title" text NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"page_url" text DEFAULT '' NOT NULL,
	"proposed_change" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"applied_via" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_versions" ADD CONSTRAINT "edit_versions_edit_id_edits_id_fk" FOREIGN KEY ("edit_id") REFERENCES "public"."edits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edits" ADD CONSTRAINT "edits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edits" ADD CONSTRAINT "edits_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_template_id_email_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."email_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "music_tracks" ADD CONSTRAINT "music_tracks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_posts" ADD CONSTRAINT "publish_posts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_posts" ADD CONSTRAINT "publish_posts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD CONSTRAINT "publish_targets_post_id_publish_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."publish_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD CONSTRAINT "publish_targets_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_email_message_id_email_messages_id_fk" FOREIGN KEY ("email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_edits" ADD CONSTRAINT "website_edits_audit_id_website_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."website_audits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_created_idx" ON "ai_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_square_idx" ON "bookings" USING btree ("square_booking_id");--> statement-breakpoint
CREATE INDEX "bookings_start_idx" ON "bookings" USING btree ("start_at");--> statement-breakpoint
CREATE INDEX "bookings_customer_idx" ON "bookings" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_square_idx" ON "customers" USING btree ("square_customer_id");--> statement-breakpoint
CREATE INDEX "customers_email_idx" ON "customers" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "edit_versions_edit_no_idx" ON "edit_versions" USING btree ("edit_id","version_no");--> statement-breakpoint
CREATE INDEX "edit_versions_status_idx" ON "edit_versions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "edits_project_idx" ON "edits" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "edits_generation_idx" ON "edits" USING btree ("generation_id","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "email_messages_dedupe_idx" ON "email_messages" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "email_messages_status_idx" ON "email_messages" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "feedback_events_style_idx" ON "feedback_events" USING btree ("style_id","type");--> statement-breakpoint
CREATE INDEX "generations_project_idx" ON "generations" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_provider_idx" ON "integration_connections" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "jobs_project_idx" ON "jobs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "jobs_ref_idx" ON "jobs" USING btree ("ref_id");--> statement-breakpoint
CREATE INDEX "login_attempts_email_time_idx" ON "login_attempts" USING btree ("email_lower","created_at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_time_idx" ON "login_attempts" USING btree ("ip_address","created_at");--> statement-breakpoint
CREATE INDEX "media_assets_project_idx" ON "media_assets" USING btree ("project_id","sort_order");--> statement-breakpoint
CREATE INDEX "media_assets_status_idx" ON "media_assets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "music_tracks_project_idx" ON "music_tracks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "music_tracks_status_idx" ON "music_tracks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "projects_owner_idx" ON "projects" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "projects_deleted_idx" ON "projects" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "publish_posts_status_idx" ON "publish_posts" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_targets_post_account_idx" ON "publish_targets" USING btree ("post_id","account_id");--> statement-breakpoint
CREATE INDEX "publish_targets_status_idx" ON "publish_targets" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "review_requests_booking_idx" ON "review_requests" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "review_requests_status_idx" ON "review_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_provider_ext_idx" ON "reviews" USING btree ("provider","external_review_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_platform_ext_idx" ON "social_accounts" USING btree ("platform","external_id");--> statement-breakpoint
CREATE INDEX "trend_references_enabled_idx" ON "trend_references" USING btree ("enabled","category");--> statement-breakpoint
CREATE INDEX "upload_sessions_project_idx" ON "upload_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "upload_sessions_status_idx" ON "upload_sessions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_ext_idx" ON "webhook_events" USING btree ("provider","external_event_id");--> statement-breakpoint
CREATE INDEX "website_audits_created_idx" ON "website_audits" USING btree ("created_at");