/**
 * W2 审计 3 回归：**检验不合格必须有后果，让步量不得静默蒸发**。
 *
 * 修复前的两条事故：
 *  1) `qc_lines.fail_handling ∈ {rework, scrap}` 存了就存了——没有退货单、没有质量案件、
 *     没有扣款依据，也没有任何人被指派处理；
 *  2) po 源收货只入合格数，**让步接收量既不入库也不退货**（matflow/sh.ts inboundFromPo），
 *     仓库账少了这批货、PO 已收数不含它，而 report/supply-commitment 早已按
 *     「合格 + 让步接收」当有效接收量算——两边对不上，整行被踢出承诺兑现分母。
 *
 * 本文件钉住修复后的行为；修复前 `@/server/modules/quality/qc-outcome` 根本不存在。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  approvalConfigs, auditLogs, poDocs, poLines, qcRecords, qualityCases, skus, spus, suppliers,
  users, warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { getBalance } from "@/server/posting";
import { approveSh, confirmInbound, createQc, createSh, getSh, submitSh } from "@/server/modules/matflow/sh";
import { getQcOutcome, raiseQcFailureOutcome } from "@/server/modules/quality/qc-outcome";
import { createTestDb, type TestDb } from "../helpers/db";

describe("检验不合格的去向（W2 审计 3）", () => {
  let db: TestDb;
  let wh: SessionUser;
  let whApprover: SessionUser;
  let admin: SessionUser;
  let skuId = 0;
  let whId = 0;
  let poId = 0;
  let poLineId = 0;
  let supplierId = 0;

  /** 收货 → 审批 → 检验（三分）→ 入库；返回 shId */
  const receiveAndInspect = async (
    actualQty: string,
    qc: { passQty: string; failQty: string; concessionQty: string; failHandling: "rework" | "scrap" | "concession" | "pending" },
  ): Promise<number> => {
    const sh = await createSh(wh, {
      sourceType: "po", sourceId: poId, warehouseId: whId,
      lines: [{ skuId, actualQty }],
    }, db);
    const pending = await submitSh(wh, sh.id, 1, db);
    await approveSh(whApprover, sh.id, { action: "approve", version: pending.version }, db);
    const detail = await getSh(sh.id, db);
    await createQc(wh, { shId: sh.id, lines: [{ shLineId: detail.lines[0].id, ...qc }] }, db);
    await confirmInbound(wh, sh.id, db);
    return sh.id;
  };

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const mkUser = async (name: string, roles: string[], isApprover: boolean): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover }).returning();
      return { id: u.id, name: u.name, roles, isApprover, channelScope: null };
    };
    wh = await mkUser("仓管", ["warehouse"], false);
    whApprover = await mkUser("仓管审批", ["warehouse"], true);
    admin = await mkUser("管理员", ["admin"], true);
    await db.insert(approvalConfigs).values([
      { docType: "sh", approverRole: "warehouse" },
      { docType: "ct", approverRole: "warehouse" },
    ]);
    const [spu] = await db.insert(spus).values({ code: "QCO-SPU", nameCn: "检验产品" }).returning();
    const [sku] = await db.insert(skus).values({ code: "QCO-SKU", name: "原料A", spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning();
    skuId = sku.id;
    const [sup] = await db.insert(suppliers).values({ code: "QCO-SUP", name: "检验供应商", kinds: ["raw"], status: "qualified" }).returning();
    supplierId = sup.id;
    const [w] = await db.insert(warehouses).values({ code: "QCO-WH", name: "原料仓", kind: "raw", accountingMode: "realtime" }).returning();
    whId = w.id;
    const [po] = await db.insert(poDocs).values({ docNo: "PO-QCO-1", status: "in_progress", supplierId: sup.id, createdBy: admin.id }).returning();
    poId = po.id;
    const [line] = await db.insert(poLines).values({
      poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "kg", uomFactor: "1", qty: "1000", price: "10.00",
    }).returning();
    poLineId = line.id;
  });

  it("让步接收量入库并计入 PO 已收数（此前既不入库也不退货，凭空蒸发）", async () => {
    await receiveAndInspect("100", { passQty: "70", failQty: "10", concessionQty: "20", failHandling: "scrap" });
    // 仓库余额 = 合格 70 + 让步 20 = 90（修复前只有 70）
    expect(await getBalance(db, skuId, whId)).toBe("90.0000");
    const [pl] = await db.select().from(poLines).where(eq(poLines.id, poLineId));
    expect(pl.receivedQty).toBe("90.0000");
  });

  it("不合格量登记质量案件：双向链接、挂供应商（于是进记分卡）、扣款依据留审计", async () => {
    const shId = await receiveAndInspect("100", { passQty: "80", failQty: "20", concessionQty: "0", failHandling: "rework" });

    const before = await getQcOutcome(wh, shId, db);
    expect(before.needsOutcome).toBe(true); // 有不合格量、没有任何后果 —— 审计说的「什么都不会发生」
    expect(before.totals.fail).toBe("20.0000");
    expect(before.lines[0].failHandlingLabel).toBe("退厂返工");

    const res = await raiseQcFailureOutcome(wh, { shId, createCase: true, caseSeverity: "high" }, db);
    expect(res.qualityCaseId).not.toBeNull();
    expect(res.qualityCaseNo).toMatch(/^QI/);

    // 正向链接
    const [qc] = await db.select().from(qcRecords).where(eq(qcRecords.shId, shId));
    expect(qc.qualityCaseId).toBe(res.qualityCaseId);
    // 反向链接 + 供应商归属（记分卡「质量案件」维度就是靠 supplier_id 认领的）
    const [kase] = await db.select().from(qualityCases).where(eq(qualityCases.id, res.qualityCaseId!));
    expect(kase.qcRecordId).toBe(qc.id);
    expect(kase.supplierId).toBe(supplierId);
    expect(kase.sourceChannel).toBe("supplier");

    // 扣款依据：结构化快照进审计
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "raise_failure_outcome"));
    expect(audit).toBeTruthy();
    expect((audit.after as { deductionBasis: { totals: { fail: string } } }).deductionBasis.totals.fail).toBe("20.0000");

    // 后果只登记一次：重复登记 409（否则同一批不合格量会有两份互相矛盾的扣款依据）
    await expect(raiseQcFailureOutcome(wh, { shId, createCase: true }, db)).rejects.toMatchObject({ status: 409 });
    expect(await getQcOutcome(wh, shId, db)).toMatchObject({ needsOutcome: false });
  });

  it("让步接收进了库、事后决定退回 → 真的开出 CT 退货草稿并双向留痕", async () => {
    const shId = await receiveAndInspect("100", { passQty: "70", failQty: "0", concessionQty: "30", failHandling: "pending" });
    const summary = await getQcOutcome(wh, shId, db);
    expect(summary.totals.concession).toBe("30.0000");
    expect(summary.lines[0].returnableQty).toBe("30.0000"); // 让步量入了库，所以真的可退

    const res = await raiseQcFailureOutcome(wh, {
      shId, createCase: false, createReturn: true, returnReason: "让步接收后判定不可用",
    }, db);
    expect(res.returnCtId).not.toBeNull();
    expect(res.returnCtDocNo).toMatch(/^CT/);
    expect(res.returnSkippedReason).toBeNull();
    const [qc] = await db.select().from(qcRecords).where(eq(qcRecords.shId, shId));
    expect(qc.returnCtId).toBe(res.returnCtId);
  });

  it("纯报废/返工量可退量为 0：明说「不合格量未入库，无需退货过账」，而不是开一张永远批不掉的单", async () => {
    const shId = await receiveAndInspect("100", { passQty: "80", failQty: "20", concessionQty: "0", failHandling: "scrap" });
    // 已收数 = 80（不合格量从未入库），可退量因此为 0
    const summary = await getQcOutcome(wh, shId, db);
    expect(summary.lines[0].returnableQty).toBe("0.0000");

    const res = await raiseQcFailureOutcome(wh, { shId, createCase: true, createReturn: true }, db);
    expect(res.returnCtId).toBeNull();
    expect(res.returnSkippedReason).toContain("可退量为 0");
    // 案件仍然登记：责任与扣款依据不因为「退不了货」而消失
    expect(res.qualityCaseId).not.toBeNull();
  });

  it("角色门：与不合格处置无关的角色不能登记后果", async () => {
    const shId = await receiveAndInspect("100", { passQty: "80", failQty: "20", concessionQty: "0", failHandling: "scrap" });
    const finance: SessionUser = { id: admin.id, name: "财务", roles: ["finance"], isApprover: false, channelScope: null };
    await expect(raiseQcFailureOutcome(finance, { shId, createCase: true }, db)).rejects.toMatchObject({ status: 403 });
  });

  /**
   * S5（2026-09-04 安全审计）：案件的幂等键此前是 `randomUUID()`。
   * `createQualityCase` 内部有 `pg_advisory_xact_lock(hashtext(key)) + 按键查重放`，
   * 而每次都换一个新键等于让那道守卫永远命中不了：并发两次「登记不合格后果」
   * 会开出**两个 QI 案件**——吃掉两个单号、在供应商记分卡的「质量案件」维度双计，
   * 而 qc_records 只链得回其中一个，另一个成了没有出处的孤儿案件。
   */
  it("并发登记后果只产生一个 QI 案件（幂等键由这次检验推导，不是 randomUUID）", async () => {
    const shId = await receiveAndInspect("100", { passQty: "80", failQty: "20", concessionQty: "0", failHandling: "scrap" });
    const results = await Promise.allSettled([
      raiseQcFailureOutcome(wh, { shId, createCase: true }, db),
      raiseQcFailureOutcome(wh, { shId, createCase: true }, db),
    ]);
    const cases = await db.select().from(qualityCases);
    expect(cases, "一次检验只该有一个质量案件；两个 = 两个单号、记分卡双计").toHaveLength(1);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length, "至少有一笔成功").toBeGreaterThanOrEqual(1);
    const [qc] = await db.select().from(qcRecords).where(eq(qcRecords.shId, shId));
    expect(qc.qualityCaseId).toBe(cases[0].id);
  });

  it("数据库背书：一个案件/一张退货单只能挂到一次检验上（读-改-写守卫的兜底）", async () => {
    const shId = await receiveAndInspect("100", { passQty: "80", failQty: "20", concessionQty: "0", failHandling: "scrap" });
    const other = await receiveAndInspect("100", { passQty: "80", failQty: "20", concessionQty: "0", failHandling: "scrap" });
    const res = await raiseQcFailureOutcome(wh, { shId, createCase: true }, db);
    const [otherQc] = await db.select().from(qcRecords).where(eq(qcRecords.shId, other));
    await expect(
      db.update(qcRecords).set({ qualityCaseId: res.qualityCaseId }).where(eq(qcRecords.id, otherQc.id)),
      "uq_qc_record_quality_case 必须拦住同一个案件挂两次检验",
    ).rejects.toThrow();
  });
});
