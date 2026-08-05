/**
 * 撤回：待审批 → 草稿。
 *
 * 状态机里 `pending -[withdraw]→ draft` 早就定义了，但一直没有服务/接口/按钮——
 * 制单人填错了自己没出路，只能等审批人驳回。试用期这是最高频诉求（审计 M-03/M-38）。
 *
 * 撤回**不是审批动作**：不写 approvals、不占审批轮次，否则
 * 「提交→撤回→再提交」会把审批幂等键 cycle 撑乱，影响后续真正的审批。
 * 权限方向也与审批相反：审批要求审批人≠制单人，撤回要求必须是制单人本人。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, auditLogs, bhDocs, bhLines, skus, spus, users } from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { withdrawBH } from "@/server/modules/outsource/bh";

async function setup() {
  const { db } = await createTestDb();
  const mkUser = async (username: string, roles: string[]) => {
    const [u] = await db.insert(users).values({
      username, name: username, roles, isApprover: true,
    }).returning();
    return { id: u.id, name: u.name, roles, isApprover: true };
  };
  const maker = await mkUser("wd_maker", ["ops"]);
  const other = await mkUser("wd_other", ["ops"]);
  const admin = await mkUser("wd_admin", ["admin"]);

  const [spu] = await db.insert(spus).values({ code: "P44001", nameCn: "撤回测试品" }).returning();
  const [sku] = await db.insert(skus).values({
    code: "WD-001", name: "撤回测试 SKU", spuId: spu.id, skuType: "finished", baseUom: "支",
  }).returning();

  const mkDoc = async (status: string) => {
    const [doc] = await db.insert(bhDocs).values({
      docNo: `BH-WD-${Math.abs(status.length * 7 + Date.parse("2026-08-06"))}-${status}`,
      status, createdBy: maker.id, version: 1,
    }).returning();
    await db.insert(bhLines).values({ bhId: doc.id, skuId: sku.id, qty: "5.0000" });
    return doc;
  };
  return { db, maker, other, admin, mkDoc };
}

describe("单据撤回", () => {
  it("制单人撤回待审批单据 → 回到草稿，版本 +1，并写审计", async () => {
    const { db, maker, mkDoc } = await setup();
    const doc = await mkDoc("pending");
    const r = await withdrawBH(maker, doc.id, { version: 1 }, db);
    expect(r).toEqual({ status: "draft", idempotent: false });

    const [after] = await db.select().from(bhDocs).where(eq(bhDocs.id, doc.id));
    expect(after.status).toBe("draft");
    expect(after.version).toBe(2);

    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "withdraw"));
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBe(maker.id);
  });

  it("撤回不写审批轨迹，也不占审批轮次", async () => {
    const { db, maker, mkDoc } = await setup();
    const doc = await mkDoc("pending");
    await withdrawBH(maker, doc.id, { version: 1 }, db);
    const rows = await db.select().from(approvals).where(eq(approvals.docId, doc.id));
    expect(rows).toHaveLength(0);
  });

  it("非制单人不能撤回——否决请走驳回", async () => {
    const { db, other, mkDoc } = await setup();
    const doc = await mkDoc("pending");
    await expect(withdrawBH(other, doc.id, { version: 1 }, db)).rejects.toThrow(/NOT_OWNER|制单人/);
    const [after] = await db.select().from(bhDocs).where(eq(bhDocs.id, doc.id));
    expect(after.status).toBe("pending");
  });

  it("管理员可代为撤回（留审计）", async () => {
    const { db, admin, mkDoc } = await setup();
    const doc = await mkDoc("pending");
    const r = await withdrawBH(admin, doc.id, { version: 1 }, db);
    expect(r.status).toBe("draft");
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "withdraw"));
    expect(logs[0].userId).toBe(admin.id);
  });

  it("已是草稿时幂等返回，双击不报错也不重复写审计", async () => {
    const { db, maker, mkDoc } = await setup();
    const doc = await mkDoc("pending");
    await withdrawBH(maker, doc.id, { version: 1 }, db);
    const again = await withdrawBH(maker, doc.id, { version: 2 }, db);
    expect(again).toEqual({ status: "draft", idempotent: true });
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "withdraw"));
    expect(logs).toHaveLength(1);
  });

  it("已审批/执行中不可撤回——纠错走红字冲销，不是逆向流转", async () => {
    const { db, maker, mkDoc } = await setup();
    for (const status of ["approved", "in_progress", "completed"]) {
      const doc = await mkDoc(status);
      await expect(
        withdrawBH(maker, doc.id, { version: 1 }, db),
        status,
      ).rejects.toThrow(/BAD_STATUS|不可撤回/);
    }
  });

  it("版本过期时冲突，不做静默覆盖", async () => {
    const { db, maker, mkDoc } = await setup();
    const doc = await mkDoc("pending");
    await expect(withdrawBH(maker, doc.id, { version: 99 }, db))
      .rejects.toThrow(/VERSION_CONFLICT|版本/);
    const [after] = await db.select().from(bhDocs).where(eq(bhDocs.id, doc.id));
    expect(after.status).toBe("pending");
  });

  it("单据不存在报 404 语义", async () => {
    const { db, maker } = await setup();
    await expect(withdrawBH(maker, 999999, { version: 1 }, db)).rejects.toThrow(/NOT_FOUND|不存在/);
  });
});
