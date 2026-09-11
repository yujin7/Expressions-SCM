CREATE TABLE "ops_demand_dispositions" (
	"id" serial PRIMARY KEY NOT NULL,
	"submission_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"channel_id" integer,
	"period" text NOT NULL,
	"decision" text NOT NULL,
	"agreed_qty" numeric(14, 4),
	"reason" text,
	"decided_by" integer NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_ops_demand_disposition_submission" UNIQUE("submission_id"),
	CONSTRAINT "ck_ops_demand_disposition_decision" CHECK ("ops_demand_dispositions"."decision" IN ('accepted', 'rejected')),
	CONSTRAINT "ck_ops_demand_disposition_accepted_qty" CHECK ("ops_demand_dispositions"."decision" <> 'accepted' OR "ops_demand_dispositions"."agreed_qty" IS NOT NULL),
	CONSTRAINT "ck_ops_demand_disposition_rejected_reason" CHECK ("ops_demand_dispositions"."decision" <> 'rejected' OR ("ops_demand_dispositions"."reason" IS NOT NULL AND length(btrim("ops_demand_dispositions"."reason")) >= 5))
);
--> statement-breakpoint
CREATE TABLE "replenish_suppressions" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"reason_code" text NOT NULL,
	"reason" text NOT NULL,
	"business_date" date NOT NULL,
	"until_date" date NOT NULL,
	"release_on_arrival" boolean DEFAULT false NOT NULL,
	"pipeline_baseline" numeric(14, 4) DEFAULT '0' NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_by" integer,
	"cleared_at" timestamp with time zone,
	"clear_note" text,
	CONSTRAINT "ck_replenish_suppression_window" CHECK ("replenish_suppressions"."until_date" >= "replenish_suppressions"."business_date")
);
--> statement-breakpoint
ALTER TABLE "ops_demand_dispositions" ADD CONSTRAINT "ops_demand_dispositions_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_demand_dispositions" ADD CONSTRAINT "ops_demand_dispositions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replenish_suppressions" ADD CONSTRAINT "replenish_suppressions_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replenish_suppressions" ADD CONSTRAINT "replenish_suppressions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replenish_suppressions" ADD CONSTRAINT "replenish_suppressions_cleared_by_users_id_fk" FOREIGN KEY ("cleared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_ops_demand_disposition_period" ON "ops_demand_dispositions" USING btree ("period");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_replenish_suppression_active" ON "replenish_suppressions" USING btree ("sku_id") WHERE "replenish_suppressions"."cleared_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_replenish_suppression_until" ON "replenish_suppressions" USING btree ("until_date");