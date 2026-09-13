CREATE TABLE "ct_create_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"requested_by" integer NOT NULL,
	"request_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"ct_doc_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_ct_create_request" UNIQUE("requested_by","request_key"),
	CONSTRAINT "uq_ct_create_request_doc" UNIQUE("ct_doc_id"),
	CONSTRAINT "ck_ct_create_request_hash" CHECK ("ct_create_requests"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "ct_create_requests" ADD CONSTRAINT "ct_create_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ct_create_requests" ADD CONSTRAINT "ct_create_requests_ct_doc_id_ct_docs_id_fk" FOREIGN KEY ("ct_doc_id") REFERENCES "public"."ct_docs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER ct_create_requests_append_only
BEFORE UPDATE OR DELETE ON ct_create_requests
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER ct_create_requests_append_only_truncate
BEFORE TRUNCATE ON ct_create_requests
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();
