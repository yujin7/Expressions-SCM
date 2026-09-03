-- 总监需求实施计划共享基座（D50–D66，2026-09-03）：一次迁移收全部 schema 改动（D66）。
-- 注：0046 为手写迁移、无快照，drizzle-kit 本次重新生成了 report_read_model_cache 的 CREATE TABLE，
-- 已手工删除（该表在 0046 已建）；0047_snapshot.json 起快照完整。
CREATE TABLE "data_quality_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"period_kind" text NOT NULL,
	"period_key" text NOT NULL,
	"source_class" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"evidence" jsonb,
	"note" text,
	"reviewed_by" integer,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_data_quality_reviews" UNIQUE("period_kind","period_key","source_class"),
	CONSTRAINT "ck_data_quality_reviews_kind" CHECK ("data_quality_reviews"."period_kind" IN ('week', 'month')),
	CONSTRAINT "ck_data_quality_reviews_key" CHECK (("data_quality_reviews"."period_kind" = 'week' AND "data_quality_reviews"."period_key" ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$') OR ("data_quality_reviews"."period_kind" = 'month' AND "data_quality_reviews"."period_key" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')),
	CONSTRAINT "ck_data_quality_reviews_source" CHECK ("data_quality_reviews"."source_class" IN ('rpa_warehouse', 'manual_po_chain', 'external_platform')),
	CONSTRAINT "ck_data_quality_reviews_status" CHECK ("data_quality_reviews"."status" IN ('pending', 'completed', 'waived')),
	CONSTRAINT "ck_data_quality_reviews_reviewed" CHECK (("data_quality_reviews"."status" = 'pending' AND "data_quality_reviews"."reviewed_by" IS NULL AND "data_quality_reviews"."reviewed_at" IS NULL) OR ("data_quality_reviews"."status" <> 'pending' AND "data_quality_reviews"."reviewed_by" IS NOT NULL AND "data_quality_reviews"."reviewed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "department_goals" (
	"id" serial PRIMARY KEY NOT NULL,
	"dept_key" text NOT NULL,
	"period" text NOT NULL,
	"metric_key" text NOT NULL,
	"target_value" numeric(14, 4) NOT NULL,
	"direction" text NOT NULL,
	"actual_value" numeric(14, 4),
	"actual_source" text,
	"note" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_department_goals" UNIQUE("dept_key","period","metric_key"),
	CONSTRAINT "ck_department_goals_dept" CHECK ("department_goals"."dept_key" IN ('ops', 'purchasing', 'warehouse', 'quality', 'pmc', 'finance', 'admin')),
	CONSTRAINT "ck_department_goals_period" CHECK ("department_goals"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' OR "department_goals"."period" ~ '^[0-9]{4}-Q[1-4]$'),
	CONSTRAINT "ck_department_goals_direction" CHECK ("department_goals"."direction" IN ('up', 'down')),
	CONSTRAINT "ck_department_goals_actual_source" CHECK ("department_goals"."actual_source" IS NULL OR "department_goals"."actual_source" IN ('auto', 'manual')),
	CONSTRAINT "ck_department_goals_actual_pair" CHECK (("department_goals"."actual_value" IS NULL AND "department_goals"."actual_source" IS NULL) OR ("department_goals"."actual_value" IS NOT NULL AND "department_goals"."actual_source" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ops_demand_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"channel_id" integer,
	"period" text NOT NULL,
	"qty" numeric(14, 4) NOT NULL,
	"basis" text,
	"submitted_by" integer NOT NULL,
	"supersedes_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_ops_demand_submissions_supersedes" UNIQUE("supersedes_id"),
	CONSTRAINT "ck_ops_demand_submissions_period" CHECK ("ops_demand_submissions"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "ck_ops_demand_submissions_qty" CHECK ("ops_demand_submissions"."qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ops_plan_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer,
	"spu_id" integer,
	"channel_id" integer,
	"kind" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"expected_uplift_pct" integer,
	"note" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_ops_plan_events_target" CHECK ("ops_plan_events"."sku_id" IS NOT NULL OR "ops_plan_events"."spu_id" IS NOT NULL),
	CONSTRAINT "ck_ops_plan_events_kind" CHECK ("ops_plan_events"."kind" IN ('promo', 'launch', 'delist', 'relink', 'price', 'other')),
	CONSTRAINT "ck_ops_plan_events_window" CHECK ("ops_plan_events"."end_date" IS NULL OR "ops_plan_events"."end_date" >= "ops_plan_events"."start_date"),
	CONSTRAINT "ck_ops_plan_events_uplift" CHECK ("ops_plan_events"."expected_uplift_pct" IS NULL OR ("ops_plan_events"."expected_uplift_pct" >= -100 AND "ops_plan_events"."expected_uplift_pct" <= 1000))
);
--> statement-breakpoint
CREATE TABLE "sales_amount_monthly" (
	"id" serial PRIMARY KEY NOT NULL,
	"year_month" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" integer,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"note" text,
	"supersedes_id" integer,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_sales_amount_monthly_supersedes" UNIQUE("supersedes_id"),
	CONSTRAINT "ck_sales_amount_monthly_ym" CHECK ("sales_amount_monthly"."year_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "ck_sales_amount_monthly_scope_kind" CHECK ("sales_amount_monthly"."scope_kind" IN ('company', 'brand', 'channel')),
	CONSTRAINT "ck_sales_amount_monthly_scope_id" CHECK (("sales_amount_monthly"."scope_kind" = 'company' AND "sales_amount_monthly"."scope_id" IS NULL) OR ("sales_amount_monthly"."scope_kind" <> 'company' AND "sales_amount_monthly"."scope_id" IS NOT NULL)),
	CONSTRAINT "ck_sales_amount_monthly_source" CHECK ("sales_amount_monthly"."source" IN ('manual', 'prefill_observation'))
);
--> statement-breakpoint
CREATE TABLE "sku_planning_policy" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"period" text NOT NULL,
	"tier" text NOT NULL,
	"abc" text NOT NULL,
	"xyz" text,
	"ownership" text NOT NULL,
	"pilot" boolean DEFAULT false NOT NULL,
	"override_tier" text,
	"override_by" integer,
	"override_note" text,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_sku_planning_policy_period" UNIQUE("sku_id","period"),
	CONSTRAINT "ck_sku_planning_policy_period" CHECK ("sku_planning_policy"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "ck_sku_planning_policy_tier" CHECK ("sku_planning_policy"."tier" IN ('S', 'A', 'B', 'C')),
	CONSTRAINT "ck_sku_planning_policy_abc" CHECK ("sku_planning_policy"."abc" IN ('A', 'B', 'C')),
	CONSTRAINT "ck_sku_planning_policy_xyz" CHECK ("sku_planning_policy"."xyz" IS NULL OR "sku_planning_policy"."xyz" IN ('X', 'Y', 'Z')),
	CONSTRAINT "ck_sku_planning_policy_ownership" CHECK ("sku_planning_policy"."ownership" IN ('supply_chain_direct', 'joint_review', 'ops_fallback')),
	CONSTRAINT "ck_sku_planning_policy_override_tier" CHECK ("sku_planning_policy"."override_tier" IS NULL OR "sku_planning_policy"."override_tier" IN ('S', 'A', 'B', 'C')),
	CONSTRAINT "ck_sku_planning_policy_override_pair" CHECK (("sku_planning_policy"."override_tier" IS NULL AND "sku_planning_policy"."override_by" IS NULL) OR ("sku_planning_policy"."override_tier" IS NOT NULL AND "sku_planning_policy"."override_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "transfer_fees" (
	"id" serial PRIMARY KEY NOT NULL,
	"stock_doc_id" integer NOT NULL,
	"fee_type" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"carrier" text,
	"biz_date" date NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"note" text,
	"reversal_of_id" integer,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_transfer_fees_reversal_of" UNIQUE("reversal_of_id"),
	CONSTRAINT "ck_transfer_fees_type" CHECK ("transfer_fees"."fee_type" IN ('freight', 'handling', 'customs', 'other')),
	CONSTRAINT "ck_transfer_fees_source" CHECK ("transfer_fees"."source" IN ('manual', 'import')),
	CONSTRAINT "ck_transfer_fees_sign" CHECK (("transfer_fees"."reversal_of_id" IS NULL AND "transfer_fees"."amount" >= 0) OR ("transfer_fees"."reversal_of_id" IS NOT NULL AND "transfer_fees"."amount" < 0))
);
--> statement-breakpoint
CREATE TABLE "user_data_scopes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"scope_kind" text NOT NULL,
	"target_id" integer NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_user_data_scopes" UNIQUE("user_id","scope_kind","target_id"),
	CONSTRAINT "ck_user_data_scopes_kind" CHECK ("user_data_scopes"."scope_kind" IN ('channel', 'dept'))
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"assignee_id" integer NOT NULL,
	"assigner_id" integer NOT NULL,
	"owner_role" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"due_date" date,
	"status" text DEFAULT 'open' NOT NULL,
	"source_kind" text,
	"source_ref" text,
	"completed_at" timestamp with time zone,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_work_items_priority" CHECK ("work_items"."priority" IN ('low', 'normal', 'high')),
	CONSTRAINT "ck_work_items_status" CHECK ("work_items"."status" IN ('open', 'in_progress', 'done', 'cancelled')),
	CONSTRAINT "ck_work_items_source_kind" CHECK ("work_items"."source_kind" IS NULL OR "work_items"."source_kind" IN ('alert', 'manual', 'review')),
	CONSTRAINT "ck_work_items_owner_role" CHECK ("work_items"."owner_role" IS NULL OR "work_items"."owner_role" IN ('ops', 'purchasing', 'warehouse', 'quality', 'pmc', 'finance', 'admin')),
	CONSTRAINT "ck_work_items_completed" CHECK (("work_items"."status" = 'done') = ("work_items"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "payment_term_type" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "credit_days" integer;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "payment_term_effective_from" date;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "declared_monthly_capacity" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "capacity_uom" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "surge_capacity_pct" integer;--> statement-breakpoint
ALTER TABLE "stock_docs" ADD COLUMN "transfer_type" text;--> statement-breakpoint
ALTER TABLE "sku_params" ADD COLUMN "purchase_lead_days" integer;--> statement-breakpoint
ALTER TABLE "data_quality_reviews" ADD CONSTRAINT "data_quality_reviews_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_goals" ADD CONSTRAINT "department_goals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_demand_submissions" ADD CONSTRAINT "ops_demand_submissions_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_demand_submissions" ADD CONSTRAINT "ops_demand_submissions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_demand_submissions" ADD CONSTRAINT "ops_demand_submissions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_demand_submissions" ADD CONSTRAINT "ops_demand_submissions_supersedes_id_ops_demand_submissions_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."ops_demand_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_plan_events" ADD CONSTRAINT "ops_plan_events_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_plan_events" ADD CONSTRAINT "ops_plan_events_spu_id_spus_id_fk" FOREIGN KEY ("spu_id") REFERENCES "public"."spus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_plan_events" ADD CONSTRAINT "ops_plan_events_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_plan_events" ADD CONSTRAINT "ops_plan_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_amount_monthly" ADD CONSTRAINT "sales_amount_monthly_supersedes_id_sales_amount_monthly_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."sales_amount_monthly"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_amount_monthly" ADD CONSTRAINT "sales_amount_monthly_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_planning_policy" ADD CONSTRAINT "sku_planning_policy_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_planning_policy" ADD CONSTRAINT "sku_planning_policy_override_by_users_id_fk" FOREIGN KEY ("override_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_fees" ADD CONSTRAINT "transfer_fees_stock_doc_id_stock_docs_id_fk" FOREIGN KEY ("stock_doc_id") REFERENCES "public"."stock_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_fees" ADD CONSTRAINT "transfer_fees_reversal_of_id_transfer_fees_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."transfer_fees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_fees" ADD CONSTRAINT "transfer_fees_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_data_scopes" ADD CONSTRAINT "user_data_scopes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_data_scopes" ADD CONSTRAINT "user_data_scopes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assigner_id_users_id_fk" FOREIGN KEY ("assigner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_ops_demand_submissions_key" ON "ops_demand_submissions" USING btree ("sku_id","channel_id","period");--> statement-breakpoint
CREATE INDEX "ix_ops_plan_events_window" ON "ops_plan_events" USING btree ("start_date","end_date");--> statement-breakpoint
CREATE INDEX "ix_ops_plan_events_sku" ON "ops_plan_events" USING btree ("sku_id");--> statement-breakpoint
CREATE INDEX "ix_sales_amount_monthly_scope" ON "sales_amount_monthly" USING btree ("year_month","scope_kind","scope_id");--> statement-breakpoint
CREATE INDEX "ix_sku_planning_policy_period_tier" ON "sku_planning_policy" USING btree ("period","tier");--> statement-breakpoint
CREATE INDEX "ix_transfer_fees_doc" ON "transfer_fees" USING btree ("stock_doc_id");--> statement-breakpoint
CREATE INDEX "ix_transfer_fees_biz_date" ON "transfer_fees" USING btree ("biz_date");--> statement-breakpoint
CREATE INDEX "ix_work_items_assignee_status" ON "work_items" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "ix_work_items_due" ON "work_items" USING btree ("due_date");--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "ck_suppliers_payment_term_type" CHECK ("suppliers"."payment_term_type" IS NULL OR "suppliers"."payment_term_type" IN ('prepay', 'on_delivery', 'monthly_credit'));--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "ck_suppliers_credit_days" CHECK ("suppliers"."credit_days" IS NULL OR ("suppliers"."credit_days" >= 0 AND "suppliers"."credit_days" <= 180));--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "ck_suppliers_declared_capacity" CHECK ("suppliers"."declared_monthly_capacity" IS NULL OR "suppliers"."declared_monthly_capacity" >= 0);--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "ck_suppliers_surge_capacity_pct" CHECK ("suppliers"."surge_capacity_pct" IS NULL OR ("suppliers"."surge_capacity_pct" >= 0 AND "suppliers"."surge_capacity_pct" <= 300));--> statement-breakpoint
ALTER TABLE "stock_docs" ADD CONSTRAINT "ck_stock_docs_transfer_type" CHECK ("stock_docs"."transfer_type" IS NULL OR "stock_docs"."transfer_type" IN ('factory_to_warehouse', 'bonded_transfer', 'inter_warehouse', 'borrow', 'return_to_factory', 'other'));--> statement-breakpoint
ALTER TABLE "sku_params" ADD CONSTRAINT "ck_sku_params_purchase_lead_days" CHECK ("sku_params"."purchase_lead_days" IS NULL OR ("sku_params"."purchase_lead_days" >= 0 AND "sku_params"."purchase_lead_days" <= 365));