CREATE TABLE "system_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"ref_key" text,
	"title" text NOT NULL,
	"detail" text,
	"severity" text,
	"status" text DEFAULT 'open' NOT NULL,
	"auto_resolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "uq_notify_dedupe";--> statement-breakpoint
ALTER TABLE "po_docs" ADD COLUMN "confirm_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "po_docs" ADD COLUMN "confirm_token_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "po_lines" ADD COLUMN "expected_date" date;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "target_role" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ix_alert_status_cat" ON "system_alerts" USING btree ("status","category");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "uq_notify_dedupe" UNIQUE("dedupe_key");