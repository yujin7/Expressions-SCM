import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ZodError } from "zod";
import { auditLogs, suppliers, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createSupplier, setSupplierCapacity, setSupplierPaymentTerm, updateSupplier } from "@/server/modules/master/supplier";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * D64 账期三列 + 产能三列写路径：审计与写入同事务、字段校验、角色门；
 * 变更历史 = audit_logs（entity=supplier, action=payment_term / capacity）的 before/after，不另建表。
 */
describe("master/supplier 账期与产能写路径", () => {
  let db: TestDb;
  let buyer: SessionUser;
  let ops: SessionUser;
  let supplierId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [u] = await db.insert(users).values({ username: "spt_w_buyer", name: "采购", roles: ["purchasing"], isApprover: false }).returning();
    const [o] = await db.insert(users).values({ username: "spt_w_ops", name: "运营", roles: ["ops"], isApprover: false }).returning();
    buyer = { id: u.id, name: u.name, roles: ["purchasing"], isApprover: false };
    ops = { id: o.id, name: o.name, roles: ["ops"], isApprover: false };
    const created = await createSupplier({ code: "SPTW-1", name: "账期写路径供应商", kinds: ["processor"] }, buyer, db);
    supplierId = created.id;
  });

  it("登记月结账期：三列落库、原文保留、审计 before/after 只含账期字段且同事务可见", async () => {
    const r = await setSupplierPaymentTerm(supplierId, {
      paymentTermType: "monthly_credit", creditDays: 60, paymentTermEffectiveFrom: "2026-09-01", paymentTerm: "月结60", note: "2026 年度谈判",
    }, buyer, db);
    expect(r).toMatchObject({ paymentTermType: "monthly_credit", creditDays: 60, paymentTermEffectiveFrom: "2026-09-01", paymentTerm: "月结60" });
    const [row] = await db.select().from(suppliers).where(eq(suppliers.id, supplierId));
    expect(row.creditDays).toBe(60);
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "supplier"), eq(auditLogs.action, "payment_term")));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(supplierId);
    expect(audits[0].before).toMatchObject({ paymentTermType: null, creditDays: null });
    expect(audits[0].after).toMatchObject({ paymentTermType: "monthly_credit", creditDays: 60, note: "2026 年度谈判" });
    expect(Object.keys(audits[0].after as object)).not.toContain("bankAccount");
  });

  it("切换为款到发货：天数清空；再登记一次 = 第二条审计（历史可追溯）", async () => {
    // 审阅修复：常规档案编辑（不携带账期/产能字段）不得把账期抹成 NULL
    const [beforeEdit] = await db.select().from(suppliers).where(eq(suppliers.id, supplierId));
    await updateSupplier(supplierId, { code: "SPTW-1", name: "账期写路径供应商（改名）", kinds: ["processor"] }, buyer, db);
    const [afterEdit] = await db.select().from(suppliers).where(eq(suppliers.id, supplierId));
    expect(afterEdit.name).toBe("账期写路径供应商（改名）");
    expect(afterEdit.paymentTermType).toBe(beforeEdit.paymentTermType);
    expect(afterEdit.creditDays).toBe(beforeEdit.creditDays);
    expect(afterEdit.paymentTermEffectiveFrom).toBe(beforeEdit.paymentTermEffectiveFrom);
    await setSupplierPaymentTerm(supplierId, { paymentTermType: "on_delivery", paymentTermEffectiveFrom: "2026-10-01" }, buyer, db);
    const [row] = await db.select().from(suppliers).where(eq(suppliers.id, supplierId));
    expect(row.paymentTermType).toBe("on_delivery");
    expect(row.creditDays).toBeNull();
    expect(row.paymentTerm).toBe("月结60"); // 原文未传 = 不改
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "supplier"), eq(auditLogs.action, "payment_term")));
    expect(audits).toHaveLength(2);
    expect(audits[1].before).toMatchObject({ paymentTermType: "monthly_credit", creditDays: 60 });
  });

  it("校验：月结缺天数 / 缺生效日 / 天数越界 → ZodError；运营角色 → 403；不存在 → 404", async () => {
    await expect(setSupplierPaymentTerm(supplierId, { paymentTermType: "monthly_credit", paymentTermEffectiveFrom: "2026-09-01" }, buyer, db)).rejects.toBeInstanceOf(ZodError);
    await expect(setSupplierPaymentTerm(supplierId, { paymentTermType: "monthly_credit", creditDays: 30 }, buyer, db)).rejects.toBeInstanceOf(ZodError);
    await expect(setSupplierPaymentTerm(supplierId, { paymentTermType: "monthly_credit", creditDays: 999, paymentTermEffectiveFrom: "2026-09-01" }, buyer, db)).rejects.toBeInstanceOf(ZodError);
    await expect(setSupplierPaymentTerm(supplierId, { paymentTermType: "prepay", paymentTermEffectiveFrom: "2026-09-01" }, ops, db)).rejects.toMatchObject({ status: 403 });
    await expect(setSupplierPaymentTerm(999_999, { paymentTermType: "prepay", paymentTermEffectiveFrom: "2026-09-01" }, buyer, db)).rejects.toMatchObject({ status: 404 });
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "supplier"), eq(auditLogs.action, "payment_term")));
    expect(audits).toHaveLength(2); // 失败不留审计
  });

  it("产能申报：三列落库 + 审计 action=capacity；缺单位拒绝", async () => {
    await expect(setSupplierCapacity(supplierId, { declaredMonthlyCapacity: "50000" }, buyer, db)).rejects.toBeInstanceOf(ZodError);
    const r = await setSupplierCapacity(supplierId, { declaredMonthlyCapacity: "50000", capacityUom: "支", surgeCapacityPct: 30 }, buyer, db);
    expect(r).toMatchObject({ declaredMonthlyCapacity: "50000.0000", capacityUom: "支", surgeCapacityPct: 30 });
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "supplier"), eq(auditLogs.action, "capacity")));
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toMatchObject({ declaredMonthlyCapacity: "50000.0000", capacityUom: "支", surgeCapacityPct: 30 });
  });

  it("档案通用编辑（updateSupplier）也能带账期与产能字段，且同样受校验", async () => {
    const updated = await updateSupplier(supplierId, {
      code: "SPTW-1", name: "账期写路径供应商", kinds: ["processor"],
      paymentTermType: "monthly_credit", creditDays: 45, paymentTermEffectiveFrom: "2026-11-01",
      declaredMonthlyCapacity: "1200.5", capacityUom: "万支", surgeCapacityPct: 50,
    }, buyer, db);
    expect(updated).toMatchObject({ paymentTermType: "monthly_credit", creditDays: 45, declaredMonthlyCapacity: "1200.5000", capacityUom: "万支", surgeCapacityPct: 50 });
    await expect(updateSupplier(supplierId, {
      code: "SPTW-1", name: "账期写路径供应商", kinds: ["processor"], paymentTermType: "monthly_credit", creditDays: null,
    }, buyer, db)).rejects.toBeInstanceOf(ZodError);
  });

  it("通用编辑只改账期或产能时，另一组与未提交组内字段保持原值", async () => {
    const identity = { code: "SPTW-PART", name: "局部字段样本", kinds: ["processor"] };
    const created = await createSupplier({ ...identity,
      paymentTermType: "monthly_credit", creditDays: 45, paymentTermEffectiveFrom: "2026-09-01",
      declaredMonthlyCapacity: "50000", capacityUom: "支", surgeCapacityPct: 30,
    }, buyer, db);
    const term = await updateSupplier(created.id, { ...identity, creditDays: 60 }, buyer, db);
    expect(term).toMatchObject({ paymentTermType: "monthly_credit", creditDays: 60, paymentTermEffectiveFrom: "2026-09-01",
      declaredMonthlyCapacity: "50000.0000", capacityUom: "支", surgeCapacityPct: 30 });
    const capacity = await updateSupplier(created.id, { ...identity, declaredMonthlyCapacity: "60000" }, buyer, db);
    expect(capacity).toMatchObject({ paymentTermType: "monthly_credit", creditDays: 60, paymentTermEffectiveFrom: "2026-09-01",
      declaredMonthlyCapacity: "60000.0000", capacityUom: "支", surgeCapacityPct: 30 });
    const surge = await updateSupplier(created.id, { ...identity, surgeCapacityPct: 35 }, buyer, db);
    expect(surge).toMatchObject({ paymentTermType: "monthly_credit", creditDays: 60, declaredMonthlyCapacity: "60000.0000", capacityUom: "支", surgeCapacityPct: 35 });
    const typeOnly = await updateSupplier(created.id, { ...identity, paymentTermType: "on_delivery" }, buyer, db);
    expect(typeOnly).toMatchObject({ paymentTermType: "on_delivery", creditDays: null, paymentTermEffectiveFrom: "2026-09-01", declaredMonthlyCapacity: "60000.0000" });
    await expect(updateSupplier(created.id, { ...identity, paymentTermType: "monthly_credit" }, buyer, db)).rejects.toBeInstanceOf(ZodError);
    expect(await updateSupplier(created.id, { ...identity, paymentTermType: "monthly_credit", creditDays: 45 }, buyer, db)).toMatchObject({ paymentTermEffectiveFrom: "2026-09-01", creditDays: 45 });
  });

  it("生效日只认真实日历：2月30日及13月在SQL前拒绝，不写审计", async () => {
    const count = (await db.select().from(auditLogs)).length;
    for (const day of ["2026-02-30", "2026-13-01"]) {
      await expect(setSupplierPaymentTerm(supplierId, { paymentTermType: "monthly_credit", creditDays: 60, paymentTermEffectiveFrom: day }, buyer, db)).rejects.toBeInstanceOf(ZodError);
      await expect(updateSupplier(supplierId, { code: "SPTW-1", name: "日期样本", kinds: ["processor"], paymentTermEffectiveFrom: day }, buyer, db)).rejects.toBeInstanceOf(ZodError);
    }
    expect((await db.select().from(auditLogs)).length).toBe(count);
  });

  it("显式清空一组不清空另一组，合并后的非法账期不写入也不留审计", async () => {
    const identity = { code: "SPTW-CLEAR", name: "显式清空样本", kinds: ["processor"] };
    const created = await createSupplier({ ...identity,
      paymentTermType: "monthly_credit", creditDays: 45, paymentTermEffectiveFrom: "2026-09-01",
      declaredMonthlyCapacity: "50000", capacityUom: "支", surgeCapacityPct: 30,
    }, buyer, db);
    const auditCount = async () => (await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "supplier"), eq(auditLogs.entityId, created.id)))).length;
    const before = await auditCount();
    await expect(updateSupplier(created.id, { ...identity, creditDays: null }, buyer, db)).rejects.toBeInstanceOf(ZodError);
    await expect(updateSupplier(created.id, { ...identity, capacityUom: "" }, buyer, db)).rejects.toBeInstanceOf(ZodError);
    expect(await auditCount()).toBe(before);
    const term = await updateSupplier(created.id, { ...identity, paymentTermType: null }, buyer, db);
    expect(term).toMatchObject({ paymentTermType: null, creditDays: null, paymentTermEffectiveFrom: null,
      declaredMonthlyCapacity: "50000.0000", capacityUom: "支", surgeCapacityPct: 30 });
    const capacity = await updateSupplier(created.id, { ...identity, declaredMonthlyCapacity: null }, buyer, db);
    expect(capacity).toMatchObject({ declaredMonthlyCapacity: null, capacityUom: null, paymentTermType: null });
  });
});
