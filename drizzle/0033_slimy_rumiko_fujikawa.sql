CREATE TABLE "supplier_lifecycle_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"reason" text NOT NULL,
	"due_date" date NOT NULL,
	"owner_id" integer NOT NULL,
	"pause_new_orders" boolean DEFAULT false NOT NULL,
	"supplier_status_before" text NOT NULL,
	"supplier_status_after" text NOT NULL,
	"outcome" text,
	"closure_note" text,
	"idempotency_key" text NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" integer,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_supplier_lifecycle_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "ck_supplier_lifecycle_kind" CHECK ("supplier_lifecycle_cases"."kind" IN ('admission', 'corrective')),
	CONSTRAINT "ck_supplier_lifecycle_status" CHECK ("supplier_lifecycle_cases"."status" IN ('open', 'closed')),
	CONSTRAINT "ck_supplier_lifecycle_priority" CHECK ("supplier_lifecycle_cases"."priority" IN ('normal', 'high', 'critical')),
	CONSTRAINT "ck_supplier_lifecycle_close" CHECK (("supplier_lifecycle_cases"."status" = 'open' AND "supplier_lifecycle_cases"."outcome" IS NULL AND "supplier_lifecycle_cases"."closure_note" IS NULL AND "supplier_lifecycle_cases"."closed_by" IS NULL AND "supplier_lifecycle_cases"."closed_at" IS NULL)
      OR ("supplier_lifecycle_cases"."status" = 'closed' AND "supplier_lifecycle_cases"."outcome" IS NOT NULL AND length(trim("supplier_lifecycle_cases"."closure_note")) >= 5 AND "supplier_lifecycle_cases"."closed_by" IS NOT NULL AND "supplier_lifecycle_cases"."closed_at" IS NOT NULL)),
	CONSTRAINT "ck_supplier_lifecycle_outcome" CHECK ("supplier_lifecycle_cases"."outcome" IS NULL OR "supplier_lifecycle_cases"."outcome" IN ('approved', 'rejected', 'resolved', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "supplier_lifecycle_cases" ADD CONSTRAINT "supplier_lifecycle_cases_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_lifecycle_cases" ADD CONSTRAINT "supplier_lifecycle_cases_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_lifecycle_cases" ADD CONSTRAINT "supplier_lifecycle_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_lifecycle_cases" ADD CONSTRAINT "supplier_lifecycle_cases_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_supplier_lifecycle_open_kind" ON "supplier_lifecycle_cases" USING btree ("supplier_id","kind") WHERE "supplier_lifecycle_cases"."status" = 'open';--> statement-breakpoint
CREATE INDEX "ix_supplier_lifecycle_status_due" ON "supplier_lifecycle_cases" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "ix_supplier_lifecycle_supplier_created" ON "supplier_lifecycle_cases" USING btree ("supplier_id","created_at");