ALTER TABLE "bom_lines" ADD COLUMN "preferred_supplier_id" integer;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD COLUMN "uom" text;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD COLUMN "remark" text;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_preferred_supplier_id_suppliers_id_fk" FOREIGN KEY ("preferred_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;