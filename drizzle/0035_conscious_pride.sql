CREATE TABLE "integration_checkpoints" (
	"connector" text NOT NULL,
	"stream" text NOT NULL,
	"cursor" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_run_id" integer NOT NULL,
	"last_success_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_checkpoints_connector_stream_pk" PRIMARY KEY("connector","stream"),
	CONSTRAINT "ck_integration_checkpoint_version" CHECK ("integration_checkpoints"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "integration_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"connector" text NOT NULL,
	"stream" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"cursor_start" text,
	"cursor_end" text,
	"request_scope" jsonb,
	"evidence_path" text,
	"evidence_hash" text,
	"source_rows" integer DEFAULT 0 NOT NULL,
	"staged_rows" integer DEFAULT 0 NOT NULL,
	"rejected_rows" integer DEFAULT 0 NOT NULL,
	"import_job_id" integer,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "integration_runs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ck_integration_run_status" CHECK ("integration_runs"."status" IN ('running', 'succeeded', 'failed')),
	CONSTRAINT "ck_integration_run_terminal" CHECK (("integration_runs"."status" = 'running' AND "integration_runs"."finished_at" IS NULL)
      OR ("integration_runs"."status" IN ('succeeded', 'failed') AND "integration_runs"."finished_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "integration_checkpoints" ADD CONSTRAINT "integration_checkpoints_last_run_id_integration_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."integration_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_runs" ADD CONSTRAINT "integration_runs_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_integration_runs_stream_time" ON "integration_runs" USING btree ("connector","stream","started_at");