import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { auditLogs, suppliers, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createSupplier, setSupplierCapacity, updateSupplier } from "@/server/modules/master/supplier";
import { createTestDb, type TestDb } from "../helpers/db";

const declared = { declaredMonthlyCapacity: "1000", capacityUom: "支", surgeCapacityPct: 20,
  capacityValidFrom: "2026-09-01", capacityValidUntil: "2026-12-31", capacityEvidence: "供应商签认 CAP-2026-09" };

describe("G04 产能申报证据写入", () => {
  let db: TestDb;
  let buyer: SessionUser;
  let serial = 0;
  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [u] = await db.insert(users).values({ username: "capacity-evidence-buyer", name: "采购", roles: ["purchasing"], isApprover: false }).returning();
    buyer = { id: u.id, name: u.name, roles: ["purchasing"], isApprover: false };
  });
  const create = () => createSupplier({ code: `CAP-E-${++serial}`, name: "申报证据工厂", kinds: ["processor"], ...declared }, buyer, db);
  const read = async (id: number) => (await db.select().from(suppliers).where(eq(suppliers.id, id)))[0];
  const audits = (id: number) => db.select().from(auditLogs).where(and(eq(auditLogs.entity, "supplier"), eq(auditLogs.entityId, id)));

  it("旧客户端提交原三字段，不擦除新有效期与依据", async () => {
    const s = await create();
    const r = await setSupplierCapacity(s.id, { declaredMonthlyCapacity: "1000", capacityUom: "支", surgeCapacityPct: 20 }, buyer, db);
    expect(r).toMatchObject({ capacityValidFrom: declared.capacityValidFrom, capacityValidUntil: declared.capacityValidUntil, capacityEvidence: declared.capacityEvidence });
    expect((await audits(s.id)).at(-1)?.after).toMatchObject({ capacityEvidence: declared.capacityEvidence });
  });

  it("两条路径局部更新均保留其他字段，合并后校验", async () => {
    const s = await create();
    expect(await setSupplierCapacity(s.id, { surgeCapacityPct: 30 }, buyer, db)).toMatchObject({ ...declared, declaredMonthlyCapacity: "1000.0000", surgeCapacityPct: 30 });
    expect(await updateSupplier(s.id, { code: s.code, name: s.name, kinds: ["processor"], capacityValidUntil: "2027-01-31" }, buyer, db)).toMatchObject({ capacityValidFrom: declared.capacityValidFrom, capacityValidUntil: "2027-01-31", capacityEvidence: declared.capacityEvidence, surgeCapacityPct: 30 });
    const n = (await audits(s.id)).length;
    await expect(setSupplierCapacity(s.id, { capacityEvidence: "" }, buyer, db)).rejects.toBeInstanceOf(ZodError);
    await expect(setSupplierCapacity(s.id, { capacityValidUntil: "2026-08-31" }, buyer, db)).rejects.toBeInstanceOf(ZodError);
    await expect(setSupplierCapacity(s.id, { capacityUom: "" }, buyer, db)).rejects.toBeInstanceOf(ZodError);
    expect((await audits(s.id)).length).toBe(n);
    expect(await read(s.id)).toMatchObject({ capacityEvidence: declared.capacityEvidence, capacityValidUntil: "2027-01-31" });
  });

  it("完整详情的null联系字段可直接编辑回传，不阻断产能保存", async () => {
    const s = await create();
    const r = await updateSupplier(s.id, { ...s, declaredMonthlyCapacity: "1200" }, buyer, db);
    expect(r).toMatchObject({ declaredMonthlyCapacity: "1200.0000", capacityEvidence: declared.capacityEvidence,
      contact: null, phone: null, email: null, address: null, paymentTerm: null, bankAccount: null });
  });

  it("无申报的完整详情回传也兼容null单位，仍保持未知", async () => {
    const s = await createSupplier({ code: `CAP-E-${++serial}`, name: "未申报", kinds: ["processor"] }, buyer, db);
    expect(await updateSupplier(s.id, { ...s, name: "未申报改名" }, buyer, db)).toMatchObject({ name: "未申报改名", declaredMonthlyCapacity: null, capacityUom: null, capacityEvidence: null });
  });

  it("产能超数据库精度在入参阶段拒绝，边界值仍可保存", async () => {
    const s = await create();
    const base = { code: s.code, name: s.name, kinds: ["processor"] };
    const n = (await audits(s.id)).length;
    for (const qty of ["10000000000", "99999999999.9999"]) {
      await expect(setSupplierCapacity(s.id, { declaredMonthlyCapacity: qty }, buyer, db)).rejects.toBeInstanceOf(ZodError);
      await expect(updateSupplier(s.id, { ...base, declaredMonthlyCapacity: qty }, buyer, db)).rejects.toBeInstanceOf(ZodError);
    }
    expect((await audits(s.id)).length).toBe(n);
    expect(await setSupplierCapacity(s.id, { declaredMonthlyCapacity: "9999999999.9999" }, buyer, db)).toMatchObject({ declaredMonthlyCapacity: "9999999999.9999" });
  });

  it("文本未传保留，明确null清空；非法邮箱拒绝且不留成功审计", async () => {
    const s = await create();
    const base = { code: s.code, name: s.name, kinds: ["processor"] };
    const details = { contact: "合成联系人", phone: "000-123", email: "qa@example.test", address: "合成地址", paymentTerm: "月结60", bankAccount: "QA-only-bank" };
    await updateSupplier(s.id, { ...base, ...details }, buyer, db);
    expect(await updateSupplier(s.id, { ...base, name: "只改名" }, buyer, db)).toMatchObject(details);
    const n = (await audits(s.id)).length;
    await expect(updateSupplier(s.id, { ...base, email: "invalid", bankAccount: null }, buyer, db)).rejects.toBeInstanceOf(ZodError);
    expect((await audits(s.id)).length).toBe(n);
    expect(await read(s.id)).toMatchObject(details);
    const cleared = { contact: null, phone: null, email: null, address: null, paymentTerm: null, bankAccount: null };
    expect(await updateSupplier(s.id, { ...base, ...cleared }, buyer, db)).toMatchObject(cleared);
    expect((await audits(s.id)).at(-1)).toMatchObject({ before: details, after: cleared });
  });

  it.each(["dedicated", "generic"])("%s 显式撤销申报清空关联证据，但保留账期", async (path) => {
    const s = await create();
    const input = { declaredMonthlyCapacity: null };
    const r = path === "dedicated" ? await setSupplierCapacity(s.id, input, buyer, db)
      : await updateSupplier(s.id, { code: s.code, name: s.name, kinds: ["processor"], ...input }, buyer, db);
    expect(r).toMatchObject({ declaredMonthlyCapacity: null, capacityUom: null, capacityValidFrom: null, capacityValidUntil: null, capacityEvidence: null });
    expect((await read(s.id)).paymentTermType).toBe(s.paymentTermType);
  });

  it("旧缺证数据保持未知；非法日期/半个区间/无依据不落库", async () => {
    const s = await createSupplier({ code: `CAP-E-${++serial}`, name: "旧申报", kinds: ["processor"], declaredMonthlyCapacity: "20", capacityUom: "支" }, buyer, db);
    expect(s).toMatchObject({ capacityValidFrom: null, capacityValidUntil: null, capacityEvidence: null });
    const n = (await audits(s.id)).length;
    for (const input of [{ capacityValidFrom: "2026-02-30" }, { capacityValidFrom: "2026-09-01" }, { capacityValidFrom: "2026-09-01", capacityValidUntil: "2026-12-31" }]) {
      await expect(setSupplierCapacity(s.id, input, buyer, db)).rejects.toBeInstanceOf(ZodError);
    }
    expect((await audits(s.id)).length).toBe(n);
    await expect(db.update(suppliers).set({ capacityValidFrom: "2026-09-01" }).where(eq(suppliers.id, s.id))).rejects.toThrow();
  });

  it("无权限/不存在拒绝；审计失败整笔申报回滚", async () => {
    const s = await create();
    await expect(setSupplierCapacity(s.id, { ...declared }, { ...buyer, roles: ["warehouse"] }, db)).rejects.toMatchObject({ status: 403 });
    await expect(setSupplierCapacity(999999, declared, buyer, db)).rejects.toMatchObject({ status: 404 });
    const n = (await audits(s.id)).length;
    await db.execute(sql`CREATE FUNCTION reject_capacity_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'capacity' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER test_capacity_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_capacity_audit()`);
    try {
      await expect(setSupplierCapacity(s.id, { ...declared, surgeCapacityPct: 40 }, buyer, db)).rejects.toThrow();
      expect((await read(s.id)).surgeCapacityPct).toBe(20);
      expect((await audits(s.id)).length).toBe(n);
    } finally {
      await db.execute(sql`DROP TRIGGER test_capacity_audit ON audit_logs`);
      await db.execute(sql`DROP FUNCTION reject_capacity_audit()`);
    }
  });
});
