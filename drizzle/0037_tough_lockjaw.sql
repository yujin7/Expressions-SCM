ALTER TABLE "skus" ADD COLUMN "commercial_role" text DEFAULT 'unclassified' NOT NULL;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "short_name" text;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "channel_id" integer;--> statement-breakpoint
ALTER TABLE "sku_params" ADD COLUMN "logistics_lead_days" integer;--> statement-breakpoint
CREATE INDEX "ix_skus_commercial_role" ON "skus" USING btree ("commercial_role");--> statement-breakpoint
CREATE INDEX "ix_skus_channel" ON "skus" USING btree ("channel_id");--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "ck_skus_commercial_role" CHECK ("skus"."commercial_role" IN ('unclassified', 'retail', 'sample', 'gift', 'tester', 'internal'));--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "ck_skus_short_name_length" CHECK ("skus"."short_name" IS NULL OR char_length("skus"."short_name") <= 10);--> statement-breakpoint
ALTER TABLE "sku_params" ADD CONSTRAINT "ck_sku_params_logistics_lead_days" CHECK ("sku_params"."logistics_lead_days" IS NULL OR ("sku_params"."logistics_lead_days" >= 0 AND "sku_params"."logistics_lead_days" <= 365));