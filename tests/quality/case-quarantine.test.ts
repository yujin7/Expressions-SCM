/**
 * W2 审计 4a 回归：**质量案件必须能冻结自己范围内的批次**。
 *
 * 事故形态：`quality_cases` 是个孤岛——案件建了、批次挂上了，货照常出库；
 * 隔离全靠在群里喊，系统里一点约束力都没有。
 *
 * 钉住三件事：
 *  1) 案件发起隔离会**登记围堵行动**（quality_actions kind=containment，targetRef 指到批次×仓）；
 *  2) 库存侧隔离能力可用时**真的执行**，并把作业主键作为证据挂回行动；
 *  3) 执行不了（快照仓 / 无隔离库位 / 无仓管角色）**明说原因**、行动留在 open，
 *     而不是静默跳过假装隔离过了。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { auditLogs, batches, qualityActions, qualityCases, skus, spus, suppliers, users, warehouses } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { post } from "@/server/posting";
import { createQualityCase } from "@/server/modules/quality/service";
import { quarantineCaseScope, QUARANTINE_TARGET_TYPE } from "@/server/modules/quality/case-quarantine";
import {
  setBatchQuarantineProvider, type BatchQuarantineRequest,
} from "@/server/modules/quality/quarantine-adapter";
import { createTestDb, type TestDb } from "../helpers/db";

describe("质量案件冻结范围内批次（W2 审计 4a）", () => {
  let db: TestDb;
  let quality: SessionUser;
  let batchId = 0;
  let skuId = 0;
  let whId = 0;
  let caseId = 0;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [q] = await db.insert(users).values({ name: "质量", roles: ["quality"] }).returning();
    quality = { id: q.id, name: q.name, roles: ["quality"], isApprover: false, channelScope: null };
    const [spu] = await db.insert(spus).values({ code: "QQ-SPU", nameCn: "隔离产品" }).returning();
    const [sku] = await db.insert(skus).values({ code: "QQ-SKU", name: "成品A", spuId: spu.id, skuType: "finished", baseUom: "盒" }).returning();
    skuId = sku.id;
    const [wh] = await db.insert(warehouses).values({ code: "QQ-WH", name: "成品仓", kind: "finished", accountingMode: "realtime" }).returning();
    whId = wh.id;
    const [sup] = await db.insert(suppliers).values({ code: "QQ-SUP", name: "隔离供应商", kinds: ["oem"], status: "qualified" }).returning();
    const [batch] = await db.insert(batches).values({ batchNo: "B-QQ-001", skuId: sku.id }).returning();
    batchId = batch.id;
    // 现货：隔离是对现货的动作，没有正余额就没有可隔离的东西
    await post(db, {
      sourceDocType: "opening", sourceDocId: 1, action: "post",
      lines: [{ sourceLineId: 1, skuId: sku.id, warehouseId: wh.id, batchId: batch.id, qtyDelta: "500" }],
    });
    const kase = await createQualityCase(quality, {
      kind: "complaint",
      severity: "high",
      title: "客诉：批次异味",
      summary: "多名消费者反馈同一批次异味，需先冻结现货再评估。",
      sourceChannel: "consumer",
      skuId: sku.id,
      batchId: batch.id,
      supplierId: sup.id,
      ownerId: q.id,
      receivedDate: new Date().toISOString().slice(0, 10),
      idempotencyKey: randomUUID(),
    }, db);
    caseId = kase.id;
  });

  afterEach(() => setBatchQuarantineProvider(null));

  it("隔离能力可用：登记围堵行动 + 真的执行 + 作业主键作为证据挂回行动", async () => {
    const seen: BatchQuarantineRequest[] = [];
    setBatchQuarantineProvider(async (_actor, req) => {
      seen.push(req);
      return { ok: true, movementId: 4242, provider: "test-stub", reason: null };
    });

    const res = await quarantineCaseScope(quality, { caseId }, db);
    expect(res.emptyScope).toBe(false);
    expect(res.executed).toBe(1);
    expect(res.pending).toBe(0);
    // 请求带上了案件级幂等键：同一案件同批次同仓只该产生一次隔离作业
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ batchId, skuId, warehouseId: whId, qty: "500.0000" });
    expect(seen[0].idempotencyKey).toBe(`quality-case:${caseId}:batch:${batchId}:wh:${whId}`);

    const [action] = await db.select().from(qualityActions).where(eq(qualityActions.caseId, caseId));
    expect(action.kind).toBe("containment");
    expect(action.targetType).toBe(QUARANTINE_TARGET_TYPE);
    expect(action.targetRef).toBe(`batch#${batchId}@warehouse#${whId}`);
    expect(action.status).toBe("completed");
    expect(action.evidenceRef).toBe("test-stub#4242");

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "quarantine_scope"));
    expect(audit).toBeTruthy();
    expect((audit.after as { executed: number }).executed).toBe(1);
  });

  it("库存侧执行不了：明说原因、围堵行动留在 open，不假装隔离过了", async () => {
    setBatchQuarantineProvider(async () => ({
      ok: false, movementId: null, provider: "test-stub", reason: "该仓未配置启用的隔离库位",
    }));

    const res = await quarantineCaseScope(quality, { caseId }, db);
    expect(res.executed).toBe(0);
    expect(res.pending).toBe(1);
    expect(res.lines[0].reason).toContain("隔离库位");

    const [action] = await db.select().from(qualityActions).where(eq(qualityActions.caseId, caseId));
    expect(action.status).toBe("open"); // 责任还在，等仓库执行
    expect(action.evidenceRef).toBeNull();
  });

  it("已关闭案件不再发起隔离；无批次范围的案件明确报错而不是隔离全库", async () => {
    await db.update(qualityCases).set({
      status: "closed", closedBy: quality.id, closedAt: new Date(), closureNote: "重复案件，合并处理",
    }).where(eq(qualityCases.id, caseId));
    await expect(quarantineCaseScope(quality, { caseId }, db)).rejects.toMatchObject({ status: 409 });

    const noBatch = await createQualityCase(quality, {
      kind: "complaint", severity: "low", title: "无批次线索的投诉",
      summary: "消费者未提供批号，暂无法圈定范围。", sourceChannel: "consumer",
      ownerId: quality.id, receivedDate: new Date().toISOString().slice(0, 10), idempotencyKey: randomUUID(),
    }, db);
    await expect(quarantineCaseScope(quality, { caseId: noBatch.id }, db)).rejects.toMatchObject({ status: 409 });
  });

  it("默认实现（库位级隔离）在没有隔离库位时返回明确原因，而不是抛错中断案件处置", async () => {
    // 不注入桩：走 quarantine-adapter 的默认实现（仓库真实存在但没有 kind='quarantine' 的库位）
    const res = await quarantineCaseScope(quality, { caseId }, db);
    expect(res.executed).toBe(0);
    expect(res.lines[0].provider).toBe("inventory/bin-operations#quarantine");
    expect(res.lines[0].reason).toContain("未配置启用的隔离库位");
  });

  /**
   * S5（2026-09-04 安全审计）：围堵行动的幂等键此前是 `randomUUID()`。
   * `createQualityAction` 里那套「advisory lock + 按幂等键查重放」的防重机制一直在跑，
   * 只是**每次都拿到一个全新的键**，于是永远命中不了：重复点一次「隔离」就多出
   * 批次×仓库那么多条质量行动，每条都带责任人和截止日，直接喂给案件逾期看门狗。
   */
  it("重复发起隔离不再造第二条围堵行动（幂等键由 案件×批次×仓库 推导）", async () => {
    setBatchQuarantineProvider(async () => ({ ok: true, movementId: 7, provider: "test-stub", reason: null }));

    const first = await quarantineCaseScope(quality, { caseId }, db);
    expect(first.lines[0].replayed).toBe(false);
    const second = await quarantineCaseScope(quality, { caseId }, db);
    const third = await quarantineCaseScope(quality, { caseId }, db);

    const actions = await db.select().from(qualityActions).where(eq(qualityActions.caseId, caseId));
    expect(actions, "同一案件同批次同仓永远只有一条围堵行动").toHaveLength(1);
    expect(second.lines[0].actionId).toBe(first.lines[0].actionId);
    expect(second.lines[0].replayed, "重复发起要明说这是命中了已有行动").toBe(true);
    expect(third.lines[0].actionId).toBe(first.lines[0].actionId);
    // 三次发起，三条汇总审计（谁在什么时候按的隔离，每次都要留痕）
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "quarantine_scope"));
    expect(audits).toHaveLength(3);
  });

  it("现货量变了也不会把重放变成 409（幂等键不含会漂移的量与日期）", async () => {
    setBatchQuarantineProvider(async () => ({ ok: true, movementId: 8, provider: "test-stub", reason: null }));
    await quarantineCaseScope(quality, { caseId }, db);
    // 期间又入了一批货：数量变化不该让「同一次隔离」变成一次新请求，也不该报「幂等键已用于不同请求」
    await post(db, {
      sourceDocType: "opening", sourceDocId: 2, action: "post",
      lines: [{ sourceLineId: 1, skuId, warehouseId: whId, batchId, qtyDelta: "120" }],
    });
    const again = await quarantineCaseScope(quality, { caseId }, db);
    expect(again.lines[0].failed).toBe(false);
    expect(again.lines[0].replayed).toBe(true);
    expect(await db.select().from(qualityActions).where(eq(qualityActions.caseId, caseId))).toHaveLength(1);
  });

  /**
   * S5 的另一半：审计边界。此前汇总审计写在整个循环之后，循环里任何一次抛错
   * （最常见：某个仓没有隔离库位 → 409）都会把整个调用炸掉——
   * 前面几个批次的行动已经提交、后面的一条都没建，**而汇总审计一条都没写**：
   * 一次半成品隔离，事后没有任何记录说清隔到哪一步。
   */
  it("库存请求抛错时：本行标失败、其余批次继续、汇总审计照写", async () => {
    setBatchQuarantineProvider(async () => { throw new Error("库存域连接中断"); });
    const res = await quarantineCaseScope(quality, { caseId }, db);
    expect(res.failed).toBe(1);
    expect(res.executed).toBe(0);
    expect(res.lines[0].reason).toContain("库存域连接中断");

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "quarantine_scope"));
    expect(audits, "部分失败恰恰是最需要审计的时候，而此前正是它唯一不会被写的时候").toHaveLength(1);
    expect((audits[0].after as { failed: number }).failed).toBe(1);
  });
});
