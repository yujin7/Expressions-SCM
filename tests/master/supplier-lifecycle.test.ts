import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  auditLogs,
  supplierLifecycleCases,
  suppliers,
  users,
} from "@/db/schema";
import { createTestDb } from "../helpers/db";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("供应商准入与整改闭环", () => {
  it("准入评审按幂等键创建，关闭时原子更新供应商状态与审计", async () => {
    const { db } = await createTestDb();
    const [buyer] = await db
      .insert(users)
      .values({ username: "buyer-life", name: "采购负责人", roles: ["purchasing"] })
      .returning();
    const [supplier] = await db
      .insert(suppliers)
      .values({ code: "SUP-LIFE-01", name: "准入供应商", kinds: ["raw"], status: "pending" })
      .returning();
    const actor = { id: buyer.id, name: buyer.name, roles: buyer.roles, isApprover: false };
    const { closeSupplierLifecycleCase, openSupplierLifecycleCase } = await import(
      "@/server/modules/master/supplier-lifecycle"
    );

    const created = await openSupplierLifecycleCase(
      actor,
      {
        supplierId: supplier.id,
        kind: "admission",
        priority: "high",
        reason: "证照齐全，等待采购现场评审",
        dueDate: "2099-12-31",
        idempotencyKey: UUID_A,
      },
      db,
    );
    const replayed = await openSupplierLifecycleCase(
      actor,
      {
        supplierId: supplier.id,
        kind: "admission",
        priority: "high",
        reason: "证照齐全，等待采购现场评审",
        dueDate: "2099-12-31",
        idempotencyKey: UUID_A,
      },
      db,
    );
    expect(replayed.id).toBe(created.id);
    expect(await db.select().from(supplierLifecycleCases)).toHaveLength(1);

    await expect(
      openSupplierLifecycleCase(
        actor,
        {
          supplierId: supplier.id,
          kind: "admission",
          priority: "normal",
          reason: "另一条重复准入工作项",
          dueDate: "2099-12-31",
          idempotencyKey: UUID_B,
        },
        db,
      ),
    ).rejects.toMatchObject({ status: 409 });

    await closeSupplierLifecycleCase(
      actor,
      created.id,
      { outcome: "approved", closureNote: "现场审核与资质附件复核均通过" },
      db,
    );
    const [closed] = await db
      .select()
      .from(supplierLifecycleCases)
      .where(eq(supplierLifecycleCases.id, created.id));
    const [qualified] = await db.select().from(suppliers).where(eq(suppliers.id, supplier.id));
    expect(closed).toMatchObject({
      status: "closed",
      outcome: "approved",
      supplierStatusBefore: "pending",
      supplierStatusAfter: "qualified",
    });
    expect(qualified.status).toBe("qualified");

    const logs = await db.select().from(auditLogs);
    expect(logs.map((row) => `${row.entity}:${row.action}`)).toEqual(
      expect.arrayContaining([
        "supplier_lifecycle:create",
        "supplier:lifecycle_qualified",
        "supplier_lifecycle:close",
      ]),
    );
  });

  it("整改可显式暂停新单，完成后恢复合格；普通档案编辑不能绕过状态机", async () => {
    const { db } = await createTestDb();
    const [buyer] = await db
      .insert(users)
      .values({ username: "buyer-capa", name: "整改负责人", roles: ["purchasing"] })
      .returning();
    const [supplier] = await db
      .insert(suppliers)
      .values({ code: "SUP-LIFE-02", name: "整改供应商", kinds: ["packaging"], status: "qualified" })
      .returning();
    const actor = { id: buyer.id, name: buyer.name, roles: buyer.roles, isApprover: false };
    const { closeSupplierLifecycleCase, openSupplierLifecycleCase } = await import(
      "@/server/modules/master/supplier-lifecycle"
    );
    const { updateSupplier } = await import("@/server/modules/master/supplier");

    const work = await openSupplierLifecycleCase(
      actor,
      {
        supplierId: supplier.id,
        kind: "corrective",
        priority: "critical",
        reason: "连续批次质量异常，要求完成根因分析与复验",
        dueDate: "2099-12-31",
        pauseNewOrders: true,
        idempotencyKey: UUID_B,
      },
      db,
    );
    expect((await db.select().from(suppliers).where(eq(suppliers.id, supplier.id)))[0].status).toBe("paused");

    await closeSupplierLifecycleCase(
      actor,
      work.id,
      {
        outcome: "resolved",
        finalStatus: "qualified",
        closureNote: "纠正措施已验证，连续三批复验通过",
      },
      db,
    );
    expect((await db.select().from(suppliers).where(eq(suppliers.id, supplier.id)))[0].status).toBe("qualified");

    await updateSupplier(
      supplier.id,
      {
        code: supplier.code,
        name: "整改供应商（更新档案）",
        kinds: ["packaging"],
        status: "blacklisted",
      },
      actor,
      db,
    );
    const [afterEdit] = await db.select().from(suppliers).where(eq(suppliers.id, supplier.id));
    expect(afterEdit.status).toBe("qualified");
  });

  it("非采购角色不能发起或关闭供应商生命周期工作项", async () => {
    const { db } = await createTestDb();
    const [pmc] = await db
      .insert(users)
      .values({ username: "pmc-life", name: "PMC", roles: ["pmc"] })
      .returning();
    const [supplier] = await db
      .insert(suppliers)
      .values({ code: "SUP-LIFE-03", name: "权限供应商", kinds: ["service"], status: "pending" })
      .returning();
    const { openSupplierLifecycleCase } = await import("@/server/modules/master/supplier-lifecycle");

    await expect(
      openSupplierLifecycleCase(
        { id: pmc.id, name: pmc.name, roles: pmc.roles, isApprover: false },
        {
          supplierId: supplier.id,
          kind: "admission",
          reason: "尝试越权发起供应商准入",
          dueDate: "2099-12-31",
          idempotencyKey: UUID_A,
        },
        db,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
