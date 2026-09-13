CREATE TABLE "wo_create_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"requested_by" integer NOT NULL,
	"request_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"wo_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_wo_create_request" UNIQUE("requested_by","request_key"),
	CONSTRAINT "uq_wo_create_request_doc" UNIQUE("wo_id"),
	CONSTRAINT "ck_wo_create_request_hash" CHECK ("wo_create_requests"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "wo_create_requests" ADD CONSTRAINT "wo_create_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wo_create_requests" ADD CONSTRAINT "wo_create_requests_wo_id_wo_docs_id_fk" FOREIGN KEY ("wo_id") REFERENCES "public"."wo_docs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER wo_create_requests_append_only
BEFORE UPDATE OR DELETE ON wo_create_requests
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER wo_create_requests_append_only_truncate
BEFORE TRUNCATE ON wo_create_requests
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();
