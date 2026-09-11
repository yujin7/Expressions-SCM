ALTER TABLE "qc_lines" ADD CONSTRAINT "uq_qc_line_receipt_line" UNIQUE("qc_id","sh_line_id");--> statement-breakpoint
ALTER TABLE "qc_records" ADD CONSTRAINT "uq_qc_record_sh" UNIQUE("sh_id");