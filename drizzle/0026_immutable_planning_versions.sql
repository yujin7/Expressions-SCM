-- Planning versions are meeting evidence. Recalculation creates a new version;
-- history is never edited or deleted.
CREATE TRIGGER planning_versions_append_only
BEFORE UPDATE OR DELETE ON planning_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER planning_versions_append_only_truncate
BEFORE TRUNCATE ON planning_versions
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER planning_version_lines_append_only
BEFORE UPDATE OR DELETE ON planning_version_lines
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER planning_version_lines_append_only_truncate
BEFORE TRUNCATE ON planning_version_lines
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();
