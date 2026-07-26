ALTER TABLE "stock_snapshots" ADD COLUMN "import_job_id" integer;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "source_as_of" date;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "schema_version" text DEFAULT 'staging-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "scope" jsonb;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "control_rows" integer;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "control_qty" numeric(18, 4);--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "release_manifest" jsonb;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stock_snapshots" ADD CONSTRAINT "stock_snapshots_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_snapshot_import_job" ON "stock_snapshots" USING btree ("import_job_id");