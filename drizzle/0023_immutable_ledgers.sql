-- Inventory movements and audit events are immutable facts. Corrections must be
-- represented by compensating entries, never by rewriting recorded history.
CREATE OR REPLACE FUNCTION reject_immutable_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_ledger_append_only
BEFORE UPDATE OR DELETE ON stock_ledger
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER stock_ledger_append_only_truncate
BEFORE TRUNCATE ON stock_ledger
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only_truncate
BEFORE TRUNCATE ON audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();
