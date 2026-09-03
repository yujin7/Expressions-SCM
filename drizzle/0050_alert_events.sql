CREATE TABLE "alert_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"alert_id" integer NOT NULL,
	"event" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" integer,
	"reason_code" text,
	"note" text,
	"evidence_ref" jsonb,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "alert_events_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ck_alert_events_event" CHECK ("alert_events"."event" IN ('open', 'refresh', 'ack', 'close', 'verify', 'reopen')),
	CONSTRAINT "ck_alert_events_reason" CHECK ("alert_events"."reason_code" IS NULL OR "alert_events"."reason_code" IN ('fixed', 'false_positive', 'wont_fix', 'superseded', 'auto_hysteresis', 'manual')),
	CONSTRAINT "ck_alert_events_close_reason_required" CHECK ("alert_events"."event" <> 'close' OR "alert_events"."reason_code" IS NOT NULL),
	CONSTRAINT "ck_alert_events_verify_evidence_required" CHECK ("alert_events"."event" <> 'verify' OR "alert_events"."evidence_ref" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_alert_id_system_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."system_alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_alert_events_alert_time" ON "alert_events" USING btree ("alert_id","at");--> statement-breakpoint
CREATE INDEX "ix_alert_events_event_time" ON "alert_events" USING btree ("event","at");--> statement-breakpoint
-- Alert history is an immutable fact ledger (same guard function as stock_ledger / audit_logs, migration 0023).
-- Corrections are new events (reopen / verify with a newer evidence_ref), never rewrites.
CREATE TRIGGER alert_events_append_only
BEFORE UPDATE OR DELETE ON alert_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER alert_events_append_only_truncate
BEFORE TRUNCATE ON alert_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();