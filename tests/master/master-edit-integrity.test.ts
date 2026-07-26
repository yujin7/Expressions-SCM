import { describe, expect, it } from "vitest";
import { suppliers, warehouses } from "@/db/schema";
import { createTestDb } from "../helpers/db";

describe("主数据编辑完整性", () => {
  it("供应商详情返回列表省略的财务与联系字段，供编辑表单完整回填", async () => {
    const { db } = await createTestDb();
    const [supplier] = await db
      .insert(suppliers)
      .values({
        code: "SUP-DETAIL",
        name: "完整字段供应商",
        kinds: ["raw"],
        phone: "13800000000",
        email: "buyer@example.com",
        address: "测试地址",
        paymentTerm: "月结30",
        bankAccount: "测试银行 62220000",
        level: "A",
        status: "qualified",
      })
      .returning();

    const { getSupplier } = await import("@/server/modules/master/supplier");
    const detail = await getSupplier(supplier.id, db);
    expect(detail).toMatchObject({
      phone: "13800000000",
      email: "buyer@example.com",
      address: "测试地址",
      paymentTerm: "月结30",
      bankAccount: "测试银行 62220000",
      level: "A",
    });
  });

  it("仓库拒绝把自己的下级设为上级，且失败时不改原层级", async () => {
    const { db } = await createTestDb();
    const [root] = await db
      .insert(warehouses)
      .values({ code: "WH-ROOT", name: "根仓", kind: "snapshot", accountingMode: "snapshot" })
      .returning();
    const [child] = await db
      .insert(warehouses)
      .values({
        code: "WH-CHILD",
        name: "子仓",
        kind: "snapshot",
        accountingMode: "snapshot",
        parentId: root.id,
      })
      .returning();

    const { updateWarehouse, getWarehouse } = await import("@/server/modules/master/warehouse");
    await expect(
      updateWarehouse(
        root.id,
        { code: root.code, name: root.name, kind: root.kind, parentId: child.id, active: true },
        undefined,
        db,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect((await getWarehouse(root.id, db)).parentId).toBeNull();
  });
});
