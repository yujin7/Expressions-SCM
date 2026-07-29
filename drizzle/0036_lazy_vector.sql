ALTER TABLE "notifications" ADD COLUMN "dispatch_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "ck_notify_attempt_count" CHECK ("notifications"."attempt_count" >= 0);