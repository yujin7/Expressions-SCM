ALTER TABLE "bh_docs" ADD COLUMN "order_type" text;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD CONSTRAINT "uq_jg_wo" UNIQUE("wo_id");