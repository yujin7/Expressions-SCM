CREATE TABLE "job_locks" (
	"job" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"last_finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_reads" (
	"notification_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_notification_reads" PRIMARY KEY("notification_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "sop_execution_drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"cycle_id" integer NOT NULL,
	"cycle_version" integer NOT NULL,
	"bh_id" integer NOT NULL,
	"doc_no" text NOT NULL,
	"planning_version_id" integer NOT NULL,
	"plan_digest" text NOT NULL,
	"sku_ids" jsonb NOT NULL,
	"include_suppressed" boolean DEFAULT false NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_sop_execution_draft_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "uq_sop_execution_draft_bh" UNIQUE("bh_id"),
	CONSTRAINT "ck_sop_execution_draft_round" CHECK ("sop_execution_drafts"."cycle_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_execution_drafts" ADD CONSTRAINT "sop_execution_drafts_cycle_id_sop_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."sop_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_execution_drafts" ADD CONSTRAINT "sop_execution_drafts_bh_id_bh_docs_id_fk" FOREIGN KEY ("bh_id") REFERENCES "public"."bh_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_execution_drafts" ADD CONSTRAINT "sop_execution_drafts_planning_version_id_planning_versions_id_fk" FOREIGN KEY ("planning_version_id") REFERENCES "public"."planning_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_execution_drafts" ADD CONSTRAINT "sop_execution_drafts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_job_locks_lease" ON "job_locks" USING btree ("lease_until");--> statement-breakpoint
CREATE INDEX "ix_notification_reads_user" ON "notification_reads" USING btree ("user_id","notification_id");--> statement-breakpoint
CREATE INDEX "ix_sop_execution_draft_cycle" ON "sop_execution_drafts" USING btree ("cycle_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sop_agree_one_per_signer" ON "sop_decisions" USING btree ("cycle_id","cycle_version","decided_by") WHERE "sop_decisions"."decision" = 'agree';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sop_reject_one_per_role_round" ON "sop_decisions" USING btree ("cycle_id","cycle_version","role") WHERE "sop_decisions"."decision" = 'reject';--> statement-breakpoint
ALTER TABLE "qc_records" ADD CONSTRAINT "uq_qc_record_quality_case" UNIQUE("quality_case_id");--> statement-breakpoint
ALTER TABLE "qc_records" ADD CONSTRAINT "uq_qc_record_return_ct" UNIQUE("return_ct_id");
--> statement-breakpoint
/* 手写外键：在 drizzle schema 里声明会造成 docs.ts ↔ quality.ts 的模块环
   （CLAUDE.md 记录过这类环只在 next build 收集页面数据时才炸），故只在迁移里加。
   唯一键 uq_qc_record_quality_case 已由 schema 正常声明，二者配套。 */
ALTER TABLE "qc_records" ADD CONSTRAINT "fk_qc_record_quality_case" FOREIGN KEY ("quality_case_id") REFERENCES "public"."quality_cases"("id") ON DELETE no action ON UPDATE no action;
