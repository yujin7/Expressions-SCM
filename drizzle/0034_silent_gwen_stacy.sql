CREATE TABLE "electronic_label_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"label_key" text NOT NULL,
	"sku_id" integer NOT NULL,
	"market_code" text NOT NULL,
	"locale" text DEFAULT 'zh-CN' NOT NULL,
	"regulatory_record_id" integer NOT NULL,
	"version" integer NOT NULL,
	"previous_id" integer,
	"public_token" text NOT NULL,
	"content" jsonb NOT NULL,
	"content_digest" text NOT NULL,
	"effective_date" date NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "electronic_label_versions_public_token_unique" UNIQUE("public_token"),
	CONSTRAINT "electronic_label_versions_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "uq_electronic_label_version" UNIQUE("label_key","version"),
	CONSTRAINT "ck_electronic_label_market" CHECK ("electronic_label_versions"."market_code" ~ '^[A-Z]{2,8}$'),
	CONSTRAINT "ck_electronic_label_locale" CHECK ("electronic_label_versions"."locale" ~ '^[a-z]{2}(-[A-Z]{2})?$'),
	CONSTRAINT "ck_electronic_label_version" CHECK ("electronic_label_versions"."version" > 0),
	CONSTRAINT "ck_electronic_label_previous" CHECK (("electronic_label_versions"."version" = 1 AND "electronic_label_versions"."previous_id" IS NULL) OR ("electronic_label_versions"."version" > 1 AND "electronic_label_versions"."previous_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "quality_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"owner_id" integer NOT NULL,
	"due_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"target_type" text,
	"target_ref" text,
	"quantity" numeric(14, 4),
	"outcome" text,
	"evidence_ref" text,
	"verification_note" text,
	"idempotency_key" text NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_by" integer,
	"completed_at" timestamp with time zone,
	"verified_by" integer,
	"verified_at" timestamp with time zone,
	CONSTRAINT "quality_actions_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ck_quality_action_kind" CHECK ("quality_actions"."kind" IN ('containment', 'corrective', 'preventive', 'effectiveness',
      'notification', 'reconciliation', 'finding', 'follow_up')),
	CONSTRAINT "ck_quality_action_status" CHECK ("quality_actions"."status" IN ('open', 'completed', 'verified', 'ineffective', 'waived')),
	CONSTRAINT "ck_quality_action_completion" CHECK (("quality_actions"."status" = 'open'
        AND "quality_actions"."completed_by" IS NULL AND "quality_actions"."completed_at" IS NULL
        AND "quality_actions"."evidence_ref" IS NULL AND "quality_actions"."outcome" IS NULL)
      OR ("quality_actions"."status" <> 'open'
        AND "quality_actions"."completed_by" IS NOT NULL AND "quality_actions"."completed_at" IS NOT NULL
        AND length(trim(coalesce("quality_actions"."evidence_ref", ''))) >= 3
        AND length(trim(coalesce("quality_actions"."outcome", ''))) >= 3)),
	CONSTRAINT "ck_quality_action_verification" CHECK (("quality_actions"."status" IN ('open', 'completed')
        AND "quality_actions"."verified_by" IS NULL AND "quality_actions"."verified_at" IS NULL
        AND "quality_actions"."verification_note" IS NULL)
      OR ("quality_actions"."status" IN ('verified', 'ineffective', 'waived')
        AND "quality_actions"."verified_by" IS NOT NULL AND "quality_actions"."verified_at" IS NOT NULL
        AND length(trim(coalesce("quality_actions"."verification_note", ''))) >= 5)),
	CONSTRAINT "ck_quality_action_sod" CHECK ("quality_actions"."verified_by" IS NULL OR "quality_actions"."completed_by" IS NULL OR "quality_actions"."verified_by" <> "quality_actions"."completed_by"),
	CONSTRAINT "ck_quality_action_waiver" CHECK ("quality_actions"."status" <> 'waived' OR length(trim(coalesce("quality_actions"."verification_note", ''))) >= 5),
	CONSTRAINT "ck_quality_action_qty" CHECK ("quality_actions"."quantity" IS NULL OR "quality_actions"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quality_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_no" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"market_code" text DEFAULT 'CN' NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"source_channel" text DEFAULT 'internal' NOT NULL,
	"external_ref" text,
	"sku_id" integer,
	"batch_id" integer,
	"supplier_id" integer,
	"warehouse_id" integer,
	"owner_id" integer NOT NULL,
	"received_date" date NOT NULL,
	"occurred_date" date,
	"assessment" text DEFAULT 'unassessed' NOT NULL,
	"assessment_basis" text,
	"report_policy" text,
	"report_due_date" date,
	"reported_at" timestamp with time zone,
	"regulator_ref" text,
	"retention_until" date,
	"root_cause" text,
	"scope_snapshot" jsonb,
	"scope_digest" text,
	"scope_frozen_at" timestamp with time zone,
	"inspection_year" integer,
	"inspection_site" text,
	"inspection_site_key" text,
	"inspection_report_ref" text,
	"inspection_report_date" date,
	"idempotency_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" integer,
	"closed_at" timestamp with time zone,
	"closure_note" text,
	CONSTRAINT "quality_cases_case_no_unique" UNIQUE("case_no"),
	CONSTRAINT "quality_cases_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ck_quality_case_kind" CHECK ("quality_cases"."kind" IN ('complaint', 'adverse_event', 'recall', 'self_inspection')),
	CONSTRAINT "ck_quality_case_status" CHECK ("quality_cases"."status" IN ('open', 'triaged', 'scoped', 'active', 'closed')),
	CONSTRAINT "ck_quality_case_severity" CHECK ("quality_cases"."severity" IN ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "ck_quality_case_market" CHECK ("quality_cases"."market_code" ~ '^[A-Z]{2,8}$'),
	CONSTRAINT "ck_quality_case_source" CHECK ("quality_cases"."source_channel" IN ('consumer', 'marketplace', 'retailer', 'internal', 'supplier', 'regulator', 'other')),
	CONSTRAINT "ck_quality_case_assessment" CHECK ("quality_cases"."assessment" IN ('unassessed', 'non_serious', 'serious_not_reportable', 'serious_reportable')),
	CONSTRAINT "ck_quality_case_reportable_fields" CHECK ("quality_cases"."assessment" <> 'serious_reportable'
      OR ("quality_cases"."kind" = 'adverse_event' AND "quality_cases"."report_policy" IS NOT NULL
        AND "quality_cases"."report_due_date" IS NOT NULL AND "quality_cases"."retention_until" IS NOT NULL
        AND length(trim(coalesce("quality_cases"."assessment_basis", ''))) >= 5)),
	CONSTRAINT "ck_quality_case_reported" CHECK ("quality_cases"."reported_at" IS NULL OR ("quality_cases"."assessment" = 'serious_reportable'
      AND length(trim(coalesce("quality_cases"."regulator_ref", ''))) >= 3)),
	CONSTRAINT "ck_quality_case_recall_anchor" CHECK ("quality_cases"."kind" <> 'recall' OR "quality_cases"."batch_id" IS NOT NULL),
	CONSTRAINT "ck_quality_case_recall_scope" CHECK ("quality_cases"."kind" <> 'recall' OR "quality_cases"."status" = 'open'
      OR ("quality_cases"."scope_snapshot" IS NOT NULL AND "quality_cases"."scope_digest" IS NOT NULL
        AND "quality_cases"."scope_frozen_at" IS NOT NULL)),
	CONSTRAINT "ck_quality_case_self_inspection" CHECK ("quality_cases"."kind" <> 'self_inspection'
      OR ("quality_cases"."inspection_year" IS NOT NULL AND "quality_cases"."inspection_year" >= 2020
        AND length(trim(coalesce("quality_cases"."inspection_site", ''))) >= 2
        AND "quality_cases"."inspection_site_key" = upper(regexp_replace(trim("quality_cases"."inspection_site"), '\s+', ' ', 'g')))),
	CONSTRAINT "ck_quality_case_non_inspection_fields" CHECK ("quality_cases"."kind" = 'self_inspection'
      OR ("quality_cases"."inspection_year" IS NULL AND "quality_cases"."inspection_site" IS NULL
        AND "quality_cases"."inspection_site_key" IS NULL AND "quality_cases"."inspection_report_ref" IS NULL
        AND "quality_cases"."inspection_report_date" IS NULL)),
	CONSTRAINT "ck_quality_case_self_inspection_report" CHECK ("quality_cases"."kind" <> 'self_inspection'
      OR (("quality_cases"."inspection_report_ref" IS NULL AND "quality_cases"."inspection_report_date" IS NULL)
        OR ("quality_cases"."inspection_report_ref" IS NOT NULL AND "quality_cases"."inspection_report_date" IS NOT NULL
          AND "quality_cases"."retention_until" IS NOT NULL))),
	CONSTRAINT "ck_quality_case_close" CHECK (("quality_cases"."status" <> 'closed' AND "quality_cases"."closed_by" IS NULL AND "quality_cases"."closed_at" IS NULL AND "quality_cases"."closure_note" IS NULL)
      OR ("quality_cases"."status" = 'closed' AND "quality_cases"."closed_by" IS NOT NULL AND "quality_cases"."closed_at" IS NOT NULL
        AND length(trim(coalesce("quality_cases"."closure_note", ''))) >= 5)),
	CONSTRAINT "ck_quality_case_version" CHECK ("quality_cases"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "regulatory_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"record_key" text NOT NULL,
	"record_type" text NOT NULL,
	"market_code" text NOT NULL,
	"sku_id" integer,
	"supplier_id" integer,
	"title" text NOT NULL,
	"authority" text NOT NULL,
	"reference_no" text,
	"status" text NOT NULL,
	"effective_date" date,
	"expiry_date" date,
	"renewal_due_date" date,
	"retention_until" date,
	"payload" jsonb NOT NULL,
	"payload_digest" text NOT NULL,
	"version" integer NOT NULL,
	"previous_id" integer,
	"evidence_ref" text,
	"idempotency_key" text NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regulatory_records_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "uq_regulatory_record_version" UNIQUE("record_key","version"),
	CONSTRAINT "ck_regulatory_type" CHECK ("regulatory_records"."record_type" IN ('nmpa_filing', 'nmpa_registration', 'fda_facility',
      'fda_product_listing', 'eu_pif', 'eu_cpnp', 'safety_assessment', 'other')),
	CONSTRAINT "ck_regulatory_status" CHECK ("regulatory_records"."status" IN ('submitted', 'active', 'rejected', 'expired', 'superseded')),
	CONSTRAINT "ck_regulatory_market" CHECK ("regulatory_records"."market_code" ~ '^[A-Z]{2,8}$'),
	CONSTRAINT "ck_regulatory_version" CHECK ("regulatory_records"."version" > 0),
	CONSTRAINT "ck_regulatory_previous" CHECK (("regulatory_records"."version" = 1 AND "regulatory_records"."previous_id" IS NULL) OR ("regulatory_records"."version" > 1 AND "regulatory_records"."previous_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "electronic_label_versions" ADD CONSTRAINT "electronic_label_versions_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "electronic_label_versions" ADD CONSTRAINT "electronic_label_versions_regulatory_record_id_regulatory_records_id_fk" FOREIGN KEY ("regulatory_record_id") REFERENCES "public"."regulatory_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "electronic_label_versions" ADD CONSTRAINT "electronic_label_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_actions" ADD CONSTRAINT "quality_actions_case_id_quality_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."quality_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_actions" ADD CONSTRAINT "quality_actions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_actions" ADD CONSTRAINT "quality_actions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_actions" ADD CONSTRAINT "quality_actions_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_actions" ADD CONSTRAINT "quality_actions_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_cases" ADD CONSTRAINT "quality_cases_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_cases" ADD CONSTRAINT "quality_cases_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_cases" ADD CONSTRAINT "quality_cases_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_cases" ADD CONSTRAINT "quality_cases_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_cases" ADD CONSTRAINT "quality_cases_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_cases" ADD CONSTRAINT "quality_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_cases" ADD CONSTRAINT "quality_cases_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulatory_records" ADD CONSTRAINT "regulatory_records_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulatory_records" ADD CONSTRAINT "regulatory_records_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulatory_records" ADD CONSTRAINT "regulatory_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulatory_records" ADD CONSTRAINT "regulatory_records_previous_id_regulatory_records_id_fk" FOREIGN KEY ("previous_id") REFERENCES "public"."regulatory_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "electronic_label_versions" ADD CONSTRAINT "electronic_label_versions_previous_id_electronic_label_versions_id_fk" FOREIGN KEY ("previous_id") REFERENCES "public"."electronic_label_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_electronic_label_sku_market" ON "electronic_label_versions" USING btree ("sku_id","market_code","locale","created_at");--> statement-breakpoint
CREATE INDEX "ix_quality_action_case_status" ON "quality_actions" USING btree ("case_id","status","due_date");--> statement-breakpoint
CREATE INDEX "ix_quality_action_owner_due" ON "quality_actions" USING btree ("owner_id","status","due_date");--> statement-breakpoint
CREATE INDEX "ix_quality_case_kind_status" ON "quality_cases" USING btree ("kind","status","created_at");--> statement-breakpoint
CREATE INDEX "ix_quality_case_owner_due" ON "quality_cases" USING btree ("owner_id","report_due_date");--> statement-breakpoint
CREATE INDEX "ix_quality_case_sku_batch" ON "quality_cases" USING btree ("sku_id","batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_quality_self_inspection_site_year" ON "quality_cases" USING btree ("kind","inspection_site_key","inspection_year") WHERE "quality_cases"."kind" = 'self_inspection';--> statement-breakpoint
CREATE INDEX "ix_regulatory_market_type" ON "regulatory_records" USING btree ("market_code","record_type","created_at");--> statement-breakpoint
CREATE INDEX "ix_regulatory_expiry" ON "regulatory_records" USING btree ("expiry_date","renewal_due_date");--> statement-breakpoint
-- Regulatory dossiers and published e-labels are evidence versions. Corrections create a new
-- version; overwriting or deleting a published version would break the audit chain.
CREATE TRIGGER regulatory_records_append_only
BEFORE UPDATE OR DELETE ON regulatory_records
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();--> statement-breakpoint
CREATE TRIGGER regulatory_records_append_only_truncate
BEFORE TRUNCATE ON regulatory_records
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();--> statement-breakpoint
CREATE TRIGGER electronic_label_versions_append_only
BEFORE UPDATE OR DELETE ON electronic_label_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();--> statement-breakpoint
CREATE TRIGGER electronic_label_versions_append_only_truncate
BEFORE TRUNCATE ON electronic_label_versions
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();--> statement-breakpoint
-- Cases/actions remain stateful, but cannot be hard-deleted and a frozen recall scope cannot be
-- rewritten. Any later evidence belongs in actions or a new case, not in the original snapshot.
CREATE OR REPLACE FUNCTION reject_quality_evidence_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is retained evidence; DELETE is not allowed', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER quality_cases_no_delete
BEFORE DELETE OR TRUNCATE ON quality_cases
FOR EACH STATEMENT EXECUTE FUNCTION reject_quality_evidence_delete();--> statement-breakpoint
CREATE TRIGGER quality_actions_no_delete
BEFORE DELETE OR TRUNCATE ON quality_actions
FOR EACH STATEMENT EXECUTE FUNCTION reject_quality_evidence_delete();--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_frozen_quality_scope_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.scope_frozen_at IS NOT NULL
    AND (
      NEW.scope_snapshot IS DISTINCT FROM OLD.scope_snapshot
      OR NEW.scope_digest IS DISTINCT FROM OLD.scope_digest
      OR NEW.scope_frozen_at IS DISTINCT FROM OLD.scope_frozen_at
      OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
      OR NEW.sku_id IS DISTINCT FROM OLD.sku_id
    )
  THEN
    RAISE EXCEPTION 'quality case recall scope is frozen; create follow-up evidence instead'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER quality_cases_frozen_scope
BEFORE UPDATE ON quality_cases
FOR EACH ROW EXECUTE FUNCTION reject_frozen_quality_scope_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_quality_case_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'closed' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'closed quality case evidence is immutable; create a follow-up case instead'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.assessment <> 'unassessed'
    AND (
      NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.assessment IS DISTINCT FROM OLD.assessment
      OR NEW.assessment_basis IS DISTINCT FROM OLD.assessment_basis
      OR NEW.report_policy IS DISTINCT FROM OLD.report_policy
      OR NEW.report_due_date IS DISTINCT FROM OLD.report_due_date
      OR NEW.retention_until IS DISTINCT FROM OLD.retention_until
    )
  THEN
    RAISE EXCEPTION 'quality case assessment evidence is immutable; create a follow-up case instead'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.reported_at IS NOT NULL
    AND (
      NEW.reported_at IS DISTINCT FROM OLD.reported_at
      OR NEW.regulator_ref IS DISTINCT FROM OLD.regulator_ref
    )
  THEN
    RAISE EXCEPTION 'quality case regulatory report evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF (OLD.inspection_report_ref IS NOT NULL OR OLD.inspection_report_date IS NOT NULL)
    AND (
      NEW.inspection_report_ref IS DISTINCT FROM OLD.inspection_report_ref
      OR NEW.inspection_report_date IS DISTINCT FROM OLD.inspection_report_date
      OR NEW.retention_until IS DISTINCT FROM OLD.retention_until
    )
  THEN
    RAISE EXCEPTION 'GMP self-inspection report evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.kind = 'self_inspection'
    AND (
      NEW.inspection_year IS DISTINCT FROM OLD.inspection_year
      OR NEW.inspection_site IS DISTINCT FROM OLD.inspection_site
      OR NEW.inspection_site_key IS DISTINCT FROM OLD.inspection_site_key
    )
  THEN
    RAISE EXCEPTION 'GMP self-inspection site identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER quality_cases_evidence_immutability
BEFORE UPDATE ON quality_cases
FOR EACH ROW EXECUTE FUNCTION protect_quality_case_evidence_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_quality_action_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.kind = 'follow_up'
    AND (
      NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.case_id IS DISTINCT FROM OLD.case_id
      OR NEW.due_date IS DISTINCT FROM OLD.due_date
      OR NEW.target_type IS DISTINCT FROM OLD.target_type
      OR NEW.target_ref IS DISTINCT FROM OLD.target_ref
    )
  THEN
    RAISE EXCEPTION 'adverse-event follow-up identity and monitoring deadline are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('verified', 'ineffective', 'waived') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'verified quality action evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'open' AND NEW.status NOT IN ('open', 'completed') THEN
    RAISE EXCEPTION 'quality action must be completed before verification'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.kind = 'follow_up'
    AND OLD.status = 'open'
    AND NEW.status = 'completed'
    AND CURRENT_DATE < OLD.due_date
  THEN
    RAISE EXCEPTION 'adverse-event follow-up window is still open until %', OLD.due_date
      USING ERRCODE = '55000';
  END IF;

  IF OLD.completed_at IS NOT NULL
    AND (
      NEW.completed_by IS DISTINCT FROM OLD.completed_by
      OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
      OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref
      OR NEW.outcome IS DISTINCT FROM OLD.outcome
    )
  THEN
    RAISE EXCEPTION 'quality action completion evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.verified_at IS NOT NULL
    AND (
      NEW.status IS DISTINCT FROM OLD.status
      OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
      OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
      OR NEW.verification_note IS DISTINCT FROM OLD.verification_note
    )
  THEN
    RAISE EXCEPTION 'quality action verification evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER quality_actions_evidence_immutability
BEFORE UPDATE ON quality_actions
FOR EACH ROW EXECUTE FUNCTION protect_quality_action_evidence_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_quality_version_chain()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor_key text;
  predecessor_version integer;
  predecessor_market text;
  predecessor_type text;
  predecessor_sku_id integer;
  predecessor_supplier_id integer;
  predecessor_authority text;
  predecessor_locale text;
BEGIN
  IF NEW.version = 1 THEN
    IF NEW.previous_id IS NOT NULL THEN
      RAISE EXCEPTION '% version 1 cannot have previous_id', TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.previous_id IS NULL THEN
    RAISE EXCEPTION '% version % requires previous_id', TG_TABLE_NAME, NEW.version USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'regulatory_records' THEN
    SELECT record_key, version, market_code, record_type, sku_id, supplier_id, authority
      INTO predecessor_key, predecessor_version, predecessor_market, predecessor_type,
        predecessor_sku_id, predecessor_supplier_id, predecessor_authority
      FROM regulatory_records WHERE id = NEW.previous_id;
    IF predecessor_key IS DISTINCT FROM NEW.record_key OR predecessor_version <> NEW.version - 1 THEN
      RAISE EXCEPTION 'regulatory record predecessor must be the prior version of the same record_key'
        USING ERRCODE = '23514';
    END IF;
    IF predecessor_market IS DISTINCT FROM NEW.market_code
      OR predecessor_type IS DISTINCT FROM NEW.record_type
      OR predecessor_sku_id IS DISTINCT FROM NEW.sku_id
      OR predecessor_supplier_id IS DISTINCT FROM NEW.supplier_id
      OR upper(regexp_replace(trim(predecessor_authority), '\s+', ' ', 'g'))
        IS DISTINCT FROM upper(regexp_replace(trim(NEW.authority), '\s+', ' ', 'g'))
    THEN
      RAISE EXCEPTION 'regulatory record identity cannot change within a version chain'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT label_key, version, market_code, sku_id, locale
      INTO predecessor_key, predecessor_version, predecessor_market, predecessor_sku_id,
        predecessor_locale
      FROM electronic_label_versions WHERE id = NEW.previous_id;
    IF predecessor_key IS DISTINCT FROM NEW.label_key OR predecessor_version <> NEW.version - 1 THEN
      RAISE EXCEPTION 'electronic label predecessor must be the prior version of the same label_key'
        USING ERRCODE = '23514';
    END IF;
    IF predecessor_market IS DISTINCT FROM NEW.market_code
      OR predecessor_sku_id IS DISTINCT FROM NEW.sku_id
      OR predecessor_locale IS DISTINCT FROM NEW.locale
    THEN
      RAISE EXCEPTION 'electronic label identity cannot change within a version chain'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER regulatory_records_version_chain
BEFORE INSERT ON regulatory_records
FOR EACH ROW EXECUTE FUNCTION enforce_quality_version_chain();--> statement-breakpoint
CREATE TRIGGER electronic_label_versions_version_chain
BEFORE INSERT ON electronic_label_versions
FOR EACH ROW EXECUTE FUNCTION enforce_quality_version_chain();
