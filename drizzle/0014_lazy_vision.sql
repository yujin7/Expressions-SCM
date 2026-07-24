CREATE TABLE "npd_projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sku_code" text,
	"brand" text,
	"start_date" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"remark" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "npd_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"node_no" text,
	"name" text NOT NULL,
	"stage" text,
	"dept" text,
	"days" integer DEFAULT 0 NOT NULL,
	"plan_start" date,
	"plan_end" date,
	"status" text DEFAULT 'pending' NOT NULL,
	"done_at" date,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_npd_task_seq" UNIQUE("project_id","seq")
);
--> statement-breakpoint
CREATE TABLE "sku_params" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"normal_lead_days" integer,
	"urgent_lead_days" integer,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sku_params_sku_id_unique" UNIQUE("sku_id")
);
--> statement-breakpoint
ALTER TABLE "npd_projects" ADD CONSTRAINT "npd_projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npd_tasks" ADD CONSTRAINT "npd_tasks_project_id_npd_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."npd_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_params" ADD CONSTRAINT "sku_params_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_npd_project_status" ON "npd_projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_npd_task_project" ON "npd_tasks" USING btree ("project_id","status");