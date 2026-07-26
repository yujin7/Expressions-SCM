CREATE TYPE "public"."accounting_mode" AS ENUM('realtime', 'snapshot');--> statement-breakpoint
CREATE TYPE "public"."approval_action" AS ENUM('approve', 'reject');--> statement-breakpoint
CREATE TYPE "public"."bom_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."doc_status" AS ENUM('draft', 'pending', 'approved', 'in_progress', 'completed', 'closed', 'void');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('pending', 'validating', 'failed', 'done');--> statement-breakpoint
CREATE TYPE "public"."offset_pool_kind" AS ENUM('spare', 'loss', 'resend');--> statement-breakpoint
CREATE TYPE "public"."pc_scope" AS ENUM('unreceived_only', 'retroactive');--> statement-breakpoint
CREATE TYPE "public"."pc_target" AS ENUM('po_line', 'jg_fee');--> statement-breakpoint
CREATE TYPE "public"."po_line_type" AS ENUM('raw', 'packaging');--> statement-breakpoint
CREATE TYPE "public"."qc_handling" AS ENUM('pending', 'rework', 'concession', 'scrap');--> statement-breakpoint
CREATE TYPE "public"."recon_status" AS ENUM('open', 'explained', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."sh_line_type" AS ENUM('normal', 'rework', 'spare');--> statement-breakpoint
CREATE TYPE "public"."sku_type" AS ENUM('finished', 'raw', 'packaging');--> statement-breakpoint
CREATE TYPE "public"."stock_doc_subtype" AS ENUM('purchase_in', 'outsource_in', 'outsource_in_spare', 'sales_out', 'issue_out', 'transfer', 'opening', 'count_adjust', 'reversal', 'loss_writeoff', 'transit_writeoff');--> statement-breakpoint
CREATE TYPE "public"."supplier_status" AS ENUM('pending', 'qualified', 'blacklisted');--> statement-breakpoint
CREATE TYPE "public"."tl_reason" AS ENUM('surplus_return', 'defect_exchange');--> statement-breakpoint
CREATE TYPE "public"."warehouse_kind" AS ENUM('finished', 'raw', 'packaging', 'outsource', 'transit', 'snapshot');--> statement-breakpoint
CREATE TABLE "batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_no" text NOT NULL,
	"sku_id" integer NOT NULL,
	"prod_date" date,
	"expiry_date" date,
	"source_doc_type" text,
	"source_doc_id" integer,
	CONSTRAINT "uq_batch_sku_no" UNIQUE("sku_id","batch_no")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"parent_id" integer,
	"name" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"channel" text,
	CONSTRAINT "customers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "file_metas" (
	"id" serial PRIMARY KEY NOT NULL,
	"biz_type" text NOT NULL,
	"biz_id" integer NOT NULL,
	"filename" text NOT NULL,
	"path" text NOT NULL,
	"hash" text,
	"uploaded_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"supplier_id" integer NOT NULL,
	"price" numeric(14, 2) NOT NULL,
	"effective_date" date NOT NULL,
	CONSTRAINT "uq_price_sku_sup_date" UNIQUE("sku_id","supplier_id","effective_date")
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"spu_id" integer NOT NULL,
	"spec" text,
	"version" text,
	"prod_mode" text,
	"base_uom" text NOT NULL,
	"sku_type" "sku_type" NOT NULL,
	"loss_category" text,
	"shelf_life_days" integer,
	"near_expiry_days" integer,
	"active" boolean DEFAULT true NOT NULL,
	"attrs" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skus_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "spus" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name_cn" text NOT NULL,
	"name_en" text,
	"category_id" integer,
	CONSTRAINT "spus_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kinds" text[] DEFAULT '{}' NOT NULL,
	"contact" text,
	"license_expiry" date,
	"status" "supplier_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "uom_convs" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"purchase_uom" text NOT NULL,
	"factor" numeric(14, 4) NOT NULL,
	"moq" numeric(14, 4),
	"order_multiple" numeric(14, 4),
	CONSTRAINT "uq_uom_sku_uom" UNIQUE("sku_id","purchase_uom")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"feishu_union_id" text,
	"username" text,
	"password_hash" text,
	"name" text NOT NULL,
	"roles" text[] DEFAULT '{}' NOT NULL,
	"is_approver" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_feishu_union_id_unique" UNIQUE("feishu_union_id"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "warehouse_kind" NOT NULL,
	"accounting_mode" "accounting_mode" DEFAULT 'realtime' NOT NULL,
	"supplier_id" integer,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "warehouses_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "bom_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"bom_id" integer NOT NULL,
	"material_sku_id" integer NOT NULL,
	"qty_per" numeric(14, 4) NOT NULL,
	"loss_rate_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"lead_time_days" integer,
	"substitute_sku_id" integer
);
--> statement-breakpoint
CREATE TABLE "boms" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_sku_id" integer NOT NULL,
	"version_no" text NOT NULL,
	"status" "bom_status" DEFAULT 'draft' NOT NULL,
	"effective_date" date,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bh_docs" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"status" "doc_status" DEFAULT 'draft' NOT NULL,
	"remark" text,
	"company" text,
	"dept" text,
	"project" text,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_reason" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" text,
	CONSTRAINT "bh_docs_doc_no_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
