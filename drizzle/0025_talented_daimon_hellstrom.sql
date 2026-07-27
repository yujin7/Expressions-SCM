CREATE TABLE "planning_version_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"version_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"sku_code" text NOT NULL,
	"sku_name" text NOT NULL,
	"brand" text,
	"base_uom" text NOT NULL,
	"suggested_qty" numeric(14, 4) NOT NULL,
	"suppressed" boolean DEFAULT false NOT NULL,
	"shortage_date" date,
	"order_by_date" date,
	"order_window_missed" boolean DEFAULT false NOT NULL,
	"cover_full" numeric(14, 2),
	"on_hand" numeric(14, 4) NOT NULL,
	"in_transit" numeric(14, 4) NOT NULL,
	"daily" numeric(14, 4) NOT NULL,
	"safety_qty" numeric(14, 4) NOT NULL,
	"lead_days" integer,
	"explanation" jsonb NOT NULL,
	CONSTRAINT "uq_planning_version_sku" UNIQUE("version_id","sku_id")
);
--> statement-breakpoint
CREATE TABLE "planning_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"week_start" date NOT NULL,
	"engine_version" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"source_meta" jsonb NOT NULL,
	"line_count" integer NOT NULL,
	"suggested_count" integer NOT NULL,
	"suppressed_count" integer NOT NULL,
	"digest" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_planning_version_idempotency" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "planning_version_lines" ADD CONSTRAINT "planning_version_lines_version_id_planning_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."planning_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_version_lines" ADD CONSTRAINT "planning_version_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_versions" ADD CONSTRAINT "planning_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_planning_line_sku_version" ON "planning_version_lines" USING btree ("sku_id","version_id");--> statement-breakpoint
CREATE INDEX "ix_planning_version_created" ON "planning_versions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ix_planning_version_week" ON "planning_versions" USING btree ("week_start");
