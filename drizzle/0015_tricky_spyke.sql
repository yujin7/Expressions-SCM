CREATE TABLE "sku_costs" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"note" text,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sku_costs_sku_id_unique" UNIQUE("sku_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"href" text,
	"severity" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"dedupe_key" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "uq_notify_dedupe" UNIQUE NULLS NOT DISTINCT("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "po_docs" ADD COLUMN "confirm_token" text;--> statement-breakpoint
ALTER TABLE "sku_costs" ADD CONSTRAINT "sku_costs_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_notify_status" ON "notifications" USING btree ("status","created_at");