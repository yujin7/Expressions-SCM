CREATE TABLE "data_product_outcome_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"contract_version" text NOT NULL,
	"release_id" integer NOT NULL,
	"source_evidence_digest" text NOT NULL,
	"decision_ref" text NOT NULL,
	"business_date" date NOT NULL,
	"decision" text NOT NULL,
	"result" text NOT NULL,
	"handling_minutes" integer,
	"saved_hours" numeric(12, 2),
	"cash_impact" numeric(18, 2),
	"currency" text,
	"reason_code" text,
	"evidence_ref" text,
	"note" text NOT NULL,
	"supersedes_id" integer,
	"idempotency_key" text NOT NULL,
	"recorded_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_product_outcome_events_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ck_data_product_outcome_decision" CHECK ("data_product_outcome_events"."decision" IN ('accepted', 'modified', 'rejected', 'deferred')),
	CONSTRAINT "ck_data_product_outcome_result" CHECK ("data_product_outcome_events"."result" IN ('pending', 'positive', 'neutral', 'negative', 'false_positive')),
	CONSTRAINT "ck_data_product_outcome_handling" CHECK ("data_product_outcome_events"."handling_minutes" IS NULL OR ("data_product_outcome_events"."handling_minutes" >= 0 AND "data_product_outcome_events"."handling_minutes" <= 525600)),
	CONSTRAINT "ck_data_product_outcome_saved_hours" CHECK ("data_product_outcome_events"."saved_hours" IS NULL OR "data_product_outcome_events"."saved_hours" >= 0),
	CONSTRAINT "ck_data_product_outcome_currency" CHECK (("data_product_outcome_events"."cash_impact" IS NULL AND "data_product_outcome_events"."currency" IS NULL) OR ("data_product_outcome_events"."cash_impact" IS NOT NULL AND "data_product_outcome_events"."currency" = 'CNY')),
	CONSTRAINT "ck_data_product_outcome_reason" CHECK ("data_product_outcome_events"."reason_code" IS NULL OR "data_product_outcome_events"."reason_code" IN ('data_quality', 'identity_gap', 'timing', 'business_constraint', 'duplicate', 'low_confidence', 'other')),
	CONSTRAINT "ck_data_product_outcome_reason_required" CHECK ("data_product_outcome_events"."decision" NOT IN ('modified', 'rejected') AND "data_product_outcome_events"."result" NOT IN ('negative', 'false_positive') OR "data_product_outcome_events"."reason_code" IS NOT NULL),
	CONSTRAINT "ck_data_product_outcome_evidence_required" CHECK ("data_product_outcome_events"."result" = 'pending' OR "data_product_outcome_events"."evidence_ref" IS NOT NULL),
	CONSTRAINT "ck_data_product_outcome_no_self_supersede" CHECK ("data_product_outcome_events"."supersedes_id" IS NULL OR "data_product_outcome_events"."supersedes_id" <> "data_product_outcome_events"."id")
);
--> statement-breakpoint
ALTER TABLE "data_product_outcome_events" ADD CONSTRAINT "data_product_outcome_events_release_id_data_product_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."data_product_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_product_outcome_events" ADD CONSTRAINT "data_product_outcome_events_supersedes_id_data_product_outcome_events_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."data_product_outcome_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_product_outcome_events" ADD CONSTRAINT "data_product_outcome_events_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_data_product_outcome_product_date" ON "data_product_outcome_events" USING btree ("product_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_data_product_outcome_root" ON "data_product_outcome_events" USING btree ("product_id","decision_ref") WHERE "data_product_outcome_events"."supersedes_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_data_product_outcome_supersedes" ON "data_product_outcome_events" USING btree ("supersedes_id") WHERE "data_product_outcome_events"."supersedes_id" IS NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_data_product_outcome_chain()
RETURNS trigger AS $$
DECLARE
  previous data_product_outcome_events%ROWTYPE;
  product_release data_product_releases%ROWTYPE;
BEGIN
  SELECT * INTO product_release
    FROM data_product_releases
   WHERE id = NEW.release_id;
  IF NOT FOUND
     OR product_release.product_id <> NEW.product_id
     OR product_release.contract_version <> NEW.contract_version
     OR product_release.source_evidence_digest <> NEW.source_evidence_digest THEN
    RAISE EXCEPTION 'data product outcome must retain its release, contract, and evidence identity';
  END IF;
  IF NEW.business_date < (product_release.decided_at AT TIME ZONE 'Asia/Shanghai')::date THEN
    RAISE EXCEPTION 'data product outcome business date cannot predate release';
  END IF;
  IF NEW.business_date > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date THEN
    RAISE EXCEPTION 'data product outcome business date cannot be in the future';
  END IF;
  IF NEW.supersedes_id IS NULL AND product_release.status <> 'approved' THEN
    RAISE EXCEPTION 'new data product outcome requires an approved release';
  END IF;

  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO previous
      FROM data_product_outcome_events
     WHERE id = NEW.supersedes_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'superseded data product outcome does not exist';
    END IF;
    IF previous.product_id <> NEW.product_id
       OR previous.decision_ref <> NEW.decision_ref
       OR previous.contract_version <> NEW.contract_version
       OR previous.release_id <> NEW.release_id
       OR previous.source_evidence_digest <> NEW.source_evidence_digest THEN
      RAISE EXCEPTION 'data product outcome correction must retain product, decision, release, contract, and evidence identity';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER data_product_outcome_chain_identity
BEFORE INSERT ON data_product_outcome_events
FOR EACH ROW EXECUTE FUNCTION validate_data_product_outcome_chain();--> statement-breakpoint

CREATE TRIGGER data_product_outcomes_append_only
BEFORE UPDATE OR DELETE ON data_product_outcome_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();--> statement-breakpoint

CREATE TRIGGER data_product_outcomes_append_only_truncate
BEFORE TRUNCATE ON data_product_outcome_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();
