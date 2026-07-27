import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  approvalConfigs, auditLogs, bomLines, boms, jgDocs, jgFeeSegments, pcDocs,
  poDocs, poLines, priceLists, skus, spus, stockBalances, suppliers, sysParams,
  uomConvs, users, warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { approveBh, createBh, getBh, listBhs, submitBh } from "@/server/modules/outsource/bh";
import { approveWo, createWo, generateDocs, getWo, submitWo } from "@/server/modules/outsource/wo";
import { approvePc, approvePo, confirmPo, getPo, listPcs, submitPo } from "@/server/modules/outsource/po";
import { approveJg, confirmJg, createPcForJgFee, getJg, submitJg } from "@/server/modules/outsource/jg";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * W3 委外链集成测试：BH→WO(快照)→PO+JG→R1/PC→审批/确认。
 * 种子与 src/db/seed.ts 同口径：BOM(YL 0.05/2%、BC 10/5%)、价格表 YL=120/BC=0.45、
 * uom_convs YL{25,moq50,倍25} BC{1000,倍1000}、容差 3%。
 */
describe("委外链 W3：BH→WO→PO+JG（R1 价格异动 / R11 建议量 / 审批 SoD / 审计）", () => {
  let db: TestDb;
  let opsCreator: SessionUser; // 运营制单（BH）
  let pmcCreator: SessionUser; // PMC 制单（WO/生成 PO+JG）
  let pmcApprover: SessionUser; // PMC 审批人（bh/wo/jg）
  let purchasingUser: SessionUser; // 采购提交（PO）
  let purchasingApprover: SessionUser; // 采购审批人（po/pc）
  let admin: SessionUser;

  let cp1 = 0; // 成品（有生效 BOM）
  let cp2 = 0; // 成品（无 BOM）
  let yl = 0; // 原料
  let bc = 0; // 包材
  let bc2 = 0; // 包材（首购：无任何基准价）
  let supA = 0; // 物料供应商
  let supB = 0; // 供应商（预置在途 PO 用）
  let supProc = 0; // 加工厂
  let supBlack = 0; // 黑名单供应商

  // 跨用例共享（it 顺序执行）
  let wo1 = 0;
  let po1 = 0;
  let jg1 = 0;
  let jg1DocNo = "";

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mkUser = async (name: string, roles: string[], isApprover: boolean): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover }).returning();
      return { id: u.id, name: u.name, roles, isApprover };
    };
    opsCreator = await mkUser("运营制单", ["ops"], false);
    pmcCreator = await mkUser("PMC制单", ["pmc"], false);
    pmcApprover = await mkUser("PMC审批", ["pmc"], true);
    purchasingUser = await mkUser("采购员", ["purchasing"], false);
    purchasingApprover = await mkUser("采购审批", ["purchasing"], true);
    admin = await mkUser("管理员", ["admin"], true);

    await db.insert(approvalConfigs).values([
      { docType: "bh", approverRole: "pmc" },
      { docType: "wo", approverRole: "pmc" },
      { docType: "jg", approverRole: "pmc" },
      { docType: "po", approverRole: "purchasing" },
      { docType: "pc", approverRole: "purchasing" },
    ]);
    await db.insert(sysParams).values({ scope: "global", key: "price_tolerance_pct", value: "3" });

    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
    const mkSku = async (code: string, name: string, skuType: "finished" | "raw" | "packaging", baseUom: string) => {
      const [s] = await db.insert(skus).values({ code, name, spuId: spu.id, skuType, baseUom }).returning();
      return s.id;
    };
    cp1 = await mkSku("CP00001", "胶原蛋白肽饮品", "finished", "盒");
    cp2 = await mkSku("CP00002", "无BOM成品", "finished", "盒");
    yl = await mkSku("YL00001", "胶原蛋白肽粉", "raw", "kg");
    bc = await mkSku("BC00001", "瓶身50ml", "packaging", "个");
    bc2 = await mkSku("BC00002", "彩盒(首购)", "packaging", "个");

    const mkSup = async (code: string, name: string, kinds: string[], status: "qualified" | "blacklisted") => {
      const [s] = await db.insert(suppliers).values({ code, name, kinds, status }).returning();
      return s.id;
    };
    supA = await mkSup("SUP001", "原料供应商A", ["raw", "packaging"], "qualified");
    supB = await mkSup("SUP002", "包材供应商B", ["packaging"], "qualified");
    supProc = await mkSup("SUP003", "加工厂C", ["processor"], "qualified");
    supBlack = await mkSup("SUP009", "黑名单厂", ["processor"], "blacklisted");

    const [whRaw] = await db
      .insert(warehouses)
      .values({ code: "WH-YL", name: "原料仓", kind: "raw", accountingMode: "realtime" })
      .returning();
    const [whPack] = await db
      .insert(warehouses)
      .values({ code: "WH-BC", name: "包材仓", kind: "packaging", accountingMode: "realtime" })
      .returning();
    await db
      .insert(warehouses)
      .values({ code: "WH-WX", name: "委外仓C", kind: "outsource", accountingMode: "realtime", supplierId: supProc });

    // 生效 BOM：YL 0.05/损2%；BC 10/损5%
    const [bom] = await db
      .insert(boms)
      .values({ productSkuId: cp1, versionNo: "V1", status: "active", effectiveDate: "2026-01-01" })
      .returning();
    await db.insert(bomLines).values([
      { bomId: bom.id, materialSkuId: yl, qtyPer: "0.05", lossRatePct: "2" },
      { bomId: bom.id, materialSkuId: bc, qtyPer: "10", lossRatePct: "5" },
    ]);

    await db.insert(uomConvs).values([
      { skuId: yl, purchaseUom: "袋", factor: "25", moq: "50", orderMultiple: "25" },
      { skuId: bc, purchaseUom: "箱", factor: "1000", moq: null, orderMultiple: "1000" },
    ]);

    // R1 基准兜底：价格表（基础单位未税）
    await db.insert(priceLists).values([
      { skuId: yl, supplierId: supA, price: "120.00", effectiveDate: "2026-01-01" },
      { skuId: bc, supplierId: supA, price: "0.45", effectiveDate: "2026-01-01" },
    ]);

    // 快照可用库存：YL=10（原料仓）、BC=500（包材仓）；测试直插余额（应用侧仅可经过账引擎）
    await db.insert(stockBalances).values([
      { skuId: yl, warehouseId: whRaw.id, qty: "10" },
      { skuId: bc, warehouseId: whPack.id, qty: "500" },
    ]);

    // 预置在途：已审批 PO（供应商B）BC 2箱×1000−已收500 → 在途 1500
    const [seedPo] = await db
      .insert(poDocs)
      .values({ docNo: "PO-SEED-0001", status: "approved", supplierId: supB, createdBy: admin.id })
      .returning();
    await db.insert(poLines).values({
      poId: seedPo.id, skuId: bc, lineType: "packaging", purchaseUom: "箱",
      uomFactor: "1000", qty: "2", price: "500.00", taxIncluded: true, taxRatePct: "13",
      receivedQty: "500",
    });
  });

  it("1) 全链路：BH 创建/提交/审批 → WO 审批快照(毛需求/可用/在途/建议量) → 生成 PO+JG → PO 提交/审批/确认 → JG 审批/确认", async () => {
    // ---- BH ----
    const bh = await createBh(opsCreator, {
      remark: "月度备货",
      orderType: "regular",
      lines: [{ skuId: cp1, qty: "1000", expectDate: "2026-08-31" }],
    }, db);
    expect(bh.docNo.startsWith("BH-")).toBe(true);
    expect(bh.status).toBe("draft");
    const bhPending = await submitBh(opsCreator, bh.id, bh.version, db);
    expect(bhPending.status).toBe("pending");
    const bhR = await approveBh(pmcApprover, bh.id, { action: "approve", version: bhPending.version }, db);
    expect(bhR).toMatchObject({ status: "approved", idempotent: false });
    const bhDetail = await getBh(bh.id, db);
    expect(bhDetail.lines).toHaveLength(1);
    expect(bhDetail.lines[0]).toMatchObject({ skuId: cp1, qty: "1000.0000", baseUom: "盒" });
    expect(bhDetail.approvals).toHaveLength(1);
    expect(bhDetail.approvals[0]).toMatchObject({ approverName: "PMC审批", action: "approve" });
    expect((await listBhs("", { page: 1, pageSize: 10 }, db)).total).toBe(1);

    // ---- WO ----
    const wo = await createWo(pmcCreator, {
      bhId: bh.id, productSkuId: cp1, qty: "1000", supplierId: supProc,
      feeRatePlan: "2.50", orderType: "regular", dueDate: "2026-09-15",
    }, db);
    wo1 = wo.id;
    expect(wo.docNo.startsWith("WO-")).toBe(true);
    const woPending = await submitWo(pmcCreator, wo.id, wo.version, db);
    const woR = await approveWo(pmcApprover, wo.id, { action: "approve", version: woPending.version }, db);
    expect(woR).toMatchObject({ status: "approved", idempotent: false });

    // wo_line 快照（种子推算的精确值）：
    //   YL: 毛=0.05×1.02×1000=51；可用10；在途0；净41 → MOQ50 → 倍25取整=50
    //   BC: 毛=10×1.05×1000=10500；可用500；在途=2×1000−500=1500；净8500 → 倍1000向上=9000
    const woDetail = await getWo(wo.id, db);
    expect(woDetail.status).toBe("approved");
    expect(woDetail.lines).toHaveLength(2);
    expect(woDetail.lines[0]).toMatchObject({
      materialSkuId: yl, qtyPer: "0.0500", planLossRatePct: "2.00",
      grossReq: "51.0000", onHandAt: "10.0000", inTransitAt: "0.0000", suggestedQty: "50.0000",
    });
    expect(woDetail.lines[1]).toMatchObject({
      materialSkuId: bc, qtyPer: "10.0000", planLossRatePct: "5.00",
      grossReq: "10500.0000", onHandAt: "500.0000", inTransitAt: "1500.0000", suggestedQty: "9000.0000",
    });

    // ---- 生成 PO + JG ----
    const gen = await generateDocs(pmcCreator, wo.id, {
      poGroups: [{
        supplierId: supA,
        lines: [
          // 折基础单位未税：3390/1.13/25=120.00（=价格表基准，偏差0）
          { materialSkuId: yl, qty: "2", purchaseUom: "袋", uomFactor: "25", price: "3390", taxIncluded: true, taxRatePct: "13" },
          // 508.5/1.13/1000=0.45（=基准）
          { materialSkuId: bc, qty: "9", purchaseUom: "箱", uomFactor: "1000", price: "508.5" },
        ],
      }],
      jg: {},
    }, db);
    expect(gen.pos).toHaveLength(1);
    po1 = gen.pos[0].id;
    jg1 = gen.jg.id;
    jg1DocNo = gen.jg.docNo;
    expect(gen.pos[0].docNo.startsWith("PO-")).toBe(true);
    expect(gen.jg.docNo.startsWith("JG-")).toBe(true);
    expect(gen.jg.feeRateCurrent).toBe("2.50"); // = WO feeRatePlan
    expect(gen.jg.qty).toBe("1000.0000");
    expect(gen.jg.orderType).toBe("regular");

    const poDetail = await getPo(po1, db);
    expect(poDetail.lines).toHaveLength(2);
    expect(poDetail.lines[0]).toMatchObject({ skuId: yl, lineType: "raw", uomFactor: "25.0000" });
    expect(poDetail.lines[1]).toMatchObject({ skuId: bc, lineType: "packaging" });

    const segs = await db.select().from(jgFeeSegments).where(eq(jgFeeSegments.jgId, jg1));
    expect(segs).toHaveLength(1);
    expect(segs[0].rate).toBe("2.50");

    // ---- PO：提交（R1 全部在容差内）→ 审批 → 确认 ----
    const poPending = await submitPo(purchasingUser, po1, 1, db);
    expect(poPending.status).toBe("pending");
    const poR = await approvePo(purchasingApprover, po1, { action: "approve", version: poPending.version }, db);
    expect(poR).toMatchObject({ status: "approved", idempotent: false });
    const poConfirmed = await confirmPo(purchasingUser, po1, { version: poPending.version + 1, note: "电话确认" }, db);
    expect(poConfirmed.status).toBe("in_progress");
    expect(poConfirmed.confirmedBy).toBe(purchasingUser.id);
    expect(poConfirmed.confirmNote).toBe("电话确认");

    // ---- JG：提交 → 审批(pmc) → 确认 ----
    const jgPending = await submitJg(pmcCreator, jg1, 1, db);
    const jgR = await approveJg(pmcApprover, jg1, { action: "approve", version: jgPending.version }, db);
    expect(jgR).toMatchObject({ status: "approved", idempotent: false });
    const jgConfirmed = await confirmJg(purchasingUser, jg1, { version: jgPending.version + 1 }, db);
    expect(jgConfirmed.status).toBe("in_progress");
    expect(jgConfirmed.inProduction).toBe(true);

    const jgDetail = await getJg(jg1, db);
    expect(jgDetail.approvals).toHaveLength(1);
    expect(jgDetail.feeSegments).toHaveLength(1);
    expect(jgDetail.feeSegments[0].feeRate).toBe("2.50"); // DTO 键名=feeRate（可被脱敏剥除）
  });

  it("2) R1 价格异动：>3% → 提交 409 + 自动 PC；PC 审批通过后重提放行", async () => {
    const wo = await createWo(pmcCreator, { productSkuId: cp1, qty: "100", supplierId: supProc, feeRatePlan: "2.50" }, db);
    const woPending = await submitWo(pmcCreator, wo.id, wo.version, db);
    await approveWo(pmcApprover, wo.id, { action: "approve", version: woPending.version }, db);
    const gen = await generateDocs(pmcCreator, wo.id, {
      poGroups: [{
        supplierId: supA,
        // 3564/1.13/25 = 126.16；基准=测试1已审批 PO 的 120.00 → 偏差 5.13% > 3%
        lines: [{ materialSkuId: yl, qty: "1", purchaseUom: "袋", uomFactor: "25", price: "3564" }],
      }],
    }, db);
    const poId = gen.pos[0].id;

    await expect(submitPo(purchasingUser, poId, 1, db)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("存在价格异动"),
    });

    // PO 仍草稿；PC 已落库 pending，基准取最近已审批 PO 行（120.00）而非价格表
    const [poRow] = await db.select().from(poDocs).where(eq(poDocs.id, poId));
    expect(poRow.status).toBe("draft");
    const [line] = await db.select().from(poLines).where(eq(poLines.poId, poId));
    const pcs = await db
      .select()
      .from(pcDocs)
      .where(and(eq(pcDocs.target, "po_line"), eq(pcDocs.poLineId, line.id)));
    expect(pcs).toHaveLength(1);
    expect(pcs[0]).toMatchObject({
      status: "pending", oldPrice: "120.00", newPrice: "126.16", deviationPct: "5.13", scope: "unreceived_only",
    });

    // 重复提交不重复建 PC（同价 pending 复用）
    await expect(submitPo(purchasingUser, poId, 1, db)).rejects.toMatchObject({ status: 409 });
    expect(
      await db.select().from(pcDocs).where(and(eq(pcDocs.target, "po_line"), eq(pcDocs.poLineId, line.id))),
    ).toHaveLength(1);

    // PC 审批（采购审批人 ≠ PC 制单人=提交 PO 的采购员）→ 重提放行 → PO 审批
    const pcR = await approvePc(purchasingApprover, pcs[0].id, { action: "approve", version: pcs[0].version }, db);
    expect(pcR).toMatchObject({ status: "approved", idempotent: false });
    const poPending = await submitPo(purchasingUser, poId, 1, db);
    expect(poPending.status).toBe("pending");
    const poR = await approvePo(purchasingApprover, poId, { action: "approve", version: poPending.version }, db);
    expect(poR.status).toBe("approved");
  });

  it("3) 首购免检：无任何基准价（无已批 PO、无价格表）→ 不生成 PC，直接进待审批", async () => {
    const wo = await createWo(pmcCreator, { productSkuId: cp1, qty: "50", supplierId: supProc, feeRatePlan: "2.50" }, db);
    const woPending = await submitWo(pmcCreator, wo.id, wo.version, db);
    await approveWo(pmcApprover, wo.id, { action: "approve", version: woPending.version }, db);
    const gen = await generateDocs(pmcCreator, wo.id, {
      poGroups: [{ supplierId: supA, lines: [{ materialSkuId: bc2, qty: "100", price: "0.30" }] }],
    }, db);
    const poId = gen.pos[0].id;
    const poPending = await submitPo(purchasingUser, poId, 1, db);
    expect(poPending.status).toBe("pending");
    const [line] = await db.select().from(poLines).where(eq(poLines.poId, poId));
    expect(
      await db.select().from(pcDocs).where(and(eq(pcDocs.target, "po_line"), eq(pcDocs.poLineId, line.id))),
    ).toHaveLength(0);
  });

  it("4) 加工费改价走 PC(jg_fee)：审批通过 → feeRateCurrent 更新 + 新增费率分段", async () => {
    const pc = await createPcForJgFee(purchasingUser, { jgId: jg1, newPrice: "2.80", scope: "unreceived_only" }, db);
    expect(pc.docNo.startsWith("PC-")).toBe(true);
    expect(pc).toMatchObject({ status: "pending", target: "jg_fee", oldPrice: "2.50", newPrice: "2.80", deviationPct: "12.00" });

    // 同 JG 已有待审 PC → 不允许并行再发起
    await expect(
      createPcForJgFee(purchasingUser, { jgId: jg1, newPrice: "3.00", scope: "unreceived_only" }, db),
    ).rejects.toMatchObject({ status: 409 });

    const r = await approvePc(purchasingApprover, pc.id, { action: "approve", version: pc.version }, db);
    expect(r).toMatchObject({ status: "approved", idempotent: false });

    const [jg] = await db.select().from(jgDocs).where(eq(jgDocs.id, jg1));
    expect(jg.feeRateCurrent).toBe("2.80");
    const segs = await db
      .select()
      .from(jgFeeSegments)
      .where(eq(jgFeeSegments.jgId, jg1))
      .orderBy(jgFeeSegments.effectiveFrom, jgFeeSegments.id);
    expect(segs).toHaveLength(2);
    expect(segs.map((s) => s.rate)).toEqual(["2.50", "2.80"]);
  });

  it("5) 边界：无生效 BOM 拒建 WO；黑名单供应商拒建；同 WO 第二张 JG 409；SoD 自审 403", async () => {
    // 无生效 BOM
    await expect(
      createWo(pmcCreator, { productSkuId: cp2, qty: "10", supplierId: supProc, feeRatePlan: "1.00" }, db),
    ).rejects.toMatchObject({ status: 404, message: "该成品无生效 BOM" });

    // 黑名单加工厂
    await expect(
      createWo(pmcCreator, { productSkuId: cp1, qty: "10", supplierId: supBlack, feeRatePlan: "1.00" }, db),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("黑名单") });

    // 同 WO 重复生成 JG
    await expect(generateDocs(pmcCreator, wo1, { poGroups: [] }, db)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(jg1DocNo),
    });

    // SoD：WO 制单人（同时是审批人角色）不能审批自己的单
    const wo = await createWo(pmcApprover, { productSkuId: cp1, qty: "10", supplierId: supProc, feeRatePlan: "1.00" }, db);
    const woPending = await submitWo(pmcApprover, wo.id, wo.version, db);
    await expect(
      approveWo(pmcApprover, wo.id, { action: "approve", version: woPending.version }, db),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining("SELF_APPROVAL") });

    // 角色门：ops 不能建 WO；pmc 不能建 BH
    await expect(
      createWo(opsCreator, { productSkuId: cp1, qty: "1", supplierId: supProc, feeRatePlan: "1.00" }, db),
    ).rejects.toMatchObject({ status: 403 });
    await expect(createBh(pmcCreator, { lines: [{ skuId: cp1, qty: "1" }] }, db)).rejects.toMatchObject({ status: 403 });
  });

  it("6) R11 集成断言：MOQ 抬底与订货倍数取整已作用于快照建议量", async () => {
    const woDetail = await getWo(wo1, db);
    // YL：净需求 41 → MOQ 50 抬底（且 50 恰为 25 的倍数）
    expect(woDetail.lines[0].suggestedQty).toBe("50.0000");
    // BC：净需求 8500 → 无 MOQ，按 1000 倍数向上取整为 9000
    expect(woDetail.lines[1].suggestedQty).toBe("9000.0000");
  });

  it("7) 审计留痕：链路上每个写动作均有 audit_logs 行", async () => {
    const rows = await db
      .select({ entity: auditLogs.entity, action: auditLogs.action })
      .from(auditLogs)
      .where(inArray(auditLogs.entity, ["bh", "wo", "po", "jg", "pc"]));
    const seen = new Set(rows.map((r) => `${r.entity}:${r.action}`));
    for (const key of [
      "bh:create", "bh:submit", "bh:approve",
      "wo:create", "wo:submit", "wo:approve", "wo:snapshot",
      "po:create", "po:submit", "po:approve", "po:confirm",
      "jg:create", "jg:submit", "jg:approve", "jg:confirm", "jg:fee_change",
      "pc:create", "pc:approve",
    ]) {
      expect(seen, `缺少审计: ${key}`).toContain(key);
    }
    // 抽查数量级：BH 全链 3 个动作各恰 1 行
    const bhRows = rows.filter((r) => r.entity === "bh");
    expect(bhRows.filter((r) => r.action === "create")).toHaveLength(1);
    expect(bhRows.filter((r) => r.action === "submit")).toHaveLength(1);
    expect(bhRows.filter((r) => r.action === "approve")).toHaveLength(1);
  });

  it("8) 脱敏口径：PC 列表对无价格可见角色剥 oldPrice/newPrice/deviationPct", async () => {
    const forPurchasing = await listPcs(["purchasing"], { page: 1, pageSize: 10 }, db);
    expect(forPurchasing.total).toBeGreaterThan(0);
    expect((forPurchasing.rows[0] as Record<string, unknown>).newPrice).toBeDefined();
    const forOps = await listPcs(["ops"], { page: 1, pageSize: 10 }, db);
    const row = forOps.rows[0] as Record<string, unknown>;
    expect(row.newPrice).toBeUndefined();
    expect(row.oldPrice).toBeUndefined();
    expect(row.deviationPct).toBeUndefined();
    expect(row.docNo).toBeDefined();
  });
});
