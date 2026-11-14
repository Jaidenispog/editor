CREATE TABLE "consent_events" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text,
	"email_lower" text NOT NULL,
	"kind" text NOT NULL,
	"basis" text DEFAULT '' NOT NULL,
	"scope" text DEFAULT 'marketing' NOT NULL,
	"method" text NOT NULL,
	"wording" text DEFAULT '' NOT NULL,
	"wording_hash" text DEFAULT '' NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_by" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"template_id" text,
	"subject" text NOT NULL,
	"body_markdown" text NOT NULL,
	"audience" jsonb DEFAULT '{"lastVisitWithinDays":null}'::jsonb NOT NULL,
	"audience_hash" text,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"paused_reason" text DEFAULT '' NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"bounce_count" integer DEFAULT 0 NOT NULL,
	"complaint_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"email_lower" text NOT NULL,
	"scope" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"stream" text,
	"email_message_id" text,
	"webhook_event_id" text,
	"pushed_to_provider_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"lifted_by" text,
	"lift_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "body_markdown" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "message_class" text DEFAULT 'campaign' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "stream" text;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "campaign_id" text;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "status_message" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "owner_action" text;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "consent_basis" jsonb;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "is_sandbox" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "unsubscribe_token_hash" text;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_templates" ADD COLUMN "message_class" text DEFAULT 'campaign' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_templates" ADD COLUMN "built_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "completion_evidence" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "attested_by" text;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "attested_visit_date" date;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "click_token_hash" text;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "first_clicked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "click_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_template_id_email_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."email_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_email_message_id_email_messages_id_fk" FOREIGN KEY ("email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_webhook_event_id_webhook_events_id_fk" FOREIGN KEY ("webhook_event_id") REFERENCES "public"."webhook_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_lifted_by_users_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_events_email_idx" ON "consent_events" USING btree ("email_lower","occurred_at");--> statement-breakpoint
CREATE INDEX "consent_events_customer_idx" ON "consent_events" USING btree ("customer_id","occurred_at");--> statement-breakpoint
CREATE INDEX "email_campaigns_created_idx" ON "email_campaigns" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppressions_active_idx" ON "email_suppressions" USING btree ("email_lower","scope","reason") WHERE "email_suppressions"."lifted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "email_suppressions_email_idx" ON "email_suppressions" USING btree ("email_lower");--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_campaign_id_email_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."email_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_attested_by_users_id_fk" FOREIGN KEY ("attested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_messages_campaign_idx" ON "email_messages" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "email_messages_unsub_token_idx" ON "email_messages" USING btree ("unsubscribe_token_hash") WHERE "email_messages"."unsubscribe_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "email_messages_provider_msg_idx" ON "email_messages" USING btree ("provider_message_id") WHERE "email_messages"."provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "email_messages_customer_idx" ON "email_messages" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "email_messages_to_idx" ON "email_messages" USING btree (lower("to_email"),"created_at");--> statement-breakpoint
CREATE INDEX "email_messages_sent_idx" ON "email_messages" USING btree ("origin","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_requests_dedupe_idx" ON "review_requests" USING btree ("dedupe_key") WHERE "review_requests"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "review_requests_click_token_idx" ON "review_requests" USING btree ("click_token_hash") WHERE "review_requests"."click_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "review_requests_customer_idx" ON "review_requests" USING btree ("customer_id","created_at");--> statement-breakpoint
UPDATE "email_templates" SET "message_class" = CASE WHEN "purpose" = 'review_request' THEN 'review_request' WHEN "is_commercial" = false THEN 'transactional_factual' ELSE 'campaign' END;