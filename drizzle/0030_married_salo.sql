CREATE TABLE "supply_demand_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"version_id" integer NOT NULL,
	"planning_line_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"demand_type" text NOT NULL,
	"demand_date" date NOT NULL,
	"demand_qty" numeric(14, 4) NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text,
	"source_doc_id" integer,
	"source_line_id" integer,
	"supply_date" date,
	"available_qty" numeric(14, 4) NOT NULL,
	"pegged_qty" numeric(14, 4) NOT NULL,
	"confidence" text NOT NULL,
	"status" text NOT NULL,
	"sequence" integer NOT NULL,
	"explanation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_supply_demand_link_sequence" UNIQUE("planning_line_id","sequence"),
	CONSTRAINT "ck_supply_demand_positive_demand" CHECK ("supply_demand_links"."demand_qty" > 0),
	CONSTRAINT "ck_supply_demand_positive_available" CHECK ("supply_demand_links"."available_qty" > 0),
	CONSTRAINT "ck_supply_demand_pegged_range" CHECK ("supply_demand_links"."pegged_qty" >= 0 AND "supply_demand_links"."pegged_qty" <= "supply_demand_links"."available_qty"),
	CONSTRAINT "ck_supply_demand_sequence" CHECK ("supply_demand_links"."sequence" >= 0),
	CONSTRAINT "ck_supply_demand_confidence" CHECK ("supply_demand_links"."confidence" IN ('booked', 'reference', 'proposed', 'suppressed')),
	CONSTRAINT "ck_supply_demand_status" CHECK ("supply_demand_links"."status" IN ('pegged', 'partial', 'excess', 'excluded_undated', 'excluded_late', 'suppressed'))
);
--> statement-breakpoint
ALTER TABLE "planning_version_lines" ADD COLUMN "envelope_version" text DEFAULT 'decision-envelope/v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "planning_version_lines" ADD COLUMN "decision_envelope" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "planning_version_lines" ADD COLUMN "evidence_digest" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "supply_demand_links" ADD CONSTRAINT "supply_demand_links_version_id_planning_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."planning_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_demand_links" ADD CONSTRAINT "supply_demand_links_planning_line_id_planning_version_lines_id_fk" FOREIGN KEY ("planning_line_id") REFERENCES "public"."planning_version_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_demand_links" ADD CONSTRAINT "supply_demand_links_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_supply_demand_version_sku" ON "supply_demand_links" USING btree ("version_id","sku_id");--> statement-breakpoint
CREATE INDEX "ix_supply_demand_source" ON "supply_demand_links" USING btree ("source_type","source_ref");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_supply_demand_link_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM planning_version_lines
     WHERE id = NEW.planning_line_id
       AND version_id = NEW.version_id
       AND sku_id = NEW.sku_id
  ) THEN
    RAISE EXCEPTION 'supply_demand_links version/line/SKU identity mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER supply_demand_link_identity
BEFORE INSERT ON supply_demand_links
FOR EACH ROW EXECUTE FUNCTION validate_supply_demand_link_identity();
--> statement-breakpoint
CREATE TRIGGER supply_demand_links_append_only
BEFORE UPDATE OR DELETE ON supply_demand_links
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER supply_demand_links_append_only_truncate
BEFORE TRUNCATE ON supply_demand_links
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();
