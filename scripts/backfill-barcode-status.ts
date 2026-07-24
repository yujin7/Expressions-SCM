/**
 * 条码校验状态回填（04 §3 裁决：畸形值存原值+校验状态列；合规审计补落）。
 * 规则：null→null；非 13 位数字→malformed；EAN-13 校验位错→malformed；
 *      同码多 SKU→duplicate（全组标记）；其余→valid。
 * 运行（须停 dev server）：npx tsx scripts/backfill-barcode-status.ts
 */
import { eq, isNotNull } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";

function ean13Valid(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  const rows: { id: number; barcode: string | null }[] = await db
    .select({ id: schema.skus.id, barcode: schema.skus.barcode })
    .from(schema.skus)
    .where(isNotNull(schema.skus.barcode));
  const byCode = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.barcode) continue;
    const arr = byCode.get(r.barcode) ?? [];
    arr.push(r.id);
    byCode.set(r.barcode, arr);
  }
  let valid = 0, malformed = 0, duplicate = 0;
  for (const [code, ids] of byCode) {
    const status = ids.length > 1 ? "duplicate" : ean13Valid(code) ? "valid" : "malformed";
    if (status === "duplicate") duplicate += ids.length;
    else if (status === "valid") valid++;
    else malformed++;
    for (const id of ids) {
      await db.update(schema.skus).set({ barcodeStatus: status }).where(eq(schema.skus.id, id));
    }
  }
  console.log(JSON.stringify({ withBarcode: rows.length, valid, malformed, duplicateRows: duplicate }));
}

void main();
