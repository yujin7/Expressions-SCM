CREATE TABLE "alias_exceptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"alias_type" text NOT NULL,
	"raw_value" text NOT NULL,
	"context" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_target_id" integer,
	"resolved_by" integer,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_alias_exc_type_value" UNIQUE("alias_type","raw_value")
);
--> statement-breakpoint
CREATE TABLE "aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"alias_type" text NOT NULL,
	"raw_value" text NOT NULL,
	"target_id" integer NOT NULL,
	"note" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_alias_type_value" UNIQUE("alias_type","raw_value")
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name_cn" text NOT NULL,
	"name_en" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "brands_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "channels_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "sales_monthly" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"year_month" text NOT NULL,
	"qty" numeric(14, 4) NOT NULL,
	CONSTRAINT "uq_sales_monthly" UNIQUE("sku_id","channel_id","year_month")
);
--> statement-breakpoint
CREATE TABLE "sales_velocity" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"channel_id" integer,
	"avg_7d" numeric(14, 4),
	"avg_90d" numeric(14, 4),
	"computed_on" date NOT NULL,
	CONSTRAINT "uq_sales_velocity" UNIQUE NULLS NOT DISTINCT("sku_id","channel_id","computed_on")
);
--> statement-breakpoint
CREATE TABLE "staging_rows" (
	"id" serial PRIMARY KEY NOT NULL,
	"import_job_id" integer NOT NULL,
	"row_no" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_msg" text,
	"target_table" text,
	"target_id" integer
);
--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "brand_id" integer;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "barcode" text;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "product_type" text;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "remark" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "short_name" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "level" text;--> statement-breakpoint
ALTER TABLE "alias_exceptions" ADD CONSTRAINT "alias_exceptions_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_monthly" ADD CONSTRAINT "sales_monthly_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_monthly" ADD CONSTRAINT "sales_monthly_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_velocity" ADD CONSTRAINT "sales_velocity_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_velocity" ADD CONSTRAINT "sales_velocity_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_rows" ADD CONSTRAINT "staging_rows_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_staging_job_status" ON "staging_rows" USING btree ("import_job_id","status");