CREATE TABLE "bh_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"bh_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"qty" numeric(14, 4) NOT NULL,
	"expect_date" date
);
--> statement-breakpoint
CREATE TABLE "ct_docs" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"status" "doc_status" DEFAULT 'draft' NOT NULL,
	"remark" text,
	"company" text,
	"dept" text,
	"project" text,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_reason" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"po_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	CONSTRAINT "ct_docs_doc_no_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
CREATE TABLE "ct_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"ct_id" integer NOT NULL,
	"po_line_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"qty" numeric(14, 4) NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "fl_docs" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"status" "doc_status" DEFAULT 'draft' NOT NULL,
	"remark" text,
	"company" text,
	"dept" text,
	"project" text,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_reason" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"jg_id" integer NOT NULL,
	"from_warehouse_id" integer NOT NULL,
	"to_warehouse_id" integer NOT NULL,
	CONSTRAINT "fl_docs_doc_no_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
CREATE TABLE "fl_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"fl_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"qty" numeric(14, 4) NOT NULL,
	"batch_id" integer
);
--> statement-breakpoint
CREATE TABLE "jg_docs" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"status" "doc_status" DEFAULT 'draft' NOT NULL,
	"remark" text,
	"company" text,
	"dept" text,
	"project" text,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_reason" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"wo_id" integer NOT NULL,
	"supplier_id" integer NOT NULL,
	"product_sku_id" integer NOT NULL,
	"qty" numeric(14, 4) NOT NULL,
	"due_date" date,
	"fee_rate_current" numeric(14, 2) NOT NULL,
	"in_production" boolean DEFAULT false NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" integer,
	"confirm_note" text,
	CONSTRAINT "jg_docs_doc_no_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
