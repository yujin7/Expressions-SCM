CREATE TABLE "month_close_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"check_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"evidence" jsonb,
	"completed_by" integer,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_month_close_month_key" UNIQUE("month","check_key"),
	CONSTRAINT "ck_month_close_month" CHECK ("month_close_checks"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "ck_month_close_key" CHECK ("month_close_checks"."check_key" IN ('data_release', 'operational_docs', 'inventory_count', 'jst_reconciliation', 'borrow_reconciliation', 'settlement_close')),
	CONSTRAINT "ck_month_close_status" CHECK ("month_close_checks"."status" IN ('pending', 'completed', 'waived')),
	CONSTRAINT "ck_month_close_completion" CHECK (("month_close_checks"."status" = 'pending' AND "month_close_checks"."completed_by" IS NULL AND "month_close_checks"."completed_at" IS NULL) OR ("month_close_checks"."status" IN ('completed', 'waived') AND "month_close_checks"."completed_by" IS NOT NULL AND "month_close_checks"."completed_at" IS NOT NULL)),
	CONSTRAINT "ck_month_close_waiver_note" CHECK ("month_close_checks"."status" <> 'waived' OR length(trim(coalesce("month_close_checks"."note", ''))) > 0)
);
--> statement-breakpoint
ALTER TABLE "month_close_checks" ADD CONSTRAINT "month_close_checks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_month_close_month" ON "month_close_checks" USING btree ("month");