CREATE TABLE "bin_balances" (
	"id" serial PRIMARY KEY NOT NULL,
	"bin_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"batch_id" integer,
	"qty" numeric(14, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "uq_bin_balance_key" UNIQUE NULLS NOT DISTINCT("bin_id","sku_id","batch_id"),
	CONSTRAINT "ck_bin_balance_nonnegative" CHECK ("bin_balances"."qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "bin_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"warehouse_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"batch_id" integer,
	"from_bin_id" integer,
	"to_bin_id" integer,
	"qty" numeric(14, 4) NOT NULL,
	"operation" text NOT NULL,
	"reason" text,
	"created_by" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bin_movements_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ck_bin_movement_positive_qty" CHECK ("bin_movements"."qty" > 0),
	CONSTRAINT "ck_bin_movement_has_endpoint" CHECK ("bin_movements"."from_bin_id" IS NOT NULL OR "bin_movements"."to_bin_id" IS NOT NULL),
	CONSTRAINT "ck_bin_movement_distinct_endpoints" CHECK ("bin_movements"."from_bin_id" IS NULL OR "bin_movements"."to_bin_id" IS NULL OR "bin_movements"."from_bin_id" <> "bin_movements"."to_bin_id"),
	CONSTRAINT "ck_bin_movement_operation" CHECK ("bin_movements"."operation" IN ('locate', 'move', 'unlocate', 'quarantine', 'release'))
);
--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "region_code" text DEFAULT 'CN' NOT NULL;--> statement-breakpoint
ALTER TABLE "bin_balances" ADD CONSTRAINT "bin_balances_bin_id_bins_id_fk" FOREIGN KEY ("bin_id") REFERENCES "public"."bins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bin_balances" ADD CONSTRAINT "bin_balances_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bin_balances" ADD CONSTRAINT "bin_balances_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bin_movements" ADD CONSTRAINT "bin_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bin_movements" ADD CONSTRAINT "bin_movements_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bin_movements" ADD CONSTRAINT "bin_movements_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bin_movements" ADD CONSTRAINT "bin_movements_from_bin_id_bins_id_fk" FOREIGN KEY ("from_bin_id") REFERENCES "public"."bins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bin_movements" ADD CONSTRAINT "bin_movements_to_bin_id_bins_id_fk" FOREIGN KEY ("to_bin_id") REFERENCES "public"."bins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bin_movements" ADD CONSTRAINT "bin_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_bin_balance_sku_batch" ON "bin_balances" USING btree ("sku_id","batch_id");--> statement-breakpoint
CREATE INDEX "ix_bin_movement_wh_time" ON "bin_movements" USING btree ("warehouse_id","occurred_at" desc);--> statement-breakpoint
CREATE INDEX "ix_bin_movement_sku_batch" ON "bin_movements" USING btree ("sku_id","batch_id");--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "ck_warehouse_region_code" CHECK ("warehouses"."region_code" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "ck_warehouse_accounting_taxonomy" CHECK (("warehouses"."kind" = 'snapshot' AND "warehouses"."accounting_mode" = 'snapshot') OR ("warehouses"."kind" <> 'snapshot' AND "warehouses"."accounting_mode" = 'realtime'));--> statement-breakpoint
-- Location movements are operational facts. Corrections are compensating
-- movements, never edits to or deletion of the original history.
CREATE TRIGGER bin_movements_append_only
BEFORE UPDATE OR DELETE ON bin_movements
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();--> statement-breakpoint
CREATE TRIGGER bin_movements_append_only_truncate
BEFORE TRUNCATE ON bin_movements
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();
