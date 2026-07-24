import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { writeStagingRows, createImportJob } from "@/server/import/staging";
import { parseTransitWorkbook } from "@/server/import/adapters/transit";
import { releaseFinishedMoq, releaseTransitRefs, type ReleaseUser } from "@/server/modules/release/engine";
import { createTestDb, type TestDb } from "../helpers/db";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("在途参考层：解析 → 放行（整类替换）+ 起订量 → uom_convs", () => {
  let db: TestDb;
  let user: ReleaseUser;
  let skuId: number;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [u] = await db.insert(schema.users).values({ name: "放行员", roles: ["pmc"], isApprover: true }).returning();
    user = { id: u.id, name: u.name, roles: ["pmc"], isApprover: true };
    const [spu] = await db.insert(schema.spus).values({ code: "PTR01", nameCn: "在途测试品" }).returning();
    const [s] = await db
      .insert(schema.skus)
      .values({ code: "TR001-000", name: "在途SKU", spuId: spu.id, baseUom: "件", skuType: "finished" })
      .returning();
    skuId = s.id;
  });

  it("解析器：四类 sheet 归类正确，「成品」表按审批号富化跟进表", () => {
    const mk = (name: string, rows: (string | number | null)[][]) => ({ name, rows });
    const { rows, stats } = parseTransitWorkbook([
      mk("成品", [
        ["序号", "x", "订单类型", "运营下单日期", "钉钉审批号", "品牌", "商品编码", "物料名称", "OEM", "订单数量", "常规", "常规交期", "最初计划交期", "紧急需求部门", "运营需求交期", "回复1", "回复2", "预计入仓时间", "异常情况", "包材进度", "已完工数", "未交数量"],
        [1, null, "旧品", 45880, "DD001", "NING", "TR001-000", "在途SKU", "ZYT", 1000, "常规", null, null, null, null, null, null, "2026-08-01", "暂停中", "生产中", 0, 1000],
      ]),
      mk("成品跟进表", [
        ["索引列", "总订单分批", "序号", "用友订单号", "订单类型", "运营下单日期", "钉钉审批号", "品牌", "商品编码", "物料名称", "紧急标识", "紧急需求部门", "OEM", "订单数量", "已完工数", "未完工数量", "待提货", "已入库数", "未入库数", "关单数量", "订单完成率", "订单实时进度"],
        [null, null, null, "YY01", "旧品", 45880, "DD001", "NING", "TR001-000", "在途SKU", "常规", null, "ZYT", 1000, 200, 800, null, 100, 900, null, "10%", null],
        [null, null, null, null, "新品首单", 45881, "DD002", "NING", "TRUNK-999", "未建档品", "常规", null, "SF", 500, 500, 0, null, 500, 0, null, "100%", "订单已完结"],
      ]),
      mk("包材跟进表", [
        [null], [null], [null], [null], [null], [null],
        ["序号", "索引列", "类型", "首单or返单", "运营下单日期", "PMC下单日期", "采购下单日期", "用友订单号", "品牌", "飞书订单编号", "成品编码", "物料编码", "物料名称", "跟进人", "供应商", "下单数量", "回复交期", "需求交货日期", "采购回复交期", "采购二次修改", "剩余交货天数", "异常原因"],
        [null, null, "内包", "首单", 45709, 45712, 45713, null, "NING", "FS001", "TR001-000", "TR001-0201", "软管", "紫烟", "BZ", 22700, null, 45732, null, null, null, null],
      ]),
      mk("包材备货表", [
        ["运营下单日期", "品牌", "审批单号", "成品编码", "物料编码", "物料名称", "备货部门", "备货数量", "使用数量", "剩余数量", "用于成品订单号", "成品使用时间", "备注"],
        [45981, "NING", "SP001", "TR001-000", "TR001-0201", "瓶子", "电商部", 10000, 4000, 6000, null, null, null],
      ]),
      mk("OEM供应商维护", [
        ["序号", "成品编码", "成品名称", "规格", "加工厂", "开始时间", "结束时间"],
        [1, "TR001-000", "在途SKU", "100ml", "ZYT", 45623, 73050],
      ]),
    ]);
    expect(stats).toMatchObject({ fg_order: 2, pkg_order: 1, pkg_stock: 1, oem_map: 1 });
    const fg = rows.map((r) => r.payload as { kind: string; skuCode: string | null; expectDate?: string | null; exception?: string | null }).find((p) => p.kind === "fg_order" && p.skuCode === "TR001-000")!;
    expect(fg.expectDate).toBe("2026-08-01"); // 富化自「成品」表
    expect(fg.exception).toBe("暂停中");
  });

  it("放行：登记全量（含未建档 SKU）+ 整类替换 + 解析计数", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "tr-"));
    const f = path.join(tmp, "t.bin");
    writeFileSync(f, "x");
    const job = await createImportJob(db, { template: "transit", filePath: f, createdBy: user.id });
    const mkPayload = (over: Record<string, unknown>) => ({
      kind: "fg_order", brandRaw: "NING", skuCode: "TR001-000", materialCode: null, materialName: "在途SKU",
      oemRaw: "ZYT", externalNo: null, approvalNo: "DD001", feishuNo: null, orderType: "旧品",
      qty: 1000, doneQty: 200, inboundQty: 100, closedQty: null, usedQty: null, remainQty: null,
      orderDate: "2026-07-01", needDate: null, replyDate: null, revisedDate: null, expectDate: "2026-08-01",
      startDate: null, progress: null, urgentDept: null, follower: null, exception: null, extra: null, ...over,
    });
    await writeStagingRows(db, job.id, [
      { rowNo: 1, targetTable: "transit_ref", payload: mkPayload({}) },
      { rowNo: 2, targetTable: "transit_ref", payload: mkPayload({ skuCode: "TRUNK-999", approvalNo: "DD002" }) },
    ]);

    const dry = await releaseTransitRefs(user, { dryRun: true }, db);
    expect(dry.byKind.fg_order).toBe(2);
    expect(dry.skuResolved).toBe(1);
    expect(dry.skuUnresolved).toBe(1);

    const r1 = await releaseTransitRefs(user, { dryRun: false }, db);
    expect(r1.replacedOldRows).toBe(0);
    const rows1 = await db.select().from(schema.transitRefs).where(eq(schema.transitRefs.kind, "fg_order"));
    expect(rows1).toHaveLength(2);
    expect(rows1.find((r) => r.skuCode === "TR001-000")!.skuId).toBe(skuId);
    expect(rows1.find((r) => r.skuCode === "TRUNK-999")!.skuId).toBeNull(); // 参考层不丢行

    // 重导 = 整类替换（committed 行不复选，需新 job 行）
    const job2 = await createImportJob(db, { template: "transit", filePath: f, createdBy: user.id });
    await writeStagingRows(db, job2.id, [{ rowNo: 1, targetTable: "transit_ref", payload: mkPayload({ qty: 900 }) }]);
    const r2 = await releaseTransitRefs(user, { dryRun: false }, db);
    expect(r2.replacedOldRows).toBe(2);
    const rows2 = await db.select().from(schema.transitRefs).where(eq(schema.transitRefs.kind, "fg_order"));
    expect(rows2).toHaveLength(1);
    expect(rows2[0].qty).toBe("900.0000");
  });

  it("起订量放行：sku_leadtime staging → uom_convs.moq（幂等覆盖）", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "tr2-"));
    const f = path.join(tmp, "t.bin");
    writeFileSync(f, "x");
    const job = await createImportJob(db, { template: "sku_leadtime", filePath: f, createdBy: user.id });
    await writeStagingRows(db, job.id, [
      { rowNo: 1, targetTable: "sku_leadtime", payload: { source: "transit_progress", skuCode: "TR001-000", oemRaw: "ZYT", normalLeadDays: 12, urgentLeadDays: 7, moq: 1000 } },
      { rowNo: 2, targetTable: "sku_leadtime", payload: { source: "transit_progress", skuCode: "NOPE-1", oemRaw: null, normalLeadDays: null, urgentLeadDays: null, moq: 500 } },
    ]);
    const r = await releaseFinishedMoq(user, { dryRun: false }, db);
    expect(r.created).toBe(1);
    expect(r.unresolvedSku).toBe(1);
    const [conv] = await db.select().from(schema.uomConvs).where(eq(schema.uomConvs.skuId, skuId));
    expect(conv.moq).toBe("1000.0000");
    // 幂等重放（同行仍 pending——moq 放行不消费行）：覆盖不重复
    const r2 = await releaseFinishedMoq(user, { dryRun: false }, db);
    expect(r2.updated).toBe(1);
    const convs = await db.select().from(schema.uomConvs).where(eq(schema.uomConvs.skuId, skuId));
    expect(convs).toHaveLength(1);
  });
});
