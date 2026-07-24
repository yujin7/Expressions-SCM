ALTER TABLE "jg_docs" ADD COLUMN "fee_type" text DEFAULT 'OEM填充' NOT NULL;--> statement-breakpoint
ALTER TABLE "processing_fee_refs" ADD COLUMN "fee_type" text DEFAULT 'OEM填充' NOT NULL;