CREATE TABLE "jg_fee_segments" (
	"id" serial PRIMARY KEY NOT NULL,
	"jg_id" integer NOT NULL,
	"rate" numeric(14, 2) NOT NULL,
	"effective_from" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "js_docs" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"status" "doc_status" DEFAULT 'draft' NOT NULL,
	"remark" text,
	"company" text,
	"dept" text,
	"project" text,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_reason" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"jg_id" integer NOT NULL,
	"good_qty" numeric(14, 4) NOT NULL,
	"concession_qty" numeric(14, 4) DEFAULT '0' NOT NULL,
	"spare_qty" numeric(14, 4) DEFAULT '0' NOT NULL,
	"fee_payable" numeric(14, 2) NOT NULL,
	"concession_price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"deduction_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"manual_adj" numeric(14, 2) DEFAULT '0' NOT NULL,
	"settle_amount" numeric(14, 2) NOT NULL,
	CONSTRAINT "js_docs_doc_no_unique" UNIQUE("doc_no"),
	CONSTRAINT "js_docs_jg_id_unique" UNIQUE("jg_id")
);
--> statement-breakpoint
CREATE TABLE "js_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"js_id" integer NOT NULL,
	"material_sku_id" integer NOT NULL,
	"issued_qty" numeric(14, 4) NOT NULL,
	"returned_qty" numeric(14, 4) DEFAULT '0' NOT NULL,
	"std_qty" numeric(14, 4) NOT NULL,
	"allowed_loss" numeric(14, 4) NOT NULL,
	"actual_loss" numeric(14, 4) NOT NULL,
	"excess_loss" numeric(14, 4) NOT NULL,
	"deduct_price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"deduct_amount" numeric(14, 2) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pc_docs" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"status" "doc_status" DEFAULT 'draft' NOT NULL,
	"remark" text,
	"company" text,
	"dept" text,
	"project" text,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_reason" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"target" "pc_target" NOT NULL,
	"po_line_id" integer,
	"jg_id" integer,
	"old_price" numeric(14, 2) NOT NULL,
	"new_price" numeric(14, 2) NOT NULL,
	"deviation_pct" numeric(7, 2) NOT NULL,
	"scope" "pc_scope" NOT NULL,
	CONSTRAINT "pc_docs_doc_no_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
CREATE TABLE "pd_docs" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"status" "doc_status" DEFAULT 'draft' NOT NULL,
	"remark" text,
	"company" text,
	"dept" text,
	"project" text,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_reason" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"warehouse_id" integer NOT NULL,
	"mode" text DEFAULT 'full' NOT NULL,
	CONSTRAINT "pd_docs_doc_no_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
CREATE TABLE "pd_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"pd_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"batch_id" integer,
	"book_qty" numeric(14, 4) NOT NULL,
	"counted_qty" numeric(14, 4) NOT NULL,
	"adjust_doc_id" integer
);
--> statement-breakpoint
CREATE TABLE "po_docs" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"status" "doc_status" DEFAULT 'draft' NOT NULL,
	"remark" text,
	"company" text,
	"dept" text,
	"project" text,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_reason" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"wo_id" integer,
	"supplier_id" integer NOT NULL,
	"expected_date" date,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" integer,
	"confirm_note" text,
	CONSTRAINT "po_docs_doc_no_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
CREATE TABLE "po_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"po_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"line_type" "po_line_type" NOT NULL,
	"purchase_uom" text NOT NULL,
	"uom_factor" numeric(14, 4) DEFAULT '1' NOT NULL,
	"qty" numeric(14, 4) NOT NULL,
	"price" numeric(14, 2) NOT NULL,
	"tax_included" boolean DEFAULT true NOT NULL,
	"tax_rate_pct" numeric(5, 2) DEFAULT '13' NOT NULL,
	"received_qty" numeric(14, 4) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qc_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"qc_id" integer NOT NULL,
	"sh_line_id" integer NOT NULL,
	"pass_qty" numeric(14, 4) DEFAULT '0' NOT NULL,
	"fail_qty" numeric(14, 4) DEFAULT '0' NOT NULL,
	"concession_qty" numeric(14, 4) DEFAULT '0' NOT NULL,
	"fail_handling" "qc_handling" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qc_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"sh_id" integer NOT NULL,
	"conclusion" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sh_docs" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"status" "doc_status" DEFAULT 'draft' NOT NULL,
	"remark" text,
	"company" text,
	"dept" text,
	"project" text,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_reason" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_type" text NOT NULL,
	"source_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	CONSTRAINT "sh_docs_doc_no_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
CREATE TABLE "sh_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"sh_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"line_type" "sh_line_type" DEFAULT 'normal' NOT NULL,
	"expected_qty" numeric(14, 4),
	"actual_qty" numeric(14, 4) NOT NULL,
	"batch_no" text,
	"prod_date" date
);
--> statement-breakpoint
CREATE TABLE "stock_doc_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"stock_doc_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"to_warehouse_id" integer,
	"batch_id" integer,
	"qty" numeric(14, 4) NOT NULL,
	"price" numeric(14, 2)
);
--> statement-breakpoint
CREATE TABLE "stock_docs" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"status" "doc_status" DEFAULT 'draft' NOT NULL,
	"remark" text,
	"company" text,
	"dept" text,
	"project" text,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_reason" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subtype" "stock_doc_subtype" NOT NULL,
	"source_doc_type" text,
	"source_doc_id" integer,
	"reversal_of_id" integer,
	CONSTRAINT "stock_docs_doc_no_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
