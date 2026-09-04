ALTER TABLE "replenish_suppressions" ADD COLUMN "on_hand_baseline" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
-- C8 回填：存量抑制行没有账面在库基线。回填成 pipeline_baseline（在库 ≤ 全管道，
-- 取上界是保守选择：只会让「到货即解除」更难触发，绝不会凭空解除一条正在生效的抑制）。
UPDATE "replenish_suppressions" SET "on_hand_baseline" = "pipeline_baseline" WHERE "cleared_at" IS NULL;
