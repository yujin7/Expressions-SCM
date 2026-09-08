ALTER TABLE "supplier_lifecycle_cases" DROP CONSTRAINT "ck_supplier_lifecycle_kind";--> statement-breakpoint
ALTER TABLE "supplier_lifecycle_cases" ADD COLUMN "target_credit_days" integer;--> statement-breakpoint
ALTER TABLE "supplier_lifecycle_cases" ADD COLUMN "term_baseline" jsonb;--> statement-breakpoint
ALTER TABLE "supplier_lifecycle_cases" ADD COLUMN "term_agreement" jsonb;--> statement-breakpoint
ALTER TABLE "supplier_lifecycle_cases" ADD COLUMN "progress_note" text;--> statement-breakpoint
ALTER TABLE "supplier_lifecycle_cases" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_lifecycle_cases" ADD CONSTRAINT "ck_supplier_lifecycle_version" CHECK ("supplier_lifecycle_cases"."version" >= 1);--> statement-breakpoint
ALTER TABLE "supplier_lifecycle_cases" ADD CONSTRAINT "ck_supplier_lifecycle_term" CHECK (
    ("supplier_lifecycle_cases"."kind" <> 'payment_term' AND "supplier_lifecycle_cases"."target_credit_days" IS NULL AND "supplier_lifecycle_cases"."term_baseline" IS NULL AND "supplier_lifecycle_cases"."term_agreement" IS NULL)
    OR ("supplier_lifecycle_cases"."kind" = 'payment_term' AND "supplier_lifecycle_cases"."target_credit_days" IS NOT NULL AND "supplier_lifecycle_cases"."target_credit_days" BETWEEN 45 AND 60
      AND "supplier_lifecycle_cases"."term_baseline" IS NOT NULL AND jsonb_typeof("supplier_lifecycle_cases"."term_baseline") = 'object'
      AND NOT "supplier_lifecycle_cases"."pause_new_orders"
      AND ("supplier_lifecycle_cases"."outcome" IS NULL OR "supplier_lifecycle_cases"."outcome" IN ('resolved', 'failed'))
      AND (("supplier_lifecycle_cases"."status" = 'closed' AND "supplier_lifecycle_cases"."outcome" = 'resolved' AND "supplier_lifecycle_cases"."term_agreement" IS NOT NULL AND jsonb_typeof("supplier_lifecycle_cases"."term_agreement") = 'object')
        OR (("supplier_lifecycle_cases"."status" = 'open' OR "supplier_lifecycle_cases"."outcome" = 'failed') AND "supplier_lifecycle_cases"."term_agreement" IS NULL))));--> statement-breakpoint
ALTER TABLE "supplier_lifecycle_cases" ADD CONSTRAINT "ck_supplier_lifecycle_kind" CHECK ("supplier_lifecycle_cases"."kind" IN ('admission', 'corrective', 'payment_term'));