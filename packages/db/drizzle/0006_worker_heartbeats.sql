CREATE TABLE "worker_heartbeats" (
	"id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"pid" integer NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"queues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "worker_heartbeats_last_seen_idx" ON "worker_heartbeats" USING btree ("last_seen_at");