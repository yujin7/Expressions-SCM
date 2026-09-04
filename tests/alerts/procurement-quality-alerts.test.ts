/**
 * W2 审计 5 回归：四个「数据早就有、却没人被叫醒」的告警类别。
 *
 * 修复前：`license-alert` 每天算一遍没有任何消费者；`po_promise_revisions` 的改期只在到货日历上
 * 被动展示；per-supplier OTIF 只在报表里躺着；`classifyDueState` 判出来的逾期案件不会惊动任何人。
 * 修复后四类都经 `upsertAlerts` 落库，带 ownerRole（读 ALERT_OWNER_ROLE）、actionHref、
 * sourceRule、paramsSnapshot 与 why[]，且各自的关闭语义按类别性质选定。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  approvals, poDocs, poLines, poPromiseRevisions, qualityCases, shDocs, shLines, skus, spus,
  suppliers, systemAlerts, users, warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createQualityCase } from "@/server/modules/quality/service";
import { ALERT_OWNER_ROLE } from "@/server/rules/task-triggers";
import {
  CATEGORY_OTIF_COLLAPSE, CATEGORY_PROMISE_BREACH, CATEGORY_QUALITY_CASE_OVERDUE,
  CATEGORY_SUPPLIER_LICENSE, OTIF_COLLAPSE_MIN_EVALUABLE, PROMISE_BREACH_MIN_DAYS,
  runOtifCollapseWatchdog, runPromiseBreachWatchdog, runQualityCaseOverdueWatchdog,
  runSupplierLicenseWatchdog,
} from "@/jobs/procurement-quality-alerts";
import { createTestDb, type TestDb } from "../helpers/db";

const NOW = new Date("2026-09-03T02:00:00.000Z");
const TODAY = "2026-09-03";
const day = (offset: number): string =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

const alertsOf = (db: TestDb, category: string) =>
  db.select().from(systemAlerts).where(and(eq(systemAlerts.category, category), eq(systemAlerts.status, "open")));

describe("采购与质量看门狗（W2 审计 5）", () => {
  let db: TestDb;
  let buyer: SessionUser;
  let quality: SessionUser;
  let supplierId = 0;
  let skuId = 0;
  let whId = 0;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [b] = await db.insert(users).values({ name: "采购", roles: ["purchasing"], isApprover: true }).returning();
    const [q] = await db.insert(users).values({ name: "质量", roles: ["quality"] }).returning();
    buyer = { id: b.id, name: b.name, roles: ["purchasing"], isApprover: true, channelScope: null };
    quality = { id: q.id, name: q.name, roles: ["quality"], isApprover: false, channelScope: null };
    const [sup] = await db.insert(suppliers).values({ code: "PQA-SUP", name: "看门狗供应商", kinds: ["raw"], status: "qualified" }).returning();
    supplierId = sup.id;
    const [spu] = await db.insert(spus).values({ code: "PQA-SPU", nameCn: "看门狗产品" }).returning();
    const [sku] = await db.insert(skus).values({ code: "PQA-SKU", name: "原料", spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning();
    skuId = sku.id;
    const [wh] = await db.insert(warehouses).values({ code: "PQA-WH", name: "原料仓", kind: "raw" }).returning();
    whId = wh.id;
  });

  it("1) 供应商证照到期：license-alert 终于有了消费者；续期即刻关闭（硬事实）", async () => {
    await db.update(suppliers).set({ licenseExpiry: day(-5) }).where(eq(suppliers.id, supplierId));
    const res = await runSupplierLicenseWatchdog(db, NOW);
    expect(res.opened).toBe(1);
    const [alert] = await alertsOf(db, CATEGORY_SUPPLIER_LICENSE);
    expect(alert.title).toContain("已过期 5 天");
    expect(alert.ownerRole).toBe(ALERT_OWNER_ROLE[CATEGORY_SUPPLIER_LICENSE]);
    expect(alert.actionHref).toContain("/master/supplier");
    expect(alert.sourceRule).toBe("jobs/license-alert");
    const snap = alert.paramsSnapshot as { daysLeft: number; why: { label: string }[] };
    expect(snap.daysLeft).toBe(-5);
    expect(snap.why.map((w) => w.label)).toContain("营业执照到期日");

    // 续期 → 条件消失 → autoCloseAfterDays: 0 当轮即关，不迟滞
    await db.update(suppliers).set({ licenseExpiry: day(400) }).where(eq(suppliers.id, supplierId));
    const after = await runSupplierLicenseWatchdog(db, NOW);
    expect(after.autoClosed).toBe(1);
    expect(await alertsOf(db, CATEGORY_SUPPLIER_LICENSE)).toHaveLength(0);
  });

  it("2) 交期承诺违约：改期推迟且未收齐才报；收齐后即刻关闭", async () => {
    const [po] = await db.insert(poDocs).values({
      docNo: "PO-PQA-1", status: "in_progress", supplierId, createdBy: buyer.id,
      createdAt: new Date("2026-06-01T02:00:00Z"), expectedDate: day(20),
    }).returning();
    const [line] = await db.insert(poLines).values({
      poId: po.id, skuId, lineType: "raw", purchaseUom: "kg", uomFactor: "1",
      qty: "100", price: "10.00", receivedQty: "0", expectedDate: day(20),
    }).returning();
    await db.insert(poPromiseRevisions).values([
      {
        poId: po.id, poLineId: line.id, sequence: 1, previousDate: day(-30), promisedDate: day(-10),
        source: "supplier_confirm", actorType: "supplier_token",
        idempotencyKey: `po:${po.id}:line:${line.id}:promise-seq:1`, occurredAt: new Date("2026-06-02T02:00:00Z"),
      },
      {
        poId: po.id, poLineId: line.id, sequence: 2, previousDate: day(-10), promisedDate: day(20),
        source: "supplier_confirm", actorType: "supplier_token",
        idempotencyKey: `po:${po.id}:line:${line.id}:promise-seq:2`, occurredAt: new Date("2026-08-20T02:00:00Z"),
      },
    ]);

    const res = await runPromiseBreachWatchdog(db, NOW);
    expect(res.opened).toBe(1);
    const [alert] = await alertsOf(db, CATEGORY_PROMISE_BREACH);
    expect(alert.ownerRole).toBe(ALERT_OWNER_ROLE[CATEGORY_PROMISE_BREACH]);
    expect(alert.actionHref).toContain("/outsource/po");
    const snap = alert.paramsSnapshot as { delayDays: number; minDays: number; orderByDate: string; why: unknown[] };
    expect(snap.delayDays).toBe(30);
    expect(snap.minDays).toBe(PROMISE_BREACH_MIN_DAYS);
    expect(snap.orderByDate).toBe(day(20)); // 待办截止日 = 供应商自己给的当前承诺日
    expect(snap.why).toHaveLength(4);

    // 收齐 → 条件消失（硬事实）→ 当轮即关
    await db.update(poLines).set({ receivedQty: "100" }).where(eq(poLines.id, line.id));
    const after = await runPromiseBreachWatchdog(db, NOW);
    expect(after.autoClosed).toBe(1);
  });

  it("3) OTIF 崩塌：按原始承诺口径判、样本不足不报；周期事实不自动关闭", async () => {
    const [approver] = await db.insert(users).values({ name: "审批", roles: ["purchasing"], isApprover: true }).returning();
    // 造 OTIF_COLLAPSE_MIN_EVALUABLE 张全部迟到的 PO（原始承诺早、当前承诺被推到收货之后）
    for (let i = 0; i < OTIF_COLLAPSE_MIN_EVALUABLE; i += 1) {
      const [po] = await db.insert(poDocs).values({
        docNo: `PO-OTIF-${i}`, status: "completed", supplierId, createdBy: buyer.id,
        createdAt: new Date("2026-02-01T02:00:00Z"), expectedDate: "2026-08-31",
      }).returning();
      await db.insert(approvals).values({
        docType: "po", docId: po.id, approverId: approver.id, action: "approve", cycle: 1,
        createdAt: new Date("2026-02-02T02:00:00Z"),
      });
      const [line] = await db.insert(poLines).values({
        poId: po.id, skuId, lineType: "raw", purchaseUom: "kg", uomFactor: "1",
        qty: "10", price: "10.00", receivedQty: "10", expectedDate: "2026-08-31",
      }).returning();
      await db.insert(poPromiseRevisions).values({
        poId: po.id, poLineId: line.id, sequence: 1, previousDate: "2026-02-20", promisedDate: "2026-03-01",
        source: "supplier_confirm", actorType: "supplier_token",
        idempotencyKey: `po:${po.id}:line:${line.id}:promise-seq:1`, occurredAt: new Date("2026-02-03T02:00:00Z"),
      });
      const [sh] = await db.insert(shDocs).values({
        docNo: `SH-OTIF-${i}`, status: "completed", sourceType: "po", sourceId: po.id,
        warehouseId: whId, createdBy: buyer.id, createdAt: new Date("2026-06-20T02:00:00Z"),
      }).returning();
      await db.insert(shLines).values({ shId: sh.id, skuId, lineType: "normal", actualQty: "10" });
    }

    const res = await runOtifCollapseWatchdog(db, NOW);
    expect(res.opened).toBe(1);
    const [alert] = await alertsOf(db, CATEGORY_OTIF_COLLAPSE);
    expect(alert.title).toContain("原始承诺");
    expect(alert.ownerRole).toBe(ALERT_OWNER_ROLE[CATEGORY_OTIF_COLLAPSE]);
    expect(alert.sourceRule).toContain("purchase-order-metrics/v3");
    const snap = alert.paramsSnapshot as { otifBasis: string; rate: number; currentBasisRate: number | null };
    expect(snap.otifBasis).toBe("original");
    expect(snap.rate).toBe(0);
    // 当前承诺口径反而是 100%——这正是「改期洗白」的形状，必须并列出现在证据里
    expect(snap.currentBasisRate).toBe(1);
    // 去重键带年份：某一年的崩塌是那一年的事实
    expect(alert.dedupeKey).toBe(`${CATEGORY_OTIF_COLLAPSE}:${supplierId}:2026`);

    /* 周期事实（autoCloseAfterDays: null）：候选清空也不自动关闭——
       下一轮不再命中不代表这一年的 OTIF 被处理过。
       作废这批 PO 让候选真的归零（承诺版本链是仅追加事实表，删不得）；
       再插一张草稿 PO 改变 source_binding，逼读模型重算而不是吃旧缓存。 */
    await db.update(poDocs).set({ status: "void" });
    await db.insert(poDocs).values({
      docNo: "PO-OTIF-BINDING", status: "draft", supplierId, createdBy: buyer.id,
      createdAt: new Date("2026-09-01T02:00:00Z"),
    });
    const after = await runOtifCollapseWatchdog(db, NOW);
    expect(after.candidates).toBe(0);
    expect(after.autoClosed).toBe(0);
    expect(await alertsOf(db, CATEGORY_OTIF_COLLAPSE)).toHaveLength(1);
  });

  it("4) 质量案件逾期：classifyDueState 判 overdue 才报；上报后即刻关闭", async () => {
    const kase = await createQualityCase(quality, {
      kind: "adverse_event", severity: "critical", title: "不良事件：使用后皮肤过敏",
      summary: "消费者反馈使用后出现过敏症状，需按可报告流程上报。", sourceChannel: "consumer",
      supplierId, ownerId: quality.id, receivedDate: day(-30), idempotencyKey: randomUUID(),
    }, db);
    // 直接把应报日设成过去（评估→上报的完整状态机在 quality/service 的测试里已钉住）
    await db.update(qualityCases).set({ reportDueDate: day(-4) }).where(eq(qualityCases.id, kase.id));

    const res = await runQualityCaseOverdueWatchdog(db, NOW);
    expect(res.opened).toBe(1);
    const [alert] = await alertsOf(db, CATEGORY_QUALITY_CASE_OVERDUE);
    expect(alert.title).toContain("逾期 4 天");
    expect(alert.severity).toBe("critical");
    expect(alert.ownerRole).toBe(ALERT_OWNER_ROLE[CATEGORY_QUALITY_CASE_OVERDUE]);
    expect(alert.actionHref).toContain("/quality");
    expect(alert.sourceRule).toBe("rules/quality-compliance.classifyDueState");
    const snap = alert.paramsSnapshot as { overdueDays: number; orderByDate: string };
    expect(snap.overdueDays).toBe(4);
    expect(snap.orderByDate).toBe(day(-4));

    // 关闭案件 → 条件消失（硬事实）→ 当轮即关
    await db.update(qualityCases).set({
      status: "closed", closedBy: quality.id, closedAt: new Date(), closureNote: "已上报并结案",
    }).where(eq(qualityCases.id, kase.id));
    const after = await runQualityCaseOverdueWatchdog(db, NOW);
    expect(after.autoClosed).toBe(1);
  });

  it("四个类别的责任角色都取自 ALERT_OWNER_ROLE（禁止在看门狗里硬编码）", () => {
    for (const category of [
      CATEGORY_SUPPLIER_LICENSE, CATEGORY_PROMISE_BREACH, CATEGORY_OTIF_COLLAPSE, CATEGORY_QUALITY_CASE_OVERDUE,
    ]) {
      expect(ALERT_OWNER_ROLE[category], category).toBeTruthy();
    }
  });
});
