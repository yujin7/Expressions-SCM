ALTER TABLE "ct_docs" ADD COLUMN "replacement_of_id" integer;--> statement-breakpoint
ALTER TABLE "ct_docs" ADD CONSTRAINT "ct_docs_replacement_of_id_ct_docs_id_fk" FOREIGN KEY ("replacement_of_id") REFERENCES "public"."ct_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ct_docs" ADD CONSTRAINT "uq_ct_doc_replacement" UNIQUE("replacement_of_id");--> statement-breakpoint
ALTER TABLE "ct_docs" ADD CONSTRAINT "ck_ct_doc_replacement_order" CHECK ("ct_docs"."replacement_of_id" IS NULL OR "ct_docs"."replacement_of_id" < "ct_docs"."id");