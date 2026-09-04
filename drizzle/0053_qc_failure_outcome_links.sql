ALTER TABLE "qc_records" ADD COLUMN "quality_case_id" integer;--> statement-breakpoint
ALTER TABLE "qc_records" ADD COLUMN "return_ct_id" integer;--> statement-breakpoint
ALTER TABLE "quality_cases" ADD COLUMN "qc_record_id" integer;--> statement-breakpoint
ALTER TABLE "qc_records" ADD CONSTRAINT "qc_records_return_ct_id_ct_docs_id_fk" FOREIGN KEY ("return_ct_id") REFERENCES "public"."ct_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_cases" ADD CONSTRAINT "quality_cases_qc_record_id_qc_records_id_fk" FOREIGN KEY ("qc_record_id") REFERENCES "public"."qc_records"("id") ON DELETE no action ON UPDATE no action;