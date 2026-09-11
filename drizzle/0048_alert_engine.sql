ALTER TABLE "system_alerts" ADD COLUMN "owner_role" text;--> statement-breakpoint
ALTER TABLE "system_alerts" ADD COLUMN "action_href" text;--> statement-breakpoint
ALTER TABLE "system_alerts" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "system_alerts" ADD COLUMN "source_rule" text;--> statement-breakpoint
ALTER TABLE "system_alerts" ADD COLUMN "params_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "system_alerts" ADD COLUMN "last_hit_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "system_alerts" ADD COLUMN "acked_by" integer;--> statement-breakpoint
ALTER TABLE "system_alerts" ADD COLUMN "acked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ix_alert_dedupe" ON "system_alerts" USING btree ("dedupe_key","status");