/**
 * W2-4 异步导出通路回归门。
 *
 * 修复前的死路：
 * 1. `EXPORT_KINDS` 登记了 5 个种类，**没有一个是报表页**；
 * 2. 风险处置 / 异动侦测 / 库存分析三个页面却在 CSV 页脚写「请缩小筛选范围，或改用「导出任务」」，
 *    而 UI 里没有任何地方 POST `/api/export/jobs`——那个"导出任务"根本创建不出来；
 * 3. `ExportButton` 是 `window.open(href)`：同步导出超过 5000 行时服务端返回 202 `{jobId}`，
 *    浏览器于是把这段 JSON 当页面显示出来。
 *
 * 这里同时钉住"种类已登记且能产行"与"UI 真的接上了"。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { brands, channels, salesMonthly, skus, spus, stockBalances, users, warehouses } from "@/db/schema";
import { getSegmentation } from "@/server/modules/report/segmentation";
import { getRiskWorklist } from "@/server/modules/report/risk";
import { getDetectorAlerts } from "@/server/modules/report/detectors";
import { getInventoryAnalytics } from "@/server/modules/report/inventory-analytics";
import type { SessionUser } from "@/server/core/dto";
import { EXPORT_KINDS, SYNC_EXPORT_MAX, stripMoneyColumns } from "@/server/modules/report/export";
import { createTestDb, type TestDb } from "../helpers/db";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const HEAVY_KINDS = ["risk", "detectors", "inventory-analytics", "segmentation"] as const;

const finance: SessionUser = { id: 1, name: "财务", roles: ["finance"], isApprover: false };
const warehouse: SessionUser = { id: 2, name: "仓管", roles: ["warehouse"], isApprover: false };

async function seed(db: TestDb) {
  await db.insert(users).values({ id: 1, name: "财务", roles: ["finance"] });
  await db.insert(users).values({ id: 2, name: "仓管", roles: ["warehouse"] });
  const [brand] = await db.insert(brands).values({ code: "BR1", nameCn: "测试品牌" }).returning();
  const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
  await db
    .insert(skus)
    .values({ code: "CP00001", name: "测试成品", spuId: spu.id, brandId: brand.id, baseUom: "个", skuType: "finished" });
}

describe("W2-4 重报表异步导出通路", () => {
  it.each(HEAVY_KINDS)("%s 的完整导出不被列表500行上限截断，筛选和安全上限仍生效", async (kind) => {
    const { db, client } = await createTestDb();
    try {
      await seed(db);
      const [brand] = await db.select().from(brands);
      const [spu] = await db.select().from(spus);
      const [channel] = await db.insert(channels).values({ code: "FULL", name: "完整导出测试", kind: "platform" }).returning();
      const [wh] = await db.insert(warehouses).values({ code: "FULL", name: "测试仓", kind: "finished" }).returning();
      const items = await db.insert(skus).values(Array.from({ length: 502 }, (_, i) => ({
        code: `FULL-QA-${String(i + 1).padStart(4, "0")}`, name: "导出正样本", brandId: brand.id,
        spuId: spu.id, baseUom: "个", skuType: "finished" as const,
      }))).returning();
      await db.insert(stockBalances).values(items.map((s) => ({ skuId: s.id, warehouseId: wh.id, qty: "10000" })));
      await db.insert(salesMonthly).values(items.flatMap((s) => Array.from({ length: 6 }, (_, i) => ({
        skuId: s.id, channelId: channel.id, yearMonth: `2026-${String(i + 1).padStart(2, "0")}`,
        qty: i === 5 ? "0" : "100",
      }))));
      const query = { q: "FULL-QA-", page: 1, pageSize: 50000 };
      const list = kind === "risk" ? await getRiskWorklist(query, db)
        : kind === "detectors" ? await getDetectorAlerts(query, db)
          : kind === "inventory-analytics" ? await getInventoryAnalytics(query, db)
            : await getSegmentation(query, db);
      expect(list.total).toBe(502);
      expect(list.rows).toHaveLength(500); // HTTP列表仍有边界，不能靠放大分页上限修导出
      const full = await EXPORT_KINDS[kind].produce(finance, { q: query.q }, 50000, db);
      expect(full.total).toBe(502);
      expect(full.rows).toHaveLength(502);
      expect(new Set(full.rows.map((r) => r.code))).toEqual(new Set(items.map((s) => s.code)));
      const bounded = await EXPORT_KINDS[kind].produce(finance, { q: query.q }, 17, db);
      expect(bounded.total).toBe(502);
      expect(bounded.rows).toEqual(full.rows.slice(0, 17));
      const filtered = await EXPORT_KINDS[kind].produce(finance, { q: "FULL-QA-0502" }, 50000, db);
      expect(filtered.total).toBe(1);
      expect(filtered.rows.map((r) => r.code)).toEqual(["FULL-QA-0502"]);
    } finally {
      await client.close();
    }
  });

  it("四个重报表种类都已登记，且带中文名与参数解析器", () => {
    for (const kind of HEAVY_KINDS) {
      const def = EXPORT_KINDS[kind];
      expect(def, `${kind} 未登记 EXPORT_KINDS`).toBeTruthy();
      expect(def.nameCn.length).toBeGreaterThan(1);
      expect(typeof def.paramsFromSearch).toBe("function");
      expect(typeof def.produce).toBe("function");
    }
  });

  it("paramsFromSearch 只取自己认识的筛选键（任务参数必须 JSON 可序列化）", () => {
    const sp = new URLSearchParams({ q: "CP0", action: "报废评审", kind: "sales_stop", windowDays: "90", tier: "S" });
    expect(EXPORT_KINDS.risk.paramsFromSearch(sp)).toEqual({ q: "CP0", action: "报废评审" });
    expect(EXPORT_KINDS.detectors.paramsFromSearch(sp)).toEqual({ q: "CP0", kind: "sales_stop" });
    expect(EXPORT_KINDS["inventory-analytics"].paramsFromSearch(sp)).toEqual({ q: "CP0", windowDays: 90 });
    expect(JSON.parse(JSON.stringify(EXPORT_KINDS.segmentation.paramsFromSearch(sp)))).toMatchObject({ tier: "S" });
  });

  it("produce 能在真实库上跑通（空数据也不炸），且列定义非空", async () => {
    const { db } = await createTestDb();
    await seed(db);
    for (const kind of HEAVY_KINDS) {
      const result = await EXPORT_KINDS[kind].produce(finance, {}, SYNC_EXPORT_MAX, db);
      expect(result.columns.length, `${kind} 无列定义`).toBeGreaterThan(2);
      expect(Array.isArray(result.rows)).toBe(true);
      expect(typeof result.total).toBe("number");
    }
  });

  it("风险导出的金额列对非价格角色整列剔除（R9 含导出）", async () => {
    const { db } = await createTestDb();
    await seed(db);
    const { columns } = await EXPORT_KINDS.risk.produce(finance, {}, SYNC_EXPORT_MAX, db);
    const keys = columns.map((c) => c.key);
    expect(keys).toContain("amount");
    expect(keys).toContain("atRiskAmount");
    const stripped = stripMoneyColumns(columns, warehouse.roles).map((c) => c.key);
    expect(stripped).not.toContain("amount");
    expect(stripped).not.toContain("atRiskAmount");
    expect(stripped).toContain("nearQty"); // 数量列保留
  });

  it("库存流水导出带上批次 / 累计余额 / 来源单号，金额列可被角色剔除", async () => {
    const { db } = await createTestDb();
    await seed(db);
    const { columns } = await EXPORT_KINDS.ledger.produce(finance, {}, SYNC_EXPORT_MAX, db);
    const keys = columns.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["batchNo", "balanceQty", "sourceDocNo", "amount", "balanceAmount"]));
    expect(stripMoneyColumns(columns, warehouse.roles).map((c) => c.key)).not.toContain("balanceAmount");
  });

  it("ExportButton 不再 window.open 同步导出 URL：202 走「导出任务」提示，200 才落盘", () => {
    const src = read("src/components/ExportButton.tsx");
    expect(src).not.toMatch(/window\.open\(href/); // 这正是把 202 JSON 显示成页面的那行
    expect(src).toContain("res.status === 202");
    expect(src).toContain("URL.createObjectURL");
    expect(src).toContain("export function AsyncExportButton");
    expect(src).toContain('<ExportButton href="/api/export/jobs"');
    expect(src).not.toContain("window.open(");
  });

  it("三个印着「改用「导出任务」」的页面，现在真的有创建任务的入口", () => {
    const pages: [string, string][] = [
      ["src/app/(app)/report/risk/risk-client.tsx", 'kind="risk"'],
      ["src/app/(app)/report/detectors/detectors-client.tsx", 'kind="detectors"'],
      ["src/app/(app)/report/inventory-analytics/inventory-analytics-client.tsx", 'kind="inventory-analytics"'],
      ["src/app/(app)/report/segmentation/segmentation-client.tsx", 'kind="segmentation"'],
    ];
    for (const [file, marker] of pages) {
      const src = read(file);
      expect(src, `${file} 未引入异步导出按钮`).toContain("AsyncExportButton");
      expect(src, `${file} 未绑定导出种类`).toContain(marker);
    }
    // 页脚那句话仍在（它现在是真的），但必须与入口同时存在
    for (const [file] of pages.slice(0, 3)) {
      expect(read(file)).toContain("改用「导出任务」");
    }
  });

  it("页面绑定的每个 kind 都能在 EXPORT_KINDS 里找到（防止改名后按钮报「未知导出类型」）", () => {
    const files = [
      "src/app/(app)/report/risk/risk-client.tsx",
      "src/app/(app)/report/detectors/detectors-client.tsx",
      "src/app/(app)/report/inventory-analytics/inventory-analytics-client.tsx",
      "src/app/(app)/report/segmentation/segmentation-client.tsx",
    ];
    for (const file of files) {
      for (const match of read(file).matchAll(/<AsyncExportButton[\s\S]{0,200}?kind="([^"]+)"/g)) {
        expect(EXPORT_KINDS[match[1]], `${file} 绑定了未登记的导出种类 ${match[1]}`).toBeTruthy();
      }
    }
  });
});
