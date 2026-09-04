ALTER TABLE "po_promise_revisions" DROP CONSTRAINT "ck_po_promise_date_changed";--> statement-breakpoint
ALTER TABLE "po_promise_revisions" ADD CONSTRAINT "ck_po_promise_date_changed" CHECK ("po_promise_revisions"."previous_date" IS DISTINCT FROM "po_promise_revisions"."promised_date"
      OR ("po_promise_revisions"."sequence" = 1 AND "po_promise_revisions"."source" = 'supplier_confirm'));