CREATE TABLE "period_locks" (
	"id" serial PRIMARY KEY NOT NULL,
	"period" text NOT NULL,
	"closed_by" integer NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"close_note" text,
	"reopened_by" integer,
	"reopened_at" timestamp with time zone,
	"reopen_reason" text,
	CONSTRAINT "period_locks_period_unique" UNIQUE("period"),
	CONSTRAINT "ck_period_lock_period" CHECK ("period_locks"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "ck_period_lock_reopen" CHECK (("period_locks"."reopened_at" IS NULL AND "period_locks"."reopened_by" IS NULL AND "period_locks"."reopen_reason" IS NULL) OR ("period_locks"."reopened_at" IS NOT NULL AND "period_locks"."reopened_by" IS NOT NULL AND length(trim(coalesce("period_locks"."reopen_reason", ''))) > 0))
);
--> statement-breakpoint
ALTER TABLE "period_locks" ADD CONSTRAINT "period_locks_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_locks" ADD CONSTRAINT "period_locks_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;