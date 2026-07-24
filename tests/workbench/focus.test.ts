import { beforeAll, describe, expect, it } from "vitest";
import {
  aliasExceptions, batchStocks, boms, channels, importJobs, jgDocs, jsDocs, jsLines,
  pcDocs, pdDocs, poDocs, reconDiffs, salesMonthly, spus, skus, stagingRows,
  stockBalances, stockDocs, stockSnapshots, suppliers, users, warehouses, woDocs,
} from "@/db/schema";
import { getWorkbenchFocus, type FocusSection } from "@/server/modules/workbench/focus";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * 工作台角色聚焦：每个数字必须是真实查询（Round-3 doctrine，禁止假零）。
 * 口径对齐：可销天数与驾驶舱一致（全网在库 ÷ 近3月日均销，91 天）；
 * 今日出入库=Asia/Shanghai 日界内 completed 的 stock_docs。
 */
describe("工作台角色聚焦 getWorkbenchFocus", () => {
  let db: TestDb;

  function metric(sections: FocusSection[], role: string, key: string) {
    const sec = sections.find((s) => s.role === role);
    expect(sec, `缺少 ${role} 区块`).toBeTruthy();
    const m = sec!.metrics.find((x) => x.key === key);
    expect(m, `缺少指标 ${role}.${key}`).toBeTruthy();
    return m!;
  }

  beforeAll(async () => {
    ({ db } = await createTestDb());

    const [admin] = await db.insert(users).values({ name: "管理员", roles: ["admin"], isApprover: true }).returning();
    const uid = admin.id;

    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
    const [skuFin] = await db
      .insert(skus)
      .values({ code: "CP00001", name: "成品A", spuId: spu.id, baseUom: "盒", skuType: "finished" })
      .returning();
    const [skuRaw] = await db
      .insert(skus)
      .values({ code: "YL00001", name: "原料B", spuId: spu.id, baseUom: "kg", skuType: "raw" })
      .returning();
    const [skuFin2] = await db
      .insert(skus)
      .values({ code: "CP00002", name: "成品C", spuId: spu.id, baseUom: "盒", skuType: "finished" })
      .returning();

    const [whFin] = await db.insert(warehouses).values({ code: "WH1", name: "成品仓", kind: "finished" }).returning();
    const [whSnap] = await db
      .insert(warehouses)
      .values({ code: "WHS", name: "云仓", kind: "snapshot", accountingMode: "snapshot" })
      .returning();

    /* ── 仓管：今日 completed 1 单；pending 2 单（其一 subtype=opening 供财务）；盘点进行中 2、待审 1 ── */
    await db.insert(stockDocs).values([
      { docNo: "RK-T-1", status: "completed", subtype: "purchase_in", createdBy: uid },
      { docNo: "CK-T-1", status: "pending", subtype: "sales_out", createdBy: uid },
      { docNo: "RK-T-2", status: "pending", subtype: "opening", createdBy: uid },
      { docNo: "CK-T-9", status: "draft", subtype: "issue_out", createdBy: uid },
    ]);
    await db.insert(pdDocs).values([
      { docNo: "PD-T-1", status: "draft", warehouseId: whFin.id, createdBy: uid },
      { docNo: "PD-T-2", status: "pending", warehouseId: whFin.id, createdBy: uid },
      { docNo: "PD-T-3", status: "completed", warehouseId: whFin.id, createdBy: uid },
    ]);

    /* ── 采购：PO approved 1 / in_progress 1 / draft 1；PC pending 今日 1 + 8 天前 approved 1 ── */
    const [sup] = await db.insert(suppliers).values({ code: "S001", name: "供应商甲" }).returning();
    await db.insert(poDocs).values([
      { docNo: "PO-T-1", status: "approved", supplierId: sup.id, createdBy: uid },
      { docNo: "PO-T-2", status: "in_progress", supplierId: sup.id, createdBy: uid },
      { docNo: "PO-T-3", status: "draft", supplierId: sup.id, createdBy: uid },
    ]);
    await db.insert(pcDocs).values([
      {
        docNo: "PC-T-1", status: "pending", target: "po_line", oldPrice: "10.00", newPrice: "12.00",
        deviationPct: "20.00", scope: "unreceived_only", createdBy: uid,
      },
      {
        docNo: "PC-T-2", status: "approved", target: "po_line", oldPrice: "10.00", newPrice: "11.00",
        deviationPct: "10.00", scope: "unreceived_only", createdBy: uid,
        createdAt: new Date(Date.now() - 8 * 86_400_000),
      },
    ]);

    /* ── PMC：成品A 在库 10、近3月销 910（日均10 → 1 天 <30 计入）；
       原料B 同参数但 skuType=raw 不计；成品C 快照仓 10000 覆盖充足不计 ── */
    const [ch] = await db.insert(channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
    await db.insert(stockBalances).values([
      { skuId: skuFin.id, warehouseId: whFin.id, batchId: null, qty: "10" },
      { skuId: skuRaw.id, warehouseId: whFin.id, batchId: null, qty: "10" },
    ]);
    await db.insert(stockSnapshots).values([
      { warehouseId: whSnap.id, skuId: skuFin2.id, bizDate: "2026-07-01", qty: "99" },
      { warehouseId: whSnap.id, skuId: skuFin2.id, bizDate: "2026-07-20", qty: "10000" }, // 取最新
    ]);
    await db.insert(salesMonthly).values([
      { skuId: skuFin.id, channelId: ch.id, yearMonth: "2026-06", qty: "910" },
      { skuId: skuRaw.id, channelId: ch.id, yearMonth: "2026-06", qty: "910" },
      { skuId: skuFin2.id, channelId: ch.id, yearMonth: "2026-06", qty: "300" },
    ]);
    const [job] = await db.insert(importJobs).values({ template: "sales", filename: "t.xlsx", createdBy: uid }).returning();
    await db.insert(stagingRows).values([
      { importJobId: job.id, rowNo: 1, payload: {}, status: "pending", errorMsg: "渠道无法解析" },
      { importJobId: job.id, rowNo: 2, payload: {}, status: "pending", errorMsg: null },
      { importJobId: job.id, rowNo: 3, payload: {}, status: "committed", errorMsg: "历史错误" },
    ]);
    await db.insert(aliasExceptions).values([
      { aliasType: "channel", rawValue: "抖音直播", status: "open" },
      { aliasType: "channel", rawValue: "旧渠道", status: "resolved" },
    ]);

    /* ── 财务：JS pending 且含负实际损耗行（结余未确认）；recon open 2 条 ── */
    const [bom] = await db.insert(boms).values({ productSkuId: skuFin.id, versionNo: "V1", status: "active" }).returning();
    const [wo] = await db
      .insert(woDocs)
      .values({
        docNo: "WO-T-1", status: "completed", productSkuId: skuFin.id, qty: "100",
        supplierId: sup.id, feeRatePlan: "2.00", bomId: bom.id, createdBy: uid,
      })
      .returning();
    const [jg] = await db
      .insert(jgDocs)
      .values({
        docNo: "JG-T-1", status: "completed", woId: wo.id, supplierId: sup.id,
        productSkuId: skuFin.id, qty: "100", feeRateCurrent: "2.00", createdBy: uid,
      })
      .returning();
    const [js] = await db
      .insert(jsDocs)
      .values({
        docNo: "JS-T-1", status: "pending", jgId: jg.id, goodQty: "100",
        feePayable: "200.00", settleAmount: "200.00", createdBy: uid,
      })
      .returning();
    await db.insert(jsLines).values({
      jsId: js.id, materialSkuId: skuRaw.id, issuedQty: "100", stdQty: "98",
      allowedLoss: "2", actualLoss: "-2", excessLoss: "0",
    });
    await db.insert(reconDiffs).values([
      { bizDate: "2026-07-23", skuId: skuFin.id, sysQty: "10", jstQty: "8", diffQty: "2", status: "open" },
      { bizDate: "2026-07-23", skuId: skuRaw.id, sysQty: "5", jstQty: "4", diffQty: "1", status: "open" },
      { bizDate: "2026-07-22", skuId: skuFin.id, sysQty: "9", jstQty: "9", diffQty: "0", status: "explained" },
    ]);

    /* ── 运营：近效期（90 天内含已到期、qty>0）2 批 ── */
    const today = new Date();
    const d = (offset: number) => {
      const x = new Date(today.getTime() + offset * 86_400_000);
      return x.toISOString().slice(0, 10);
    };
    await db.insert(batchStocks).values([
      { skuId: skuFin.id, warehouseId: whFin.id, batchNo: "B1", expiryDate: d(30), qty: "5", stocktakeDate: "2026-07-01" },
      { skuId: skuFin.id, warehouseId: whFin.id, batchNo: "B2", expiryDate: d(-5), qty: "3", stocktakeDate: "2026-07-01" },
      { skuId: skuFin.id, warehouseId: whFin.id, batchNo: "B3", expiryDate: d(200), qty: "7", stocktakeDate: "2026-07-01" },
      { skuId: skuFin.id, warehouseId: whFin.id, batchNo: "B4", expiryDate: d(10), qty: "0", stocktakeDate: "2026-07-01" },
    ]);
  });

  it("仓管+采购双角色：两个区块、真实计数、可点击 href", async () => {
    const { sections } = await getWorkbenchFocus(["warehouse", "purchasing"], db);
    expect(sections.map((s) => s.role)).toEqual(["warehouse", "purchasing"]);

    expect(metric(sections, "warehouse", "docsToday").value).toBe(1); // 仅今日 completed
    expect(metric(sections, "warehouse", "pendingStockDocs")).toMatchObject({ value: 2, href: "/inventory/docs?status=pending" });
    expect(metric(sections, "warehouse", "countTasks").value).toBe(2); // draft+pending，completed 不计

    expect(metric(sections, "purchasing", "poAwaitConfirm")).toMatchObject({ value: 1, href: "/outsource/po?status=approved" });
    expect(metric(sections, "purchasing", "poInProgress").value).toBe(1);
    expect(metric(sections, "purchasing", "pcPending").value).toBe(1);
    expect(metric(sections, "purchasing", "pcLast7d").value).toBe(1); // 8 天前的不计
    for (const s of sections) for (const m of s.metrics) expect(m.href).toMatch(/^\//);
  });

  it("财务：期初/盘点/结算待审批 + 对账差异 + 结余未确认", async () => {
    const { sections } = await getWorkbenchFocus(["finance"], db);
    expect(sections).toHaveLength(1);
    expect(metric(sections, "finance", "openingPending").value).toBe(1); // 仅 subtype=opening 的 pending
    expect(metric(sections, "finance", "countPending").value).toBe(1);
    expect(metric(sections, "finance", "jsPending").value).toBe(1);
    expect(metric(sections, "finance", "reconOpen")).toMatchObject({ value: 2, href: "/jobs/recon" });
    expect(metric(sections, "finance", "jsSurplusUnacked").value).toBe(1); // 负实际损耗行
  });

  it("PMC：可销天数<30 仅统计成品（快照仓取最新快照）；放行阻塞/别名待认领", async () => {
    const { sections } = await getWorkbenchFocus(["pmc"], db);
    // 成品A：10 ÷ (910/91)=1 天 <30 计入；原料B 同数据但非成品不计；成品C 快照 10000 覆盖充足不计
    expect(metric(sections, "pmc", "lowCoverSkus")).toMatchObject({ value: 1, href: "/replenish" });
    expect(metric(sections, "pmc", "blockedStaging").value).toBe(1); // pending+errorMsg；committed 的历史错误不计
    expect(metric(sections, "pmc", "aliasOpen").value).toBe(1);
  });

  it("运营：近效期批次（90 天内、qty>0，含已到期）+ 驾驶舱链接卡", async () => {
    const { sections } = await getWorkbenchFocus(["ops"], db);
    expect(metric(sections, "ops", "nearExpiryBatches").value).toBe(2);
    const dash = metric(sections, "ops", "dashboard");
    expect(dash.value).toBeNull();
    expect(dash.href).toBe("/report/dashboard");
  });

  it("admin 全量可见 5 区块；无角色用户 0 区块", async () => {
    const all = await getWorkbenchFocus(["admin"], db);
    expect(all.sections).toHaveLength(5);
    const none = await getWorkbenchFocus([], db);
    expect(none.sections).toHaveLength(0);
  });
});
