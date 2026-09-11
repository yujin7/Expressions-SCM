CREATE TABLE "npd_first_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"project_version" integer NOT NULL,
	"bh_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"qty" numeric(14, 4) NOT NULL,
	"requested_by" integer NOT NULL,
	"request_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_npd_first_order_request" UNIQUE("requested_by","request_key"),
	CONSTRAINT "uq_npd_first_order_bh" UNIQUE("bh_id"),
	CONSTRAINT "ck_npd_first_order_qty" CHECK ("npd_first_orders"."qty" > 0),
	CONSTRAINT "ck_npd_first_order_version" CHECK ("npd_first_orders"."project_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "npd_projects" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "npd_first_orders" ADD CONSTRAINT "npd_first_orders_project_id_npd_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."npd_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npd_first_orders" ADD CONSTRAINT "npd_first_orders_bh_id_bh_docs_id_fk" FOREIGN KEY ("bh_id") REFERENCES "public"."bh_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npd_first_orders" ADD CONSTRAINT "npd_first_orders_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npd_first_orders" ADD CONSTRAINT "npd_first_orders_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_npd_first_order_project" ON "npd_first_orders" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "npd_projects" ADD CONSTRAINT "ck_npd_project_version" CHECK ("npd_projects"."version" > 0);
--> statement-breakpoint
CREATE TRIGGER npd_first_orders_append_only
BEFORE UPDATE OR DELETE ON npd_first_orders
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER npd_first_orders_append_only_truncate
BEFORE TRUNCATE ON npd_first_orders
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();
