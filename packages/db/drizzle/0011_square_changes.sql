CREATE TABLE "square_booking_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"environment" text NOT NULL,
	"merchant_id" text NOT NULL,
	"booking_id" text,
	"square_booking_id" text,
	"request" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"status_message" text DEFAULT '' NOT NULL,
	"http_status" integer,
	"error_code" text,
	"square_response" jsonb,
	"fresh_slots" jsonb,
	"self_test_id" text,
	"requested_by" text,
	"submitted_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "square_booking_changes" ADD CONSTRAINT "square_booking_changes_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "square_booking_changes" ADD CONSTRAINT "square_booking_changes_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "square_booking_changes_idem_idx" ON "square_booking_changes" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "square_booking_changes_booking_idx" ON "square_booking_changes" USING btree ("booking_id","created_at");--> statement-breakpoint
CREATE INDEX "square_booking_changes_status_idx" ON "square_booking_changes" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "square_booking_changes_selftest_idx" ON "square_booking_changes" USING btree ("self_test_id");