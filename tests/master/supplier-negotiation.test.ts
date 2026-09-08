import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";
import { auditLogs, supplierLifecycleCases, suppliers, users } from "@/db/schema";
import * as lifecycle from "@/server/modules/master/supplier-lifecycle";
import { setSupplierPaymentTerm } from "@/server/modules/master/supplier";
import * as audit from "@/server/core/audit";

afterEach(() => vi.restoreAllMocks());
const key = "44000000-1111-4111-8111-111111111111";
const agreement = { creditDays: 60, effectiveFrom: "2099-01-01", paymentTerm: "双方确认月结60天", evidenceRef: "合同归档 / QA-TERM-001" };
async function fixture() {
  const { db } = await createTestDb();
  const [buyer, other] = await db.insert(users).values([
    { name: "采购甲", roles: ["purchasing"] }, { name: "采购乙", roles: ["purchasing"] },
  ]).returning();
  const [supplier] = await db.insert(suppliers).values({ code: "TERM-CASE-01", name: "账期合成供应商", kinds: ["processor"], status: "qualified", paymentTermType: "monthly_credit", creditDays: 30, paymentTermEffectiveFrom: "2026-01-01", paymentTerm: "月结30", declaredMonthlyCapacity: "50000", capacityUom: "支" }).returning();
  const actor = { id: buyer.id, name: buyer.name, roles: buyer.roles, isApprover: false };
  const input = { supplierId: supplier.id, kind: "payment_term", reason: "合作与采购规模支持账期提升", targetCreditDays: 60, ownerId: other.id, dueDate: "2099-12-31", idempotencyKey: key };
  return { db, supplier, actor, input, other };
}
describe("G03 账期谈判写路径", () => {
  it("发起保存基线/责任人，重复不增；协议关案与主档/审计同事务，重复不二次登记", async () => {
    const { db, supplier, actor, input, other } = await fixture();
    const work = await lifecycle.openSupplierLifecycleCase(actor, input, db);
    expect(work).toMatchObject({ ownerId: other.id, version: 1, targetCreditDays: 60, termBaseline: { creditDays: 30 } });
    expect((await lifecycle.openSupplierLifecycleCase(actor, input, db)).id).toBe(work.id);
    const close = { outcome: "resolved", closureNote: "采购已核验双方确认的协议", agreement, expectedVersion: 1 };
    await lifecycle.closeSupplierLifecycleCase(actor, work.id, close, db);
    await lifecycle.closeSupplierLifecycleCase(actor, work.id, close, db);
    const [master] = await db.select().from(suppliers).where(eq(suppliers.id, supplier.id));
    expect(master).toMatchObject({ status: "qualified", creditDays: 60, paymentTermEffectiveFrom: "2099-01-01", declaredMonthlyCapacity: "50000.0000", capacityUom: "支" });
    const [closed] = await db.select().from(supplierLifecycleCases);
    expect(closed).toMatchObject({ status: "closed", version: 2, termAgreement: agreement, termBaseline: { creditDays: 30 } });
    expect((await db.select().from(auditLogs)).map(r => `${r.entity}:${r.action}`)).toEqual(["supplier_lifecycle:create", "supplier:payment_term", "supplier_lifecycle:close"]);
    await expect(lifecycle.closeSupplierLifecycleCase(actor, work.id, { ...close, agreement: { ...agreement, creditDays: 45 } }, db)).rejects.toMatchObject({ status: 409 });
  });
  it("主档账期变化拒绝覆盖；显式核对基线后才能按新版本关案", async () => {
    const { db, supplier, actor, input } = await fixture();
    const work = await lifecycle.openSupplierLifecycleCase(actor, input, db);
    await setSupplierPaymentTerm(supplier.id, { paymentTermType: "monthly_credit", creditDays: 40, paymentTermEffectiveFrom: "2026-01-01" }, actor, db);
    const close = { outcome: "resolved", closureNote: "双方已确认协议与生效日期", agreement, expectedVersion: 1 };
    await expect(lifecycle.closeSupplierLifecycleCase(actor, work.id, close, db)).rejects.toMatchObject({ status: 409 });
    const updated = await lifecycle.followUpSupplierLifecycleCase(actor, work.id, { expectedVersion: 1, note: "已核对期间登记的新四十天条款", confirmCurrentTerm: true,
      confirmedTerm: { paymentTermType: "monthly_credit", creditDays: 40, paymentTermEffectiveFrom: "2026-01-01", paymentTerm: "月结30" } }, db);
    expect(updated).toMatchObject({ version: 2, termBaseline: { creditDays: 40 } });
    await expect(lifecycle.closeSupplierLifecycleCase(actor, work.id, close, db)).rejects.toMatchObject({ status: 409 });
    await lifecycle.closeSupplierLifecycleCase(actor, work.id, { ...close, expectedVersion: 2 }, db);
  });
  it("未达成关案不改账期/准入；可登记低于目标的真实结果但不伪造达标", async () => {
    const { db, supplier, actor, input } = await fixture();
    const work = await lifecycle.openSupplierLifecycleCase(actor, input, db);
    await lifecycle.closeSupplierLifecycleCase(actor, work.id, { outcome: "failed", closureNote: "供应商暂未同意账期调整方案", expectedVersion: 1 }, db);
    expect((await db.select().from(suppliers).where(eq(suppliers.id, supplier.id)))[0]).toMatchObject({ creditDays: 30, status: "qualified" });
    const next = await lifecycle.openSupplierLifecycleCase(actor, { ...input, idempotencyKey: "55000000-1111-4111-8111-111111111111" }, db);
    await lifecycle.closeSupplierLifecycleCase(actor, next.id, { outcome: "resolved", closureNote: "已确认只能先延长到四十天", agreement: { ...agreement, creditDays: 40 }, expectedVersion: 1 }, db);
    expect((await db.select().from(suppliers).where(eq(suppliers.id, supplier.id)))[0].creditDays).toBe(40);
  });
  it("拒绝非法日期、暂停新单、无资格责任人和越权角色", async () => {
    const { db, actor, input, other } = await fixture();
    await expect(lifecycle.openSupplierLifecycleCase(actor, { ...input, dueDate: "2099-02-30" }, db)).rejects.toThrow();
    await expect(lifecycle.openSupplierLifecycleCase(actor, { ...input, pauseNewOrders: true }, db)).rejects.toThrow();
    await db.update(users).set({ active: false }).where(eq(users.id, other.id));
    await expect(lifecycle.openSupplierLifecycleCase(actor, input, db)).rejects.toMatchObject({ status: 400 });
    await expect(lifecycle.openSupplierLifecycleCase({ ...actor, roles: ["warehouse"] }, input, db)).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(supplierLifecycleCases)).toHaveLength(0);
  });
  it("同幂等键不同负责人拒绝，跟进旧版本拒绝且不重复审计", async () => {
    const { db, actor, input } = await fixture();
    const work = await lifecycle.openSupplierLifecycleCase(actor, input, db);
    await expect(lifecycle.openSupplierLifecycleCase(actor, { ...input, ownerId: actor.id }, db)).rejects.toMatchObject({ status: 409 });
    const follow = { expectedVersion: 1, note: "已联系供应商安排本周沟通", ownerId: actor.id, dueDate: "2099-12-30" };
    expect(await lifecycle.followUpSupplierLifecycleCase(actor, work.id, follow, db)).toMatchObject({ ownerId: actor.id, version: 2 });
    await expect(lifecycle.followUpSupplierLifecycleCase(actor, work.id, follow, db)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(auditLogs)).toHaveLength(2);
  });
  it("关案审计失败回滚主档登记与工作项", async () => {
    const { db, supplier, actor, input } = await fixture();
    const work = await lifecycle.openSupplierLifecycleCase(actor, input, db);
    const original = audit.writeAudit;
    vi.spyOn(audit, "writeAudit").mockImplementation(async (tx, event) => {
      if (event.entity === "supplier_lifecycle" && event.action === "close") throw new Error("QA audit unavailable");
      return original(tx, event);
    });
    await expect(lifecycle.closeSupplierLifecycleCase(actor, work.id, { outcome: "resolved", closureNote: "双方已经核验条款并完成签署", agreement, expectedVersion: 1 }, db)).rejects.toThrow("QA audit unavailable");
    expect((await db.select().from(suppliers).where(eq(suppliers.id, supplier.id)))[0].creditDays).toBe(30);
    expect((await db.select().from(supplierLifecycleCases))[0]).toMatchObject({ status: "open", version: 1 });
    expect(await db.select().from(auditLogs)).toHaveLength(1);
  });
  it("确认必须绑定操作者实际看到的条款，不能确认又一次变化；逾期工作可只记进展", async () => {
    const { db, supplier, actor, input } = await fixture();
    const work = await lifecycle.openSupplierLifecycleCase(actor, input, db);
    await setSupplierPaymentTerm(supplier.id, { paymentTermType: "monthly_credit", creditDays: 50, paymentTermEffectiveFrom: "2026-01-01" }, actor, db);
    await expect(lifecycle.followUpSupplierLifecycleCase(actor, work.id, { expectedVersion: 1, note: "确认页面当时看到的四十天条款", confirmCurrentTerm: true,
      confirmedTerm: { paymentTermType: "monthly_credit", creditDays: 40, paymentTermEffectiveFrom: "2026-01-01", paymentTerm: "月结30" } }, db)).rejects.toMatchObject({ status: 409 });
    await db.update(supplierLifecycleCases).set({ dueDate: "2020-01-01" }).where(eq(supplierLifecycleCases.id, work.id));
    expect(await lifecycle.followUpSupplierLifecycleCase(actor, work.id, { expectedVersion: 1, note: "如实记录逾期事项的下一步", dueDate: "2020-01-01" }, db)).toMatchObject({ dueDate: "2020-01-01", version: 2 });
  });
  it("协议必填/非法日历/不匹配结果均拒绝，准入整改不能夹带协议", async () => {
    const { db, actor, input } = await fixture();
    const work = await lifecycle.openSupplierLifecycleCase(actor, input, db);
    for (const patch of [
      {}, { agreement: { ...agreement, evidenceRef: "" } }, { agreement: { ...agreement, effectiveFrom: "2099-02-30" } },
      { agreement, finalStatus: "blacklisted" }, { outcome: "failed", agreement }, { outcome: "approved", agreement },
    ]) await expect(lifecycle.closeSupplierLifecycleCase(actor, work.id, { outcome: "resolved", expectedVersion: 1, closureNote: "记录真实核验后的协议依据", ...patch }, db)).rejects.toThrow();
    const corrective = await lifecycle.openSupplierLifecycleCase(actor, { ...input, kind: "corrective", targetCreditDays: undefined, idempotencyKey: "66000000-1111-4111-8111-111111111111" }, db);
    await expect(lifecycle.closeSupplierLifecycleCase(actor, corrective.id, { outcome: "resolved", closureNote: "整改不能顺便改变采购条款", agreement }, db)).rejects.toMatchObject({ status: 400 });
    expect(await db.select().from(auditLogs)).toHaveLength(2);
  });
  it("全结果排序/负责人范围/准确深链与历史不会丢失；非法筛选拒绝", async () => {
    const { db, actor, supplier, input, other } = await fixture();
    const first = await lifecycle.openSupplierLifecycleCase(actor, input, db);
    const [secondSupplier] = await db.insert(suppliers).values({ code: "AAA-TERM", name: "排序首个供应商", kinds: ["packaging"], status: "qualified" }).returning();
    const second = await lifecycle.openSupplierLifecycleCase(actor, { ...input, supplierId: secondSupplier.id, ownerId: actor.id, idempotencyKey: "77000000-1111-4111-8111-111111111111" }, db);
    const sorted = await lifecycle.listSupplierLifecycleCases({ sort: "supplierCode", order: "ascend", pageSize: 1, kind: "payment_term" }, db);
    expect(sorted.total).toBe(2); expect(sorted.rows[0].id).toBe(second.id);
    expect((await lifecycle.listSupplierLifecycleCases({ ownerId: other.id }, db)).rows.map(r => r.id)).toEqual([first.id]);
    await expect(lifecycle.listSupplierLifecycleCases({ kind: "misspelt" }, db)).rejects.toThrow();
    const detail = await lifecycle.getSupplierLifecycleDetail(first.id, undefined, db);
    expect(detail.row).toMatchObject({ supplierId: supplier.id, termChanged: false, version: 1 });
    expect(detail.history).toHaveLength(1);
    await lifecycle.closeSupplierLifecycleCase(actor, first.id, { outcome: "resolved", closureNote: "真实合成协议登记已完成", agreement, expectedVersion: 1 }, db);
    await setSupplierPaymentTerm(supplier.id, { paymentTermType: "monthly_credit", creditDays: 90, paymentTermEffectiveFrom: "2099-02-01" }, actor, db);
    const closed = await lifecycle.getSupplierLifecycleDetail(first.id, undefined, db);
    expect(closed.row).toMatchObject({ termAgreement: { creditDays: 60 }, termCurrent: { creditDays: 90 } });
    expect(closed.history).toHaveLength(2); // case history excludes supplier audit containing other data
  });
  it("超过50条历史用游标无重漏回查，翻页间新增跟进不挤掉旧证据，也不带出供应商敏感审计", async () => {
    const { db, actor, supplier, input } = await fixture();
    const work = await lifecycle.openSupplierLifecycleCase(actor, input, db);
    for (let version = 1; version <= 53; version++) {
      await lifecycle.followUpSupplierLifecycleCase(actor, work.id, { expectedVersion: version, note: `第${version}次真实模拟跟进与下一步` }, db);
    }
    await setSupplierPaymentTerm(supplier.id, { paymentTermType: "monthly_credit", creditDays: 45, paymentTermEffectiveFrom: "2026-01-01" }, actor, db);
    const first = await lifecycle.getSupplierLifecycleDetail(work.id, undefined, db);
    expect(first.history).toHaveLength(50);
    expect(first.nextCursor).toBe(first.history[49].id);
    // 新记录应在刷新第一页时出现，不能使旧页的cursor发生位移。
    await lifecycle.followUpSupplierLifecycleCase(actor, work.id, { expectedVersion: 54, note: "分页期间新收到的谈判进展" }, db);
    const second = await lifecycle.getSupplierLifecycleDetail(work.id, first.nextCursor!, db);
    expect(second.history).toHaveLength(4);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.history, ...second.history].map(e => e.id);
    expect(new Set(ids).size).toBe(54);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(second.history.at(-1)?.action).toBe("create");
    expect([...first.history, ...second.history].every(e => ["create", "follow_up"].includes(e.action))).toBe(true);
    const fresh = await lifecycle.getSupplierLifecycleDetail(work.id, undefined, db);
    expect(fresh.history[0].id).toBeGreaterThan(first.history[0].id);
    await expect(lifecycle.getSupplierLifecycleDetail(2_147_483_647, undefined, db)).rejects.toMatchObject({ status: 404 });
  });
  it("采购工作台按实际责任人链接同一工作项，不重复造可独立关闭的待办", async () => {
    const { db, actor, input, other } = await fixture();
    await lifecycle.openSupplierLifecycleCase(actor, input, db);
    const { getWorkbenchFocus } = await import("@/server/modules/workbench/focus");
    const own = await getWorkbenchFocus(actor.roles, db, actor);
    expect(own.queues.find(q => q.key === "supplierWork")).toMatchObject({ count: 0, href: `/master/supplier/lifecycle?ownerId=${actor.id}&status=open` });
    const otherUser = { ...actor, id: other.id, name: other.name };
    const assigned = await getWorkbenchFocus(otherUser.roles, db, otherUser);
    expect(assigned.queues.find(q => q.key === "supplierWork")).toMatchObject({ count: 1, href: `/master/supplier/lifecycle?ownerId=${other.id}&status=open` });
  });
});
