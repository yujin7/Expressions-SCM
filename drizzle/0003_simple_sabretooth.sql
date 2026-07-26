ALTER TABLE "approvals" DROP CONSTRAINT "uq_approval_idem";--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "cycle" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "uq_approval_idem" UNIQUE("doc_type","doc_id","node","action","cycle");