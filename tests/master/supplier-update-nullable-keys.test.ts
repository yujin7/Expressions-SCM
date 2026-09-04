/**
 * 安全审计 S5：`updateSupplier` 的可空字段一律「携带该键才写，未携带保留原值」。
 *
 * 起因是 `bankAccount`：它在 SENSITIVE_FIELDS 里，非价格角色 GET 拿到的 DTO **根本没有这个键**
 * （maskSensitive 是删除键，不是置 null）。旧写法 `v.bankAccount ?? null` 于是把
 * 「脱敏后的 DTO 原样回传保存」变成一次静默的银行账户擦除——脱敏本是只读保护，反倒成了写路径的擦除器。
 * 同一行还有 contact/phone/email/address/level/licenseExpiry 六个 `?? null`，逐个复核后取同一口径：
 * 编辑表单清空时键仍在（空串 → null），"清空"照常可用；不携带该键的局部提交不再擦除。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { maskSensitive, type SessionUser } from "@/server/core/dto";
import { createSupplier, getSupplier, updateSupplier } from "@/server/modules/master/supplier";
import { createTestDb } from "../helpers/db";

const BANK = "6222 0000 1111 2222";

async function seed() {
  const { db } = await createTestDb();
  const [u] = await db.insert(schema.users).values({ name: "采购", roles: ["purchasing"] }).returning();
  const actor: SessionUser = { id: u.id, name: u.name, roles: ["purchasing"], isApprover: false };
  const created = await createSupplier({
    code: "SUP-S5", name: "银行账户供应商", kinds: ["packaging"],
    contact: "王五", phone: "13800000000", email: "a@b.com", address: "上海",
    bankAccount: BANK, paymentTerm: "月结30", level: "A", licenseExpiry: "2030-01-01",
  }, actor, db);
  return { db, actor, id: created.id };
}

describe("S5 供应商档案编辑：未携带的可空键保留原值", () => {
  it("仓管看到的脱敏 DTO 原样回传 → 银行账户、结算方式、分级等一个都不丢", async () => {
    const { db, actor, id } = await seed();
    const dto = maskSensitive(await getSupplier(id, db), ["warehouse"]) as Record<string, unknown>;
    expect(dto).not.toHaveProperty("bankAccount"); // 前提：脱敏是删键，不是置 null
    // 编辑表单回传：未填的可空字段不出现在 JSON 里（AntD 表单 undefined 经 JSON.stringify 消失）；
    // 这正是曾经把银行账户抹掉的那种载荷——它带着全部可见字段，唯独没有被脱敏删掉的那个键。
    const payload = Object.fromEntries(Object.entries(dto).filter(([, v]) => v != null));
    await updateSupplier(id, { ...payload, name: "银行账户供应商（改名）" }, actor, db);
    const [after] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, id));
    expect(after.name).toBe("银行账户供应商（改名）");
    expect(after.bankAccount).toBe(BANK);
    expect(after.paymentTerm).toBe("月结30");
    expect(after.level).toBe("A");
    expect(after.licenseExpiry).toBe("2030-01-01");
    expect(after.contact).toBe("王五");
  });

  it("最小提交（只带必填键）同样不擦除任何可空字段", async () => {
    const { db, actor, id } = await seed();
    await updateSupplier(id, { code: "SUP-S5", name: "银行账户供应商", kinds: ["packaging"] }, actor, db);
    const [after] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, id));
    for (const [k, v] of Object.entries({
      bankAccount: BANK, contact: "王五", phone: "13800000000", email: "a@b.com",
      address: "上海", level: "A", licenseExpiry: "2030-01-01", paymentTerm: "月结30",
    })) {
      expect((after as Record<string, unknown>)[k], k).toBe(v);
    }
  });

  it("显式清空仍然有效：编辑表单把字段留空（空串）→ 写 null", async () => {
    const { db, actor, id } = await seed();
    await updateSupplier(id, {
      code: "SUP-S5", name: "银行账户供应商", kinds: ["packaging"],
      contact: "", phone: "", email: "", address: "", bankAccount: "", paymentTerm: "", level: null, licenseExpiry: "",
    }, actor, db);
    const [after] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, id));
    for (const k of ["bankAccount", "contact", "phone", "email", "address", "level", "licenseExpiry", "paymentTerm"]) {
      expect((after as Record<string, unknown>)[k], k).toBeNull();
    }
  });

  it("显式改值照常写入", async () => {
    const { db, actor, id } = await seed();
    await updateSupplier(id, { code: "SUP-S5", name: "银行账户供应商", kinds: ["packaging"], bankAccount: "6222 9999", contact: "赵六" }, actor, db);
    const [after] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, id));
    expect(after.bankAccount).toBe("6222 9999");
    expect(after.contact).toBe("赵六");
    expect(after.phone).toBe("13800000000"); // 未携带 → 保留
  });
});
