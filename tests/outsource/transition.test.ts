/**
 * 手工状态流转：完成 / 短关 / 作废 / 重开。
 *
 * 实测缺陷（审计 M-03/M-38 附带发现，本轮复核确认）：全仓只有 JG 与 JS 会走到
 * `completed`，BH/WO/PO **没有任何路径到达完成**；`short_close` 在 src/server 下
 * 零实现，所以供应商少送尾数的单据会永久卡在「执行中」。
 *
 * 刻意不做自动完成——BH 什么时候算完属于业务口径，工程不替业务裁决。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, bhDocs, users } from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { transitionBH } from "@/server/modules/outsource/bh";
import type { DocStatus } from "@/server/docflow/state";

async function setup() {
  const { db } = await createTestDb();
  const mk = async (username: string, roles: string[]) => {
    const [u] = await db.insert(users).values({
      username, name: username, roles, isApprover: true,
    }).returning();
    return { id: u.id, name: u.name, roles, isApprover: true };
  };
  const ops = await mk("tr_ops", ["ops"]);
  const other = await mk("tr_other", ["ops"]);
  const admin = await mk("tr_admin", ["admin"]);

  let seq = 0;
  const mkDoc = async (status: DocStatus, createdBy = ops.id) => {
    seq += 1;
    const [doc] = await db.insert(bhDocs).values({
      docNo: `BH-TR-${seq}`, status, createdBy, version: 1,
    }).returning();
    return doc;
  };
  return { db, ops, other, admin, mkDoc };
}

describe("手工状态流转", () => {
  it("执行中 → 完成：这条路径此前根本不存在", async () => {
    const { db, ops, mkDoc } = await setup();
    const doc = await mkDoc("in_progress");
    const r = await transitionBH(ops, doc.id, { action: "complete", version: 1 }, db);
    expect(r).toEqual({ status: "completed", idempotent: false });
    const [after] = await db.select().from(bhDocs).where(eq(bhDocs.id, doc.id));
    expect(after.status).toBe("completed");
    expect(after.version).toBe(2);
  });

  it("短关必须留原因，原因写进审计——少送尾数的单据靠这条收口", async () => {
    const { db, ops, mkDoc } = await setup();
    const noReason = await mkDoc("in_progress");
    await expect(
      transitionBH(ops, noReason.id, { action: "short_close", version: 1 }, db),
    ).rejects.toThrow(/原因/);

    const doc = await mkDoc("in_progress");
    const r = await transitionBH(
      ops, doc.id, { action: "short_close", reason: "供应商少送 3 支，不再补", version: 1 }, db,
    );
    expect(r.status).toBe("closed");
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "short_close"));
    expect((logs[0].after as { reason?: string }).reason).toContain("少送");
    // 原因必须落在单据自己的列上：列表/详情要直接看得到，不能只躺在审计里
    const [after] = await db.select().from(bhDocs).where(eq(bhDocs.id, doc.id));
    expect(after.closedReason).toContain("少送");
  });

  it("重开会清空短关原因，避免旧原因挂在重新执行中的单据上", async () => {
    const { db, ops, admin, mkDoc } = await setup();
    const doc = await mkDoc("in_progress");
    await transitionBH(ops, doc.id, { action: "short_close", reason: "先关掉", version: 1 }, db);
    const [closed] = await db.select().from(bhDocs).where(eq(bhDocs.id, doc.id));
    expect(closed.closedReason).toBe("先关掉");

    await transitionBH(admin, doc.id, { action: "reopen", version: closed.version }, db);
    const [reopened] = await db.select().from(bhDocs).where(eq(bhDocs.id, doc.id));
    expect(reopened.status).toBe("in_progress");
    expect(reopened.closedReason).toBeNull();
  });

  it("已审批也能短关（还没开始执行就确定不做了）", async () => {
    const { db, ops, mkDoc } = await setup();
    const doc = await mkDoc("approved");
    const r = await transitionBH(ops, doc.id, { action: "short_close", reason: "取消采购", version: 1 }, db);
    expect(r.status).toBe("closed");
  });

  it("作废只针对自己的草稿：非制单人被拒，已提交的不能一键抹掉", async () => {
    const { db, ops, other, mkDoc } = await setup();
    const mine = await mkDoc("draft");
    await expect(
      transitionBH(other, mine.id, { action: "void", version: 1 }, db),
    ).rejects.toThrow(/NOT_OWNER|制单人/);

    const submitted = await mkDoc("pending");
    await expect(
      transitionBH(ops, submitted.id, { action: "void", version: 1 }, db),
    ).rejects.toThrow(/不可作废|BAD_STATUS/);

    const r = await transitionBH(ops, mine.id, { action: "void", version: 1 }, db);
    expect(r.status).toBe("void");
  });

  it("重开仅管理员，且只能从已关闭回到执行中", async () => {
    const { db, ops, admin, mkDoc } = await setup();
    const closed = await mkDoc("closed");
    await expect(
      transitionBH(ops, closed.id, { action: "reopen", version: 1 }, db),
    ).rejects.toThrow(/仅管理员|ROLE_FORBIDDEN/);
    const r = await transitionBH(admin, closed.id, { action: "reopen", version: 1 }, db);
    expect(r.status).toBe("in_progress");
  });

  it("幂等：已在目标态时重试返回成功而不是报错", async () => {
    const { db, ops, mkDoc } = await setup();
    const done = await mkDoc("completed");
    const r = await transitionBH(ops, done.id, { action: "complete", version: 1 }, db);
    expect(r).toEqual({ status: "completed", idempotent: true });
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "complete"));
    expect(logs).toHaveLength(0); // 幂等不重复写审计
  });

  it("非法流转被拒：草稿不能直接完成", async () => {
    const { db, ops, mkDoc } = await setup();
    const draft = await mkDoc("draft");
    await expect(
      transitionBH(ops, draft.id, { action: "complete", version: 1 }, db),
    ).rejects.toThrow(/不可完成|BAD_STATUS/);
  });

  it("版本过期即冲突，不静默覆盖", async () => {
    const { db, ops, mkDoc } = await setup();
    const doc = await mkDoc("in_progress");
    await expect(
      transitionBH(ops, doc.id, { action: "complete", version: 99 }, db),
    ).rejects.toThrow(/VERSION_CONFLICT|版本/);
    const [after] = await db.select().from(bhDocs).where(eq(bhDocs.id, doc.id));
    expect(after.status).toBe("in_progress");
  });
});
