ALTER TYPE "public"."import_status" ADD VALUE 'superseded';--> statement-breakpoint
-- RT4-F7 前置去重：既有数据中同自然键多行 → 数量合并到最早一行，其余删除
-- （效期导入同期同效期两笔实物合并为一行是口径内行为；staging targetId 指向的行若被删，
--   参考层语义不受影响——batch_stocks 本就是只读参考层，非账本。）
WITH ranked AS (
  SELECT id,
         SUM(qty) OVER (PARTITION BY sku_id, warehouse_id, stocktake_date, prod_date, expiry_date, batch_no) AS total_qty,
         ROW_NUMBER() OVER (PARTITION BY sku_id, warehouse_id, stocktake_date, prod_date, expiry_date, batch_no ORDER BY id) AS rn
  FROM "batch_stocks"
)
UPDATE "batch_stocks" b SET qty = r.total_qty
FROM ranked r WHERE b.id = r.id AND r.rn = 1;--> statement-breakpoint
DELETE FROM "batch_stocks" WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY sku_id, warehouse_id, stocktake_date, prod_date, expiry_date, batch_no ORDER BY id) AS rn
    FROM "batch_stocks"
  ) t WHERE t.rn > 1
);--> statement-breakpoint
ALTER TABLE "batch_stocks" ADD CONSTRAINT "uq_batch_stock_key" UNIQUE NULLS NOT DISTINCT("sku_id","warehouse_id","stocktake_date","prod_date","expiry_date","batch_no");
