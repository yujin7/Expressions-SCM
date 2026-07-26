/**
 * 审计日志查看服务（UAT 缺口 #2）：admin/finance 可看，其余 403；
 * 筛选（entity/entityId/userId/action/日期/q）、倒序、分页上限 100。
 */
import { describe, it, expect } from "vitest";
import { createTestDb } from "../helpers/db";
import * as schema from "@/db/schema";
import { listAuditLogs, listAuditEntities } from "@/server/modules/admin/audit";

const admin = { id: 1, name: "管理员", roles: ["admin"], isApprover: false };
const finance = { id: 2, name: "财务", roles: ["finance"], isApprover: false };
const ops = { id: 3, name: "运营", roles: ["ops"], isApprover: false };

async function seed(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  await db.insert(schema.users).values([
    { id: 1, name: "管理员甲", roles: ["admin"] },
    { id: 2, name: "财务乙", roles: ["finance"] },
  ]);
  await db.insert(schema.auditLogs).values([
    {
      userId: 1, entity: "sku", entityId: 11, action: "create",
      after: { code: "BC00001" }, createdAt: new Date("2026-07-20T02:00:00Z"),
    },
    {
      userId: 2, entity: "sku", entityId: 11, action: "update",
      before: { name: "旧" }, after: { name: "新" }, createdAt: new Date("2026-07-21T02:00:00Z"),
    },
    {
      userId: 1, entity: "stock_doc", entityId: 5, action: "approve",
      createdAt: new Date("2026-07-22T02:00:00Z"),
    },
  ]);
}

describe("listAuditLogs 权限", () => {
  it("admin 与 finance 可查；ops 403", async () => {
    const { db } = await createTestDb();
    await seed(db);
    expect((await listAuditLogs(admin, {}, db)).total).toBe(3);
    expect((await listAuditLogs(finance, {}, db)).total).toBe(3);
    await expect(listAuditLogs(ops, {}, db)).rejects.toThrow("仅管理员或财务");
  });
});

describe("listAuditLogs 筛选与排序", () => {
  it("默认倒序（最新在前），带操作人姓名", async () => {
    const { db } = await createTestDb();
    await seed(db);
    const { rows } = await listAuditLogs(admin, {}, db);
    expect(rows.map((r) => r.action)).toEqual(["approve", "update", "create"]);
    expect(rows[0].userName).toBe("管理员甲");
    expect(rows[1].userName).toBe("财务乙");
  });

  it("entity + entityId + userId + action 精确筛选", async () => {
    const { db } = await createTestDb();
    await seed(db);
    expect((await listAuditLogs(admin, { entity: "sku" }, db)).total).toBe(2);
    expect((await listAuditLogs(admin, { entity: "sku", entityId: 11, action: "update" }, db)).total).toBe(1);
    expect((await listAuditLogs(admin, { userId: 2 }, db)).total).toBe(1);
  });

  it("日期区间（Asia/Shanghai 闭区间）与 q 模糊", async () => {
    const { db } = await createTestDb();
    await seed(db);
    const ranged = await listAuditLogs(admin, { from: "2026-07-21", to: "2026-07-21" }, db);
    expect(ranged.total).toBe(1);
    expect(ranged.rows[0].action).toBe("update");
    expect((await listAuditLogs(admin, { q: "stock" }, db)).total).toBe(1);
    expect((await listAuditLogs(admin, { q: "appro" }, db)).total).toBe(1);
  });

  it("分页：pageSize 上限 100，page 生效", async () => {
    const { db } = await createTestDb();
    await seed(db);
    await expect(listAuditLogs(admin, { pageSize: 101 }, db)).rejects.toThrow();
    const p2 = await listAuditLogs(admin, { page: 2, pageSize: 2 }, db);
    expect(p2.rows).toHaveLength(1);
    expect(p2.rows[0].action).toBe("create");
  });
});

describe("listAuditEntities", () => {
  it("去重排序；ops 403", async () => {
    const { db } = await createTestDb();
    await seed(db);
    expect(await listAuditEntities(finance, db)).toEqual(["sku", "stock_doc"]);
    await expect(listAuditEntities(ops, db)).rejects.toThrow();
  });
});
