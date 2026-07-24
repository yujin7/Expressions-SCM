CREATE TABLE "error_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"error_id" text NOT NULL,
	"path" text,
	"method" text,
	"user_id" integer,
	"message" text NOT NULL,
	"stack" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"ok" boolean NOT NULL,
	"message" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jg_docs" DROP CONSTRAINT "uq_jg_wo";--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "parent_id" integer;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD COLUMN "batch_seq" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_error_logs_time" ON "error_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ix_job_runs" ON "job_runs" USING btree ("job","finished_at");--> statement-breakpoint
ALTER TABLE "jg_docs" ADD CONSTRAINT "uq_jg_wo_batch" UNIQUE("wo_id","batch_seq");