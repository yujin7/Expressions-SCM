CREATE TABLE "workbench_visits" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"baseline_at" timestamp with time zone DEFAULT now() NOT NULL,
	"baseline_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workbench_visits_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "workbench_visits" ADD CONSTRAINT "workbench_visits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_workbench_visit_user" ON "workbench_visits" USING btree ("user_id");