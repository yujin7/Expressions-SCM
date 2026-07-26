CREATE TABLE "transit_refs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"brand_raw" text,
	"sku_code" text,
	"sku_id" integer,
	"material_code" text,
	"material_name" text,
	"oem_raw" text,
	"supplier_id" integer,
	"external_no" text,
	"approval_no" text,
	"feishu_no" text,
	"order_type" text,
	"qty" numeric(14, 4),
	"done_qty" numeric(14, 4),
	"inbound_qty" numeric(14, 4),
	"closed_qty" numeric(14, 4),
	"used_qty" numeric(14, 4),
	"remain_qty" numeric(14, 4),
	"order_date" date,
	"need_date" date,
	"reply_date" date,
	"revised_date" date,
	"expect_date" date,
	"start_date" date,
	"progress" text,
	"urgent_dept" text,
	"follower" text,
	"exception" text,
	"extra" jsonb,
	"source_job_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ix_transit_kind" ON "transit_refs" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "ix_transit_sku" ON "transit_refs" USING btree ("sku_code");--> statement-breakpoint
CREATE INDEX "ix_transit_approval" ON "transit_refs" USING btree ("approval_no");