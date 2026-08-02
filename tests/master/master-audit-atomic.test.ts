import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, bomLines, boms, skus, spus, users } from "@/db/schema";
import { createTestDb } from "../helpers/db";

/**
 * 主数据写入的审计必须与写入**同事务**。
 *
 * 事故背景：审计原由路由层 auditFromRoute 补记，而它用 getDbAsync() 拿的是**新的根连接**、
 * 且在服务事务提交之后才跑。进程挂在这中间 → 有数据、无审计。
 * CLAUDE.md 铁律「所有 service 写路径必须 writeAudit」的实质是原子性，不是「某处调过就行」。
 *
 * 本用例用「同一事务内可见性」来钉这条：写入成功后审计必须已在同一事务里落库。
 */
describe("master/sku 审计原子性", () => {
  it("createSku 写入与审计落在同一事务（审计行随写入一并可见）", async () => {
    const { db } = await createTestDb();
    const [u] = await db.insert(users).values({ username: "t_audit", name: "审计测试", passwordHash: "x", active: true }).returning();
    const [spu] = await db.insert(spus).values({ code: "SPU-A1", nameCn: "审计测试" }).returning();

    const { createSku } = await import("@/server/modules/master/sku");
    const created = await createSku(
      { name: "审计品", spuId: spu.id, skuType: "finished", baseUom: "个" },
      { id: u.id, name: u.name, roles: ["admin"], isApprover: true },
      db,
    );

    const rows = await db.select().from(auditLogs).where(eq(auditLogs.entity, "sku"));
    expect(rows.length, "写入成功则审计必须已落库").toBeGreaterThan(0);
    expect(rows[0].action).toBe("create");
    expect(rows[0].userId).toBe(u.id);

    const [sku] = await db.select().from(skus).where(eq(skus.id, created.id));
    expect(sku.id).toBe(created.id);
    expect(rows[0].entityId).toBe(created.id);
  });

  it("不传 actor 时不写审计（内部/迁移路径显式豁免，不静默伪造 userId）", async () => {
    const { db } = await createTestDb();
    const [spu] = await db.insert(spus).values({ code: "SPU-A2", nameCn: "无 actor" }).returning();
    const { createSku } = await import("@/server/modules/master/sku");
    await createSku({ code: "AUD-002", name: "无审计", spuId: spu.id, skuType: "finished", baseUom: "个" }, undefined, db);
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.entity, "sku"));
    expect(rows.length).toBe(0);
  });
});

/**
 * 其余三类主数据同样必须「写入即审计、且同事务」。
 * 用同一形态覆盖，避免只有 sku 被守住、其他三个悄悄退回路由层补记。
 */
describe("supplier / warehouse / category 审计原子性", () => {
  it("三类主数据写入后审计立即可见，且 userId 正确", async () => {
    const { db } = await createTestDb();
    const [u] = await db.insert(users).values({ username: "t_a2", name: "审计2", passwordHash: "x", active: true }).returning();
    const actor = { id: u.id, name: u.name, roles: ["admin"], isApprover: true };

    const { createSupplier } = await import("@/server/modules/master/supplier");
    const { createWarehouse } = await import("@/server/modules/master/warehouse");
    const { createCategory } = await import("@/server/modules/master/category");

    await createSupplier({ code: "SUP-A1", name: "审计供应商", kinds: ["raw"], status: "qualified" }, actor, db);
    await createWarehouse({ code: "WH-A1", name: "审计仓", kind: "finished", active: true }, actor, db);
    await createCategory({ name: "审计分类" }, actor, db);

    const rows = await db.select().from(auditLogs);
    const byEntity = new Map(rows.map((r: { entity: string; userId: number }) => [r.entity, r.userId]));
    for (const e of ["supplier", "warehouse", "category"]) {
      expect(byEntity.has(e), `${e} 写入后必须有审计行`).toBe(true);
      expect(byEntity.get(e)).toBe(u.id);
    }
  });
});

describe("SPU / BOM 审计原子性", () => {
  it("SPU 创建与修改均在 service 事务内记录 before/after", async () => {
    const { db } = await createTestDb();
    const [u] = await db.insert(users).values({ username: "t_spu_audit", name: "SPU审计", passwordHash: "x" }).returning();
    const { createSpu, updateSpu } = await import("@/server/modules/master/spu");

    const created = await createSpu({ code: "P90101", nameCn: "原名称" }, { id: u.id }, db as never);
    const updated = await updateSpu(created.id, { code: "P90101", nameCn: "新名称" }, { id: u.id }, db as never);

    const rows = await db.select().from(auditLogs).where(eq(auditLogs.entity, "spu")).orderBy(auditLogs.id);
    expect(rows.map((r) => r.action)).toEqual(["create", "update"]);
    expect(rows.every((r) => r.userId === u.id && r.entityId === created.id)).toBe(true);
    expect((rows[1].before as { nameCn: string }).nameCn).toBe("原名称");
    expect((rows[1].after as { nameCn: string }).nameCn).toBe("新名称");
    expect(updated.nameCn).toBe("新名称");
  });

  it("BOM 创建、修改、生效均同事务留痕，修改保留行级快照", async () => {
    const { db } = await createTestDb();
    const [maker] = await db.insert(users).values({ username: "t_bom_maker", name: "制单", passwordHash: "x" }).returning();
    const [approver] = await db
      .insert(users)
      .values({ username: "t_bom_approver", name: "审批", passwordHash: "x", roles: ["pmc"], isApprover: true })
      .returning();
    const [spu] = await db.insert(spus).values({ code: "P90102", nameCn: "BOM审计品" }).returning();
    const [product] = await db
      .insert(skus)
      .values({ code: "BOM-AUD-P", name: "成品", spuId: spu.id, skuType: "finished", baseUom: "个" })
      .returning();
    const [material] = await db
      .insert(skus)
      .values({ code: "BOM-AUD-M", name: "物料", spuId: spu.id, skuType: "raw", baseUom: "克" })
      .returning();
    const { activateBom, createBom, updateBom } = await import("@/server/modules/master/bom");

    const created = await createBom(
      { productSkuId: product.id, versionNo: "V1", lines: [{ materialSkuId: material.id, qtyPer: 1 }] },
      { id: maker.id },
      db as never,
    );
    await updateBom(
      created.id,
      { productSkuId: product.id, versionNo: "V1.1", lines: [{ materialSkuId: material.id, qtyPer: 2 }] },
      { id: maker.id },
      db as never,
    );
    await activateBom(
      created.id,
      { id: approver.id, roles: ["pmc"], isApprover: true },
      { db: db as never },
    );

    const rows = await db.select().from(auditLogs).where(eq(auditLogs.entity, "bom")).orderBy(auditLogs.id);
    expect(rows.map((r) => r.action)).toEqual(["create", "update", "activate"]);
    expect((rows[0].after as { lines: unknown[] }).lines).toHaveLength(1);
    expect((rows[1].before as { lines: unknown[] }).lines).toHaveLength(1);
    expect((rows[1].after as { lines: { qtyPer: number }[] }).lines[0].qtyPer).toBe(2);
    expect(rows[2].userId).toBe(approver.id);

    const [head] = await db.select().from(boms).where(eq(boms.id, created.id));
    const lines = await db.select().from(bomLines).where(eq(bomLines.bomId, created.id));
    expect(head.status).toBe("active");
    expect(lines[0].qtyPer).toBe("2.0000");
  });
});
