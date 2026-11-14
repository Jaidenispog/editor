CREATE TABLE "square_availability_searches" (
	"id" text PRIMARY KEY NOT NULL,
	"environment" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"slots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"fetched_at" timestamp with time zone,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "square_environment" text DEFAULT 'sandbox' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "square_customer_id" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "end_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "square_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "attendance" text DEFAULT 'upcoming' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "attendance_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "owner_attendance" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "owner_attendance_by" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "owner_attendance_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "missing_from_square_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "square_environment" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "square_version" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "square_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "square_availability_searches" ADD CONSTRAINT "square_availability_searches_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "square_availability_searches_created_idx" ON "square_availability_searches" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_owner_attendance_by_users_id_fk" FOREIGN KEY ("owner_attendance_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_end_idx" ON "bookings" USING btree ("end_at");--> statement-breakpoint
CREATE INDEX "bookings_attendance_idx" ON "bookings" USING btree ("attendance","end_at");--> statement-breakpoint
CREATE INDEX "bookings_env_start_idx" ON "bookings" USING btree ("square_environment","start_at");