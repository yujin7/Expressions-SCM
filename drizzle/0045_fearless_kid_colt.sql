CREATE TABLE "po_promise_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"po_id" integer NOT NULL,
	"po_line_id" integer NOT NULL,
	"sequence" integer NOT NULL,
	"previous_date" date,
	"promised_date" date,
	"source" text NOT NULL,
	"actor_type" text NOT NULL,
	"recorded_by" integer,
	"reason" text,
	"external_source" text,
	"external_ref" text,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_po_promise_line_sequence" UNIQUE("po_line_id","sequence"),
	CONSTRAINT "uq_po_promise_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "ck_po_promise_sequence" CHECK ("po_promise_revisions"."sequence" > 0),
	CONSTRAINT "ck_po_promise_source" CHECK ("po_promise_revisions"."source" IN ('supplier_confirm', 'buyer_revision', 'legacy_backfill', 'external_observation')),
	CONSTRAINT "ck_po_promise_actor_type" CHECK ("po_promise_revisions"."actor_type" IN ('supplier_token', 'internal_user', 'system_backfill', 'external_system')),
	CONSTRAINT "ck_po_promise_date_changed" CHECK ("po_promise_revisions"."previous_date" IS DISTINCT FROM "po_promise_revisions"."promised_date")
);
--> statement-breakpoint
ALTER TABLE "po_promise_revisions" ADD CONSTRAINT "po_promise_revisions_po_id_po_docs_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."po_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_promise_revisions" ADD CONSTRAINT "po_promise_revisions_po_line_id_po_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."po_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_promise_revisions" ADD CONSTRAINT "po_promise_revisions_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_po_promise_po_occurred" ON "po_promise_revisions" USING btree ("po_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_po_promise_line_occurred" ON "po_promise_revisions" USING btree ("po_line_id","occurred_at");--> statement-breakpoint
-- Existing dates predate the immutable chain. Preserve them as a migration snapshot,
-- but label them explicitly so reporting never mistakes them for original promises.
INSERT INTO "po_promise_revisions" (
	"po_id", "po_line_id", "sequence", "previous_date", "promised_date",
	"source", "actor_type", "reason", "idempotency_key", "occurred_at"
)
SELECT
	p."id",
	l."id",
	1,
	NULL,
	COALESCE(l."expected_date", p."expected_date"),
	'legacy_backfill',
	'system_backfill',
	'迁移时保留的当前承诺快照，不代表原始承诺',
	'legacy:po-line:' || l."id"::text,
	COALESCE(p."confirmed_at", p."updated_at", p."created_at")
FROM "po_lines" l
INNER JOIN "po_docs" p ON p."id" = l."po_id"
WHERE COALESCE(l."expected_date", p."expected_date") IS NOT NULL
ON CONFLICT ("idempotency_key") DO NOTHING;--> statement-breakpoint
CREATE TRIGGER po_promise_revisions_append_only
BEFORE UPDATE OR DELETE ON po_promise_revisions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();--> statement-breakpoint
CREATE TRIGGER po_promise_revisions_append_only_truncate
BEFORE TRUNCATE ON po_promise_revisions
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();
