CREATE TABLE "data_product_releases" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"contract_version" text NOT NULL,
	"target_level" text NOT NULL,
	"source_evidence_digest" text NOT NULL,
	"source_evidence" jsonb NOT NULL,
	"control_total_ref" text NOT NULL,
	"uat_ref" text NOT NULL,
	"rollback_plan" text NOT NULL,
	"scope_note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"requested_by" integer NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" integer,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"revoked_by" integer,
	"revoked_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_product_releases_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ck_data_product_release_level" CHECK ("data_product_releases"."target_level" IN ('A2', 'A3')),
	CONSTRAINT "ck_data_product_release_status" CHECK ("data_product_releases"."status" IN ('pending', 'approved', 'rejected', 'revoked')),
	CONSTRAINT "ck_data_product_release_version" CHECK ("data_product_releases"."version" > 0),
	CONSTRAINT "ck_data_product_release_decision" CHECK (("data_product_releases"."status" = 'pending' AND "data_product_releases"."decided_by" IS NULL AND "data_product_releases"."decided_at" IS NULL)
      OR ("data_product_releases"."status" IN ('approved', 'rejected', 'revoked') AND "data_product_releases"."decided_by" IS NOT NULL AND "data_product_releases"."decided_at" IS NOT NULL)),
	CONSTRAINT "ck_data_product_release_revocation" CHECK (("data_product_releases"."status" <> 'revoked' AND "data_product_releases"."revoked_by" IS NULL AND "data_product_releases"."revoked_at" IS NULL)
      OR ("data_product_releases"."status" = 'revoked' AND "data_product_releases"."revoked_by" IS NOT NULL AND "data_product_releases"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "data_product_releases" ADD CONSTRAINT "data_product_releases_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_product_releases" ADD CONSTRAINT "data_product_releases_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_product_releases" ADD CONSTRAINT "data_product_releases_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_data_product_release_product_time" ON "data_product_releases" USING btree ("product_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_data_product_release_active" ON "data_product_releases" USING btree ("product_id") WHERE "data_product_releases"."status" = 'approved';