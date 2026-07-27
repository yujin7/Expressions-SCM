CREATE TABLE "projection_scenarios" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"name" text NOT NULL,
	"horizon_days" integer NOT NULL,
	"inputs" jsonb NOT NULL,
	"baseline_result" jsonb NOT NULL,
	"scenario_result" jsonb NOT NULL,
	"source_date" date NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_projection_scenario_idempotency" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "projection_scenarios" ADD CONSTRAINT "projection_scenarios_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projection_scenarios" ADD CONSTRAINT "projection_scenarios_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_projection_scenario_sku_created" ON "projection_scenarios" USING btree ("sku_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_projection_scenario_creator_created" ON "projection_scenarios" USING btree ("created_by","created_at");--> statement-breakpoint
-- Saved what-if comparisons are decision evidence. A revised assumption creates
-- a new scenario; historical inputs and outputs must not be rewritten.
CREATE TRIGGER projection_scenarios_append_only
BEFORE UPDATE OR DELETE ON projection_scenarios
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER projection_scenarios_append_only_truncate
BEFORE TRUNCATE ON projection_scenarios
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();
