CREATE TABLE "bh_create_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"requested_by" integer NOT NULL,
	"request_key" text NOT NULL,
	"source" text NOT NULL,
	"request_hash" text NOT NULL,
	"bh_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_bh_create_request" UNIQUE("requested_by","request_key"),
	CONSTRAINT "uq_bh_create_request_doc" UNIQUE("bh_id"),
	CONSTRAINT "ck_bh_create_request_hash" CHECK ("bh_create_requests"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ck_bh_create_request_source" CHECK ("bh_create_requests"."source" IN ('manual', 'replenish'))
);
--> statement-breakpoint
ALTER TABLE "bh_create_requests" ADD CONSTRAINT "bh_create_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bh_create_requests" ADD CONSTRAINT "bh_create_requests_bh_id_bh_docs_id_fk" FOREIGN KEY ("bh_id") REFERENCES "public"."bh_docs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER bh_create_requests_append_only
BEFORE UPDATE OR DELETE ON bh_create_requests
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER bh_create_requests_append_only_truncate
BEFORE TRUNCATE ON bh_create_requests
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();
