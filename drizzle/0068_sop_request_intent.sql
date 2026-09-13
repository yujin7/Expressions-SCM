-- Legacy intent is unknown: do not reconstruct it from the selected output lines.
ALTER TABLE "sop_execution_drafts" ADD COLUMN "request_intent" jsonb;
--> statement-breakpoint
CREATE TRIGGER sop_execution_drafts_append_only
BEFORE UPDATE OR DELETE ON sop_execution_drafts
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER sop_execution_drafts_append_only_truncate
BEFORE TRUNCATE ON sop_execution_drafts
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();
