CREATE TABLE "integration_record_deletions" (
	"id" serial PRIMARY KEY NOT NULL,
	"connector" text NOT NULL,
	"stream" text NOT NULL,
	"source_record_id" text NOT NULL,
	"observed_in_job_id" integer NOT NULL,
	"reason" text NOT NULL,
	"acked_by" integer NOT NULL,
	"acked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_integration_record_deletion_reason" CHECK (length(btrim("integration_record_deletions"."reason")) >= 4)
);
--> statement-breakpoint
ALTER TABLE "integration_record_deletions" ADD CONSTRAINT "integration_record_deletions_observed_in_job_id_import_jobs_id_fk" FOREIGN KEY ("observed_in_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_record_deletions" ADD CONSTRAINT "integration_record_deletions_acked_by_users_id_fk" FOREIGN KEY ("acked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_integration_record_deletion" ON "integration_record_deletions" USING btree ("connector","stream","source_record_id");--> statement-breakpoint
CREATE INDEX "ix_integration_record_deletion_stream" ON "integration_record_deletions" USING btree ("connector","stream");