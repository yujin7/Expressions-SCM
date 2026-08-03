/**
 * 条码缺口工作清单：按「未归属销售额」倒序列出最该补条码的平台商品。
 *
 * `npm run jdy:barcode-gap`
 *
 * 为什么需要它（2026-08-04 实测）：平台销量要靠**条码**才能落到系统 SKU
 * （商家编码是另一套命名空间，实测 0 命中；且条码归一化额外命中也是 0，
 * 说明对不上的是主档里根本没录，程序救不回来）。当前只有约 72 个 SKU 能对上，
 * 天猫销量里仅 24% 的成交额可归属。
 *
 * 但"去补几千个条码"没人做得下去。本清单把它变成可执行的事：
 * **按未归属成交额倒序**列出平台商品，补最上面的若干个就能覆盖大部分金额。
 *
 * 只读：不写任何数据；输出不含消费者信息，只有商品与金额。
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

import { jiandaoyunConfigFromEnv } from "../src/server/integrations/jiandaoyun";

const config = jiandaoyunConfigFromEnv();
if (!config) {
  console.error("简道云配置不完整（缺 JIANDAOYUN_API_KEY / BASE_URL）");
  process.exit(1);
}

const APP = "699ebeac318154b4f6d3dda6";
const SALES = "69a79b2c29154c9870ddaf00";     // Tmall_C.01_dd_SKU_整体
const CROSSWALK = "69a7aca01406712eef7abdba"; // Tmall_X.02_SKU详情列表
const TOP = Number(process.argv[2] ?? 40);

async function post(body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${config!.baseUrl}/app/entry/data/list`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config!.apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function pull(entryId: string, maxPages: number): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const body: Record<string, unknown> = { app_id: APP, entry_id: entryId, limit: 100 };
    if (cursor) body.data_id = cursor;
    const res = await post(body);
    const rows = (res.data ?? []) as Record<string, unknown>[];
    if (rows.length === 0) break;
    out.push(...rows);
    if (rows.length < 100) break;
    cursor = String(rows[rows.length - 1]._id ?? "");
    if (!cursor) break;
  }
  return out;
}

const text = (v: unknown): string => String(v ?? "").trim();

async function main(): Promise<void> {
  console.log("拉取天猫 SKU 对照与日销量…（只读）\n");
  const crosswalk = await pull(CROSSWALK, 60);
  const sales = await pull(SALES, 200);

  /** 平台 SKU → 是否已有条码 */
  const hasBarcode = new Map<string, boolean>();
  const nameOf = new Map<string, string>();
  for (const row of crosswalk) {
    const sku = text(row.sku_id);
    if (!sku) continue;
    hasBarcode.set(sku, text(row.bar_code) !== "");
    const spec = text(row.net_content);
    if (spec) nameOf.set(sku, spec);
  }

  /** 按平台 SKU 汇总支付金额；只统计"对照表里明确没条码"的 */
  const gap = new Map<string, { amount: number; name: string; shop: string }>();
  let totalAmount = 0;
  let gapAmount = 0;
  for (const row of sales) {
    const sku = text(row.sku_id);
    const amount = Number(row.paid_amount ?? 0) || 0;
    totalAmount += amount;
    if (!sku || hasBarcode.get(sku) !== false) continue;
    gapAmount += amount;
    const prev = gap.get(sku);
    const name = text(row.sku_name) || nameOf.get(sku) || "";
    const shop = text(row.shop_name);
    if (prev) prev.amount += amount;
    else gap.set(sku, { amount, name: `${text(row.product_name)} / ${name}`.slice(0, 46), shop });
  }

  const ranked = [...gap.entries()].sort((a, b) => b[1].amount - a[1].amount);
  const pct = totalAmount ? Math.round((gapAmount / totalAmount) * 100) : 0;

  console.log(`销量行 ${sales.length}，对照 ${crosswalk.length} 行`);
  console.log(`缺条码的平台 SKU：${ranked.length} 个，涉及支付金额 ${Math.round(gapAmount)}（占样本 ${pct}%）\n`);
  console.log(`═══ 最该补条码的前 ${Math.min(TOP, ranked.length)} 个（按未归属金额倒序）═══`);

  let cumulative = 0;
  ranked.slice(0, TOP).forEach(([sku, info], index) => {
    cumulative += info.amount;
    const share = gapAmount ? Math.round((cumulative / gapAmount) * 100) : 0;
    console.log(
      `${String(index + 1).padStart(3)}. ¥${String(Math.round(info.amount)).padStart(9)}  `
      + `累计 ${String(share).padStart(3)}%  SKU ${sku}  ${info.shop}  ${info.name}`,
    );
  });
  console.log(
    `\n补完上面 ${Math.min(TOP, ranked.length)} 个，可覆盖缺口金额的 `
    + `${gapAmount ? Math.round((cumulative / gapAmount) * 100) : 0}%。`,
  );
  console.log("补法：在天猫后台给这些 SKU 填商品条形码，并确认主档同款也有同一条码。\n");
}
void main().catch((error) => {
  console.error("失败：", (error as Error).message.slice(0, 300));
  process.exit(1);
});
