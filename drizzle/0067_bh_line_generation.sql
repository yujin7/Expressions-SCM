CREATE TABLE "bh_wo_generations" (
	"id" serial PRIMARY KEY NOT NULL,
	"bh_line_id" integer NOT NULL,
	"source_version" integer NOT NULL,
	"wo_id" integer NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_bh_wo_generation_line" UNIQUE("bh_line_id"),
	CONSTRAINT "uq_bh_wo_generation_wo" UNIQUE("wo_id"),
	CONSTRAINT "ck_bh_wo_generation_version" CHECK ("bh_wo_generations"."source_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "bh_wo_generations" ADD CONSTRAINT "bh_wo_generations_bh_line_id_bh_lines_id_fk" FOREIGN KEY ("bh_line_id") REFERENCES "public"."bh_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bh_wo_generations" ADD CONSTRAINT "bh_wo_generations_wo_id_wo_docs_id_fk" FOREIGN KEY ("wo_id") REFERENCES "public"."wo_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bh_wo_generations" ADD CONSTRAINT "bh_wo_generations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER bh_wo_generations_append_only
BEFORE UPDATE OR DELETE ON bh_wo_generations
FOR EACH ROW EXECUTE FUNCTION reject_immutable_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER bh_wo_generations_append_only_truncate
BEFORE TRUNCATE ON bh_wo_generations
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_fact_mutation();
