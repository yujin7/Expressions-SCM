/**
 * 审批节点配置（单据类型 → 审批角色）。
 *
 * `approval_configs` 是审批授权的单一权威，但此前全仓唯一写入点是种子代码——
 * 业务想换某类单据的审批角色，只能改代码重跑或直连数据库（审计 §C 第 4 条）。
 *
 * 这是 maker-checker 那道闸本身的配置，因此测试重点全在"不能被放宽"：
 * 非管理员写不了、不能指成 admin、不能凭空造审批域。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvalConfigs, auditLogs, users } from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { listApprovalConfigs, updateApprovalConfig } from "@/server/modules/admin/approval-config";

async function setup() {
  const { db } = await createTestDb();
  const mk = async (username: string, roles: string[]) => {
    const [u] = await db.insert(users).values({
      username, name: username, roles, isApprover: true,
    }).returning();
    return { id: u.id, name: u.name, roles, isApprover: true };
  };
  const admin = await mk("ac_admin", ["admin"]);
  const pmc = await mk("ac_pmc", ["pmc"]);
  await db.insert(approvalConfigs).values([
    { docType: "bh", approverRole: "pmc" },
    { docType: "po", approverRole: "purchasing" },
  ]);
  return { db, admin, pmc };
}

describe("审批节点配置", () => {
  it("管理员可改，并在同事务写审计（before/after 都留）", async () => {
    const { db, admin } = await setup();
    const r = await updateApprovalConfig(admin, { docType: "bh", approverRole: "finance" }, db);
    expect(r.approverRole).toBe("finance");

    const [row] = await db.select().from(approvalConfigs).where(eq(approvalConfigs.docType, "bh"));
    expect(row.approverRole).toBe("finance");

    const logs = await db.select().from(auditLogs).where(eq(auditLogs.entity, "approval_config"));
    expect(logs).toHaveLength(1);
    expect((logs[0].before as { approverRole?: string }).approverRole).toBe("pmc");
    expect((logs[0].after as { approverRole?: string }).approverRole).toBe("finance");
  });

  it("非管理员一律拒绝——界面隐藏不算授权", async () => {
    const { db, pmc } = await setup();
    await expect(
      updateApprovalConfig(pmc, { docType: "bh", approverRole: "finance" }, db),
    ).rejects.toThrow(/仅管理员/);
    const [row] = await db.select().from(approvalConfigs).where(eq(approvalConfigs.docType, "bh"));
    expect(row.approverRole).toBe("pmc"); // 未被改动
  });

  it("不接受把审批角色指成 admin——那等于取消该类单据的角色约束", async () => {
    const { db, admin } = await setup();
    await expect(
      updateApprovalConfig(admin, { docType: "bh", approverRole: "admin" }, db),
    ).rejects.toThrow(/非法|admin/);
  });

  it("不接受未登记的审批域——凭空造 docType 没有任何单据会引用", async () => {
    const { db, admin } = await setup();
    await expect(
      updateApprovalConfig(admin, { docType: "nope", approverRole: "finance" }, db),
    ).rejects.toThrow(/未登记/);
    await expect(
      updateApprovalConfig(admin, { docType: "", approverRole: "finance" }, db),
    ).rejects.toThrow(/未登记/);
  });

  it("改成相同值是幂等的，不重复写审计", async () => {
    const { db, admin } = await setup();
    const r = await updateApprovalConfig(admin, { docType: "bh", approverRole: "pmc" }, db);
    expect(r.approverRole).toBe("pmc");
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.entity, "approval_config"));
    expect(logs).toHaveLength(0);
  });

  it("列表带中文标签，便于业务辨认审批域", async () => {
    const { db } = await setup();
    const rows = await listApprovalConfigs(db);
    const bh = rows.find((r) => r.docType === "bh")!;
    expect(bh.docTypeLabel).toBe("备货申请");
    expect(bh.approverRoleLabel).toBe("生产计划");
  });
});
