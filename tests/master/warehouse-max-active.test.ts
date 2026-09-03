/**
 * D60 warehouse_max_active 守卫（master/warehouse.ts）：启用中的实体仓（finished/raw/packaging）≥ 上限时，
 * 新建/启用实体仓 → 409；非实体仓、停用、改名不触发。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sysParams, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createWarehouse, getWarehouseCapacity, updateWarehouse } from "@/server/modules/master/warehouse";
import { createTestDb, type TestDb } from "../helpers/db";

describe("warehouse_max_active 守卫", () => {
  let db: TestDb;
  let admin: SessionUser;
  let w1Id = 0;
  let w2Id = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [u] = await db.insert(users).values({ name: "仓库管理员", roles: ["admin"] }).returning();
    admin = { id: u.id, name: u.name, roles: ["admin"], isApprover: false };
    await db.insert(sysParams).values({ scope: "global", key: "warehouse_max_active", value: "2", note: "测试上限" });
  });

  it("上限内可建；达到上限后再建实体仓 → 409；非实体仓与停用仓不占额度", async () => {
    const w1 = await createWarehouse({ code: "MX-1", name: "成品一仓", kind: "finished" }, admin, db);
    const w2 = await createWarehouse({ code: "MX-2", name: "原料仓", kind: "raw" }, admin, db);
    w1Id = w1.id; w2Id = w2.id;
    expect(await getWarehouseCapacity(db)).toEqual({ activeCount: 2, maxActive: 2 });
    await expect(createWarehouse({ code: "MX-3", name: "包材仓", kind: "packaging" }, admin, db))
      .rejects.toMatchObject({ name: "ApiError", status: 409, message: expect.stringContaining("2 / 2") });
    // 非实体仓（在途/快照）不受限
    await createWarehouse({ code: "MX-T", name: "在途仓", kind: "transit" }, admin, db);
    await createWarehouse({ code: "MX-S", name: "快照仓", kind: "snapshot" }, admin, db);
    // 以停用状态建实体仓不受限
    const off = await createWarehouse({ code: "MX-4", name: "备用仓", kind: "packaging", active: false }, admin, db);
    expect(off.active).toBe(false);
    expect((await getWarehouseCapacity(db)).activeCount).toBe(2);
  });

  it("更新：已启用实体仓改名不触发；停用后额度释放；启用停用仓再超限 → 409", async () => {
    const renamed = await updateWarehouse(w1Id, { code: "MX-1", name: "成品一仓（改）", kind: "finished" }, admin, db);
    expect(renamed.name).toBe("成品一仓（改）");
    await updateWarehouse(w2Id, { code: "MX-2", name: "原料仓", kind: "raw", active: false }, admin, db);
    expect((await getWarehouseCapacity(db)).activeCount).toBe(1);
    // 现在可以再启用一个
    const w3 = await createWarehouse({ code: "MX-5", name: "包材仓", kind: "packaging" }, admin, db);
    expect(w3.active).toBe(true);
    // 重新启用 w2 → 超限
    await expect(updateWarehouse(w2Id, { code: "MX-2", name: "原料仓", kind: "raw", active: true }, admin, db))
      .rejects.toMatchObject({ name: "ApiError", status: 409 });
    // 在途仓改成实体仓也受限（无库存证据的空仓允许切换 kind，但额度要查）
    const t = await createWarehouse({ code: "MX-T2", name: "在途二", kind: "transit" }, admin, db);
    await expect(updateWarehouse(t.id, { code: "MX-T2", name: "在途二", kind: "finished" }, admin, db))
      .rejects.toMatchObject({ name: "ApiError", status: 409 });
  });
});
