CREATE TABLE "approval_delegations" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_user_id" integer NOT NULL,
	"to_user_id" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_routes" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_type" text NOT NULL,
	"min_amount" numeric(14, 2),
	"approver_roles" text NOT NULL,
	"label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bins" (
	"id" serial PRIMARY KEY NOT NULL,
	"warehouse_id" integer NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"kind" text DEFAULT 'normal' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_bin_wh_code" UNIQUE("warehouse_id","code")
);
--> statement-breakpoint
CREATE TABLE "rollup_sku_month" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"year_month" text NOT NULL,
	"sales_qty" numeric(14, 4) DEFAULT '0' NOT NULL,
	"outbound_qty" numeric(14, 4) DEFAULT '0' NOT NULL,
	"inbound_qty" numeric(14, 4) DEFAULT '0' NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_rollup_sku_month" UNIQUE("sku_id","year_month")
);
--> statement-breakpoint
CREATE TABLE "rollup_supplier_lead" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"lead_p50_days" numeric(8, 2),
	"lead_p90_days" numeric(8, 2),
	"lead_stdev_days" numeric(8, 2),
	"on_time_rate" numeric(5, 4),
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_rollup_supplier_lead" UNIQUE("supplier_id","sku_id")
);
--> statement-breakpoint
CREATE TABLE "rollup_warehouse_sku" (
	"id" serial PRIMARY KEY NOT NULL,
	"warehouse_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"on_hand" numeric(14, 4) DEFAULT '0' NOT NULL,
	"outbound_90d" numeric(14, 4) DEFAULT '0' NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_rollup_wh_sku" UNIQUE("warehouse_id","sku_id")
);
--> statement-breakpoint
ALTER TABLE "price_lists" ADD COLUMN "currency" text DEFAULT 'CNY' NOT NULL;--> statement-breakpoint
ALTER TABLE "sku_costs" ADD COLUMN "currency" text DEFAULT 'CNY' NOT NULL;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD COLUMN "report_token" text;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD COLUMN "report_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_routes" ADD CONSTRAINT "approval_routes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bins" ADD CONSTRAINT "bins_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollup_sku_month" ADD CONSTRAINT "rollup_sku_month_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollup_supplier_lead" ADD CONSTRAINT "rollup_supplier_lead_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollup_supplier_lead" ADD CONSTRAINT "rollup_supplier_lead_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollup_warehouse_sku" ADD CONSTRAINT "rollup_warehouse_sku_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollup_warehouse_sku" ADD CONSTRAINT "rollup_warehouse_sku_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_delegation_from" ON "approval_delegations" USING btree ("from_user_id","active");--> statement-breakpoint
CREATE INDEX "ix_approval_route_doc" ON "approval_routes" USING btree ("doc_type","active");--> statement-breakpoint
CREATE INDEX "ix_rollup_sku_month_ym" ON "rollup_sku_month" USING btree ("year_month");--> statement-breakpoint
CREATE INDEX "ix_rollup_lead_sku" ON "rollup_supplier_lead" USING btree ("sku_id");