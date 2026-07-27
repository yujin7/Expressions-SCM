CREATE TABLE "sop_cycles" (
	"id" serial PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'consensus' NOT NULL,
	"planning_version_id" integer NOT NULL,
	"plan_digest" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"frozen_by" integer,
	"frozen_at" timestamp with time zone,
	"executing_by" integer,
	"executing_at" timestamp with time zone,
	"closed_by" integer,
	"closed_at" timestamp with time zone,
	CONSTRAINT "uq_sop_cycle_month" UNIQUE("month"),
	CONSTRAINT "uq_sop_cycle_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "ck_sop_cycle_month" CHECK ("sop_cycles"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "ck_sop_cycle_status" CHECK ("sop_cycles"."status" IN ('consensus', 'frozen', 'executing', 'closed')),
	CONSTRAINT "ck_sop_cycle_version" CHECK ("sop_cycles"."version" > 0),
	CONSTRAINT "ck_sop_cycle_lifecycle" CHECK (("sop_cycles"."status" = 'consensus' AND "sop_cycles"."frozen_by" IS NULL AND "sop_cycles"."frozen_at" IS NULL AND "sop_cycles"."executing_by" IS NULL AND "sop_cycles"."executing_at" IS NULL AND "sop_cycles"."closed_by" IS NULL AND "sop_cycles"."closed_at" IS NULL)
      OR ("sop_cycles"."status" = 'frozen' AND "sop_cycles"."frozen_by" IS NOT NULL AND "sop_cycles"."frozen_at" IS NOT NULL AND "sop_cycles"."executing_by" IS NULL AND "sop_cycles"."executing_at" IS NULL AND "sop_cycles"."closed_by" IS NULL AND "sop_cycles"."closed_at" IS NULL)
      OR ("sop_cycles"."status" = 'executing' AND "sop_cycles"."frozen_by" IS NOT NULL AND "sop_cycles"."frozen_at" IS NOT NULL AND "sop_cycles"."executing_by" IS NOT NULL AND "sop_cycles"."executing_at" IS NOT NULL AND "sop_cycles"."closed_by" IS NULL AND "sop_cycles"."closed_at" IS NULL)
      OR ("sop_cycles"."status" = 'closed' AND "sop_cycles"."frozen_by" IS NOT NULL AND "sop_cycles"."frozen_at" IS NOT NULL AND "sop_cycles"."executing_by" IS NOT NULL AND "sop_cycles"."executing_at" IS NOT NULL AND "sop_cycles"."closed_by" IS NOT NULL AND "sop_cycles"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "sop_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"cycle_id" integer NOT NULL,
	"cycle_version" integer NOT NULL,
	"role" text NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"plan_digest" text NOT NULL,
	"decided_by" integer NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_sop_decision_round" CHECK ("sop_decisions"."cycle_version" > 0),
	CONSTRAINT "ck_sop_decision_role" CHECK ("sop_decisions"."role" IN ('ops', 'pmc', 'finance')),
	CONSTRAINT "ck_sop_decision_value" CHECK ("sop_decisions"."decision" IN ('agree', 'reject')),
	CONSTRAINT "ck_sop_reject_note" CHECK ("sop_decisions"."decision" <> 'reject' OR length(trim(coalesce("sop_decisions"."note", ''))) >= 5)
);
--> statement-breakpoint
ALTER TABLE "sop_cycles" ADD CONSTRAINT "sop_cycles_planning_version_id_planning_versions_id_fk" FOREIGN KEY ("planning_version_id") REFERENCES "public"."planning_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_cycles" ADD CONSTRAINT "sop_cycles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_cycles" ADD CONSTRAINT "sop_cycles_frozen_by_users_id_fk" FOREIGN KEY ("frozen_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_cycles" ADD CONSTRAINT "sop_cycles_executing_by_users_id_fk" FOREIGN KEY ("executing_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_cycles" ADD CONSTRAINT "sop_cycles_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_decisions" ADD CONSTRAINT "sop_decisions_cycle_id_sop_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."sop_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_decisions" ADD CONSTRAINT "sop_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_sop_cycle_status_month" ON "sop_cycles" USING btree ("status","month");--> statement-breakpoint
CREATE INDEX "ix_sop_decision_cycle_round" ON "sop_decisions" USING btree ("cycle_id","cycle_version","role","id");--> statement-breakpoint
CREATE TRIGGER sop_decisions_append_only
BEFORE UPDATE OR DELETE ON sop_decisions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();--> statement-breakpoint
CREATE TRIGGER sop_decisions_append_only_truncate
BEFORE TRUNCATE ON sop_decisions
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();