CREATE TABLE "tl_docs" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"status" "doc_status" DEFAULT 'draft' NOT NULL,
	"remark" text,
	"company" text,
	"dept" text,
	"project" text,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_reason" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"jg_id" integer NOT NULL,
	"from_warehouse_id" integer NOT NULL,
	"to_warehouse_id" integer NOT NULL,
	CONSTRAINT "tl_docs_doc_no_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
CREATE TABLE "tl_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"tl_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"qty" numeric(14, 4) NOT NULL,
	"reason" "tl_reason" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wo_docs" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"status" "doc_status" DEFAULT 'draft' NOT NULL,
	"remark" text,
	"company" text,
	"dept" text,
	"project" text,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_reason" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bh_id" integer,
	"product_sku_id" integer NOT NULL,
	"qty" numeric(14, 4) NOT NULL,
	"supplier_id" integer NOT NULL,
	"fee_rate_plan" numeric(14, 2) NOT NULL,
	"due_date" date,
	"bom_id" integer NOT NULL,
	CONSTRAINT "wo_docs_doc_no_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
CREATE TABLE "wo_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"wo_id" integer NOT NULL,
	"material_sku_id" integer NOT NULL,
	"qty_per" numeric(14, 4) NOT NULL,
	"plan_loss_rate_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"gross_req" numeric(14, 4) NOT NULL,
	"on_hand_at" numeric(14, 4) DEFAULT '0' NOT NULL,
	"in_transit_at" numeric(14, 4) DEFAULT '0' NOT NULL,
	"suggested_qty" numeric(14, 4) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offset_pools" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "offset_pool_kind" NOT NULL,
	"sku_id" integer NOT NULL,
	"qty" numeric(14, 4) NOT NULL,
	"amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"source_doc_type" text NOT NULL,
	"source_doc_id" integer NOT NULL,
	"writeoff_doc_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"batch_id" integer,
	"qty" numeric(14, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "uq_balance_key" UNIQUE NULLS NOT DISTINCT("sku_id","warehouse_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "stock_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"batch_id" integer,
	"qty_delta" numeric(14, 4) NOT NULL,
	"source_doc_type" text NOT NULL,
	"source_doc_id" integer NOT NULL,
	"source_line_id" integer DEFAULT 0 NOT NULL,
	"action" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_ledger_source" UNIQUE("source_doc_type","source_doc_id","source_line_id","action","warehouse_id")
);
--> statement-breakpoint
CREATE TABLE "stock_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"warehouse_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"biz_date" date NOT NULL,
	"qty" numeric(14, 4) NOT NULL,
	CONSTRAINT "uq_snapshot_key" UNIQUE("warehouse_id","sku_id","biz_date")
);
--> statement-breakpoint
CREATE TABLE "approval_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_type" text NOT NULL,
	"approver_role" text NOT NULL,
	CONSTRAINT "approval_configs_doc_type_unique" UNIQUE("doc_type")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_type" text NOT NULL,
	"doc_id" integer NOT NULL,
	"node" integer DEFAULT 1 NOT NULL,
	"approver_id" integer NOT NULL,
	"action" "approval_action" NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_approval_idem" UNIQUE("doc_type","doc_id","node","action")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"entity" text NOT NULL,
	"entity_id" integer,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_counters" (
	"prefix" text NOT NULL,
	"biz_date" text NOT NULL,
	"last_no" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "doc_counters_prefix_biz_date_pk" PRIMARY KEY("prefix","biz_date")
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"template" text NOT NULL,
	"filename" text NOT NULL,
	"file_hash" text,
	"status" "import_status" DEFAULT 'pending' NOT NULL,
	"ok_rows" integer DEFAULT 0 NOT NULL,
	"fail_rows" integer DEFAULT 0 NOT NULL,
	"error_file" text,
	"idempotency_key" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recon_diffs" (
	"id" serial PRIMARY KEY NOT NULL,
	"biz_date" date NOT NULL,
	"sku_id" integer NOT NULL,
	"sys_qty" numeric(14, 4) NOT NULL,
	"jst_qty" numeric(14, 4) NOT NULL,
	"diff_qty" numeric(14, 4) NOT NULL,
	"status" "recon_status" DEFAULT 'open' NOT NULL,
	"note" text,
	CONSTRAINT "uq_recon_date_sku" UNIQUE("biz_date","sku_id")
);
--> statement-breakpoint
CREATE TABLE "sys_params" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"note" text,
	CONSTRAINT "uq_param_scope_key" UNIQUE("scope","key")
);
--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_metas" ADD CONSTRAINT "file_metas_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_spu_id_spus_id_fk" FOREIGN KEY ("spu_id") REFERENCES "public"."spus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spus" ADD CONSTRAINT "spus_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uom_convs" ADD CONSTRAINT "uom_convs_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_bom_id_boms_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."boms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_material_sku_id_skus_id_fk" FOREIGN KEY ("material_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_substitute_sku_id_skus_id_fk" FOREIGN KEY ("substitute_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boms" ADD CONSTRAINT "boms_product_sku_id_skus_id_fk" FOREIGN KEY ("product_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bh_lines" ADD CONSTRAINT "bh_lines_bh_id_bh_docs_id_fk" FOREIGN KEY ("bh_id") REFERENCES "public"."bh_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bh_lines" ADD CONSTRAINT "bh_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ct_docs" ADD CONSTRAINT "ct_docs_po_id_po_docs_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."po_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ct_docs" ADD CONSTRAINT "ct_docs_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ct_lines" ADD CONSTRAINT "ct_lines_ct_id_ct_docs_id_fk" FOREIGN KEY ("ct_id") REFERENCES "public"."ct_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ct_lines" ADD CONSTRAINT "ct_lines_po_line_id_po_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."po_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ct_lines" ADD CONSTRAINT "ct_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fl_docs" ADD CONSTRAINT "fl_docs_jg_id_jg_docs_id_fk" FOREIGN KEY ("jg_id") REFERENCES "public"."jg_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fl_docs" ADD CONSTRAINT "fl_docs_from_warehouse_id_warehouses_id_fk" FOREIGN KEY ("from_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fl_docs" ADD CONSTRAINT "fl_docs_to_warehouse_id_warehouses_id_fk" FOREIGN KEY ("to_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fl_lines" ADD CONSTRAINT "fl_lines_fl_id_fl_docs_id_fk" FOREIGN KEY ("fl_id") REFERENCES "public"."fl_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fl_lines" ADD CONSTRAINT "fl_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD CONSTRAINT "jg_docs_wo_id_wo_docs_id_fk" FOREIGN KEY ("wo_id") REFERENCES "public"."wo_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD CONSTRAINT "jg_docs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD CONSTRAINT "jg_docs_product_sku_id_skus_id_fk" FOREIGN KEY ("product_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD CONSTRAINT "jg_docs_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jg_fee_segments" ADD CONSTRAINT "jg_fee_segments_jg_id_jg_docs_id_fk" FOREIGN KEY ("jg_id") REFERENCES "public"."jg_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "js_docs" ADD CONSTRAINT "js_docs_jg_id_jg_docs_id_fk" FOREIGN KEY ("jg_id") REFERENCES "public"."jg_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "js_lines" ADD CONSTRAINT "js_lines_js_id_js_docs_id_fk" FOREIGN KEY ("js_id") REFERENCES "public"."js_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "js_lines" ADD CONSTRAINT "js_lines_material_sku_id_skus_id_fk" FOREIGN KEY ("material_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_docs" ADD CONSTRAINT "pc_docs_po_line_id_po_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."po_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pd_docs" ADD CONSTRAINT "pd_docs_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pd_lines" ADD CONSTRAINT "pd_lines_pd_id_pd_docs_id_fk" FOREIGN KEY ("pd_id") REFERENCES "public"."pd_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pd_lines" ADD CONSTRAINT "pd_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_docs" ADD CONSTRAINT "po_docs_wo_id_wo_docs_id_fk" FOREIGN KEY ("wo_id") REFERENCES "public"."wo_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_docs" ADD CONSTRAINT "po_docs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_docs" ADD CONSTRAINT "po_docs_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_po_id_po_docs_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."po_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_lines" ADD CONSTRAINT "qc_lines_qc_id_qc_records_id_fk" FOREIGN KEY ("qc_id") REFERENCES "public"."qc_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_lines" ADD CONSTRAINT "qc_lines_sh_line_id_sh_lines_id_fk" FOREIGN KEY ("sh_line_id") REFERENCES "public"."sh_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_records" ADD CONSTRAINT "qc_records_sh_id_sh_docs_id_fk" FOREIGN KEY ("sh_id") REFERENCES "public"."sh_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sh_docs" ADD CONSTRAINT "sh_docs_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sh_lines" ADD CONSTRAINT "sh_lines_sh_id_sh_docs_id_fk" FOREIGN KEY ("sh_id") REFERENCES "public"."sh_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sh_lines" ADD CONSTRAINT "sh_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_doc_lines" ADD CONSTRAINT "stock_doc_lines_stock_doc_id_stock_docs_id_fk" FOREIGN KEY ("stock_doc_id") REFERENCES "public"."stock_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_doc_lines" ADD CONSTRAINT "stock_doc_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_doc_lines" ADD CONSTRAINT "stock_doc_lines_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_doc_lines" ADD CONSTRAINT "stock_doc_lines_to_warehouse_id_warehouses_id_fk" FOREIGN KEY ("to_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tl_docs" ADD CONSTRAINT "tl_docs_jg_id_jg_docs_id_fk" FOREIGN KEY ("jg_id") REFERENCES "public"."jg_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tl_docs" ADD CONSTRAINT "tl_docs_from_warehouse_id_warehouses_id_fk" FOREIGN KEY ("from_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tl_docs" ADD CONSTRAINT "tl_docs_to_warehouse_id_warehouses_id_fk" FOREIGN KEY ("to_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tl_lines" ADD CONSTRAINT "tl_lines_tl_id_tl_docs_id_fk" FOREIGN KEY ("tl_id") REFERENCES "public"."tl_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tl_lines" ADD CONSTRAINT "tl_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wo_docs" ADD CONSTRAINT "wo_docs_bh_id_bh_docs_id_fk" FOREIGN KEY ("bh_id") REFERENCES "public"."bh_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wo_docs" ADD CONSTRAINT "wo_docs_product_sku_id_skus_id_fk" FOREIGN KEY ("product_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wo_docs" ADD CONSTRAINT "wo_docs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wo_docs" ADD CONSTRAINT "wo_docs_bom_id_boms_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."boms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wo_lines" ADD CONSTRAINT "wo_lines_wo_id_wo_docs_id_fk" FOREIGN KEY ("wo_id") REFERENCES "public"."wo_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wo_lines" ADD CONSTRAINT "wo_lines_material_sku_id_skus_id_fk" FOREIGN KEY ("material_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offset_pools" ADD CONSTRAINT "offset_pools_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_snapshots" ADD CONSTRAINT "stock_snapshots_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_snapshots" ADD CONSTRAINT "stock_snapshots_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_diffs" ADD CONSTRAINT "recon_diffs_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bom_one_active" ON "boms" USING btree ("product_sku_id") WHERE "boms"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bom_product_version" ON "boms" USING btree ("product_sku_id","version_no");--> statement-breakpoint
CREATE INDEX "ix_ledger_sku_wh_time" ON "stock_ledger" USING btree ("sku_id","warehouse_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_audit_entity" ON "audit_logs" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "ix_audit_time" ON "audit_logs" USING btree ("created_at");