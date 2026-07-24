CREATE TABLE "export_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_path" text,
	"row_count" integer,
	"error" text,
	"requested_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"ref_type" text,
	"ref_key" text,
	"title" text NOT NULL,
	"detail" text,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"decided_by" integer,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_export_status" ON "export_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ix_review_status_cat" ON "review_items" USING btree ("status","category");