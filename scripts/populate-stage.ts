/**
 * 数据填充 · 阶段0-1（业主 2026-07-24 授权代决后执行）：
 *  0) 六适配器对真实文件入 staging（dev 库）
 *  1) 仓库/供应商主档创建 + 确定性别名自动认领（规则见 CURRENT.md 代决记录）
 * 运行（须先停 dev server——PGlite 单进程）：npx tsx scripts/populate-stage.ts
 */
import { createHash } from "node:crypto";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { and, eq } from "drizzle-orm";
import { claimAlias } from "../src/server/modules/dimension/resolver";
import { stageBom } from "../src/server/import/adapters/bom";
import { stageInventoryLong } from "../src/server/import/adapters/inventory-long";
import { stageExpiry } from "../src/server/import/adapters/expiry";
import { stageSalesMonthly } from "../src/server/import/adapters/sales-monthly";
import { stageLeadtime } from "../src/server/import/adapters/leadtime";

const FILES = {
  bom: [
    ["/Users/yj/Downloads/【NING】产品bom表.xlsx", "NING"],
    ["/Users/yj/Downloads/【EXPRESSIONS】产品bom表.xlsx", "EXP"],
    ["/Users/yj/Downloads/【DEVIANCE】产品bom表.xlsx", "DEV"],
  ] as const,
  inventory: "/Users/yj/Downloads/电商部库存明细26-7-21.xlsx",
  expiry: "/Users/yj/Downloads/7月电商组效期占比情况-仅数量.xlsx",
  sales: "/Users/yj/Downloads/26年产品销量汇总（6月）.xlsx",
  leadtime2: "/Users/yj/Downloads/2026年成品在途订单实时进度表---新版.xlsx",
};

/** 仓库判型规则（D12/D20 代决）：1仓2仓渠道子桶 → 合并自有实时仓；其余电商/保税/云 → 快照仓 */
function classifyWarehouse(raw: string): { code: string; name: string; kind: "finished" | "snapshot"; mode: "realtime" | "snapshot"; merged?: boolean } | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.includes("1仓2仓") || t === "1仓(广州)" || t === "1仓（广州）") {
    return { code: "WH-OWN", name: "自有仓（1仓2仓合并口径）", kind: "finished", mode: "realtime", merged: true };
  }
  // RT4-F4：全量 md5 前 10 位——此前取 utf8 hex 前 10 字符（≈1.7 个汉字），
  // 「天猫保税仓/天猫国际仓」这类同前缀异仓会静默合并且别名固化错绑
  const digest = createHash("md5").update(t).digest("hex").slice(0, 10).toUpperCase();
  return { code: "WH-SNAP-" + digest, name: t, kind: "snapshot", mode: "snapshot" };
}

async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  const [admin] = await db.select().from(schema.users).where(eq(schema.users.username, "admin"));
  if (!admin) throw new Error("admin 用户不存在——先跑 db:seed");
  const uid = admin.id;
  const summary: Record<string, unknown> = {};

  // ── 阶段0：staging ──
  for (const [file, brand] of FILES.bom) {
    const r = await stageBom(db, file, brand, uid);
    summary[`bom:${brand}`] = { jobId: r.jobId, stagedRows: r.stagedRows };
  }
  summary["inventory"] = (await stageInventoryLong(db, FILES.inventory, uid)).stats;
  summary["expiry"] = (await stageExpiry(db, FILES.expiry, uid)).stats;
  summary["sales"] = (await stageSalesMonthly(db, FILES.sales, uid)).stats;
  summary["leadtime:sales"] = (await stageLeadtime(db, FILES.sales, uid)).stats;
  summary["leadtime:transit"] = (await stageLeadtime(db, FILES.leadtime2, uid)).stats;

  // ── 阶段1a：仓库创建 + 认领 ──
  const whExc = await db
    .select()
    .from(schema.aliasExceptions)
    .where(and(eq(schema.aliasExceptions.aliasType, "warehouse"), eq(schema.aliasExceptions.status, "open")));
  let whCreated = 0, whClaimed = 0;
  for (const exc of whExc) {
    const cls = classifyWarehouse(exc.rawValue);
    if (!cls) continue;
    let [wh] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.code, cls.code));
    if (!wh) {
      [wh] = await db
        .insert(schema.warehouses)
        .values({ code: cls.code, name: cls.name, kind: cls.kind, accountingMode: cls.mode })
        .returning();
      whCreated++;
    }
    await claimAlias(db, { aliasType: "warehouse", rawValue: exc.rawValue, targetId: wh.id, userId: uid });
    whClaimed++;
  }
  summary["warehouses"] = { created: whCreated, claimed: whClaimed };

  // ── 阶段1b：OEM 供应商创建 + 认领 ──
  const oemExc = await db
    .select()
    .from(schema.aliasExceptions)
    .where(and(eq(schema.aliasExceptions.aliasType, "supplier_oem"), eq(schema.aliasExceptions.status, "open")));
  let supCreated = 0, supClaimed = 0;
  for (const exc of oemExc) {
    const codeRaw = exc.rawValue.trim();
    if (!codeRaw || codeRaw === "/" || codeRaw === "待定") continue; // 垃圾值维持 open（后续人工忽略）
    const code = "OEM-" + codeRaw.replace(/[^\w一-龥-]/g, "").slice(0, 20);
    let [sup] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.code, code));
    if (!sup) {
      [sup] = await db
        .insert(schema.suppliers)
        .values({ code, name: `${codeRaw}（OEM，全称待补）`, shortName: codeRaw, kinds: ["processor"], status: "qualified" })
        .returning();
      supCreated++;
    }
    await claimAlias(db, { aliasType: "supplier_oem", rawValue: exc.rawValue, targetId: sup.id, userId: uid });
    supClaimed++;
  }
  summary["suppliers"] = { created: supCreated, claimed: supClaimed };

  // ── 阶段1c：渠道别名认领（最优判断映射） ──
  const CH_MAP: Record<string, string> = {
    "抖音运营部": "douyin", "抖音": "douyin", "商品卡": "douyin",
    "北美TK": "overseas", "TK": "overseas", "亚马逊": "overseas", "速卖通": "overseas", "跨境": "overseas",
    "唯品": "vip", "多多": "pdd", "商务达播": "biz", "品牌": "brand", "用户运营部": "private",
  };
  const chans = await db.select().from(schema.channels);
  const chByCode = new Map(chans.map((c) => [c.code, c.id]));
  const chExc = await db
    .select()
    .from(schema.aliasExceptions)
    .where(and(eq(schema.aliasExceptions.aliasType, "channel"), eq(schema.aliasExceptions.status, "open")));
  let chClaimed = 0;
  for (const exc of chExc) {
    const hit = Object.entries(CH_MAP).find(([k]) => exc.rawValue.includes(k));
    const direct = chans.find((c) => exc.rawValue === c.name || exc.rawValue.includes(c.name));
    const target = direct?.id ?? (hit ? chByCode.get(hit[1]) : undefined);
    if (!target) continue;
    await claimAlias(db, { aliasType: "channel", rawValue: exc.rawValue, targetId: target, userId: uid });
    chClaimed++;
  }
  summary["channels"] = { claimed: chClaimed, open: chExc.length - chClaimed };

  console.log(JSON.stringify(summary, null, 2));
}

void main();
