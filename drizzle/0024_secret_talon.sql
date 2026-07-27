ALTER TABLE "audit_logs" ADD COLUMN "canonical_event" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "event_domain" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "event_version" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "is_state_change" boolean;--> statement-breakpoint
CREATE INDEX "ix_audit_canonical_time" ON "audit_logs" USING btree ("canonical_event","created_at");