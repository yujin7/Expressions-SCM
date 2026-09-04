CREATE TABLE "exception_dismissals" (
	"id" serial PRIMARY KEY NOT NULL,
	"exception_key" text NOT NULL,
	"snoozed_until" date,
	"snooze_note" text,
	"snoozed_by" integer,
	"snoozed_at" timestamp with time zone,
	"first_shown_on" date,
	"last_shown_on" date,
	"consecutive_days" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exception_dismissals_exception_key_unique" UNIQUE("exception_key"),
	CONSTRAINT "ck_exception_consecutive_days_nonneg" CHECK ("exception_dismissals"."consecutive_days" >= 0)
);
--> statement-breakpoint
ALTER TABLE "exception_dismissals" ADD CONSTRAINT "exception_dismissals_snoozed_by_users_id_fk" FOREIGN KEY ("snoozed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_exception_dismissal_snooze" ON "exception_dismissals" USING btree ("snoozed_until");