/**
 * D62 用户数据范围写路径（admin/user-scopes.ts）+ 会话失效 + export-worker runAs 透传：
 * - 仅 admin；目标用户不存在 404；未知渠道 400；空输入 400；
 * - 同事务 replace + writeAudit(entity=user_data_scope)；
 * - 范围变化 bump users.session_version → 旧 JWT 经 refreshSessionIdentity 失效；范围未变不踢；
 * - 导出 worker 以申请人当前范围构造 runAs（channelScope / deptScope / scopeVersion）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";
import * as schema from "@/db/schema";
import { createExportJob, runExportWorkerOnce } from "@/jobs/export-worker";
import { refreshSessionIdentity } from "@/server/auth/session-version";
import { deptKeyToTargetId, loadUserScopes } from "@/server/core/data-scope";
import type { SessionUser } from "@/server/core/dto";
import { getUserScopes, setUserScopes } from "@/server/modules/admin/user-scopes";
import { ApiError } from "@/server/modules/master/common";
import { EXPORT_KINDS } from "@/server/modules/report/export";

async function seed() {
  const { db } = await createTestDb();
  const [admin] = await db.insert(schema.users).values({ username: "adm", name: "管理员", roles: ["admin"] }).returning();
  const [ops] = await db.insert(schema.users).values({ username: "ops1", name: "运营甲", roles: ["ops"] }).returning();
  const [pmc] = await db.insert(schema.users).values({ username: "pmc1", name: "计划乙", roles: ["pmc"] }).returning();
  const chans = await db.insert(schema.channels).values([
    { code: "tmall", name: "天猫", kind: "platform" },
    { code: "pdd", name: "拼多多", kind: "platform" },
    { code: "vip", name: "唯品会", kind: "platform" },
  ]).returning();
  const actor = (u: typeof admin) => ({ id: u.id, name: u.name, roles: u.roles as string[], isApprover: u.isApprover });
  return { db, admin, ops, pmc, chans, actor };
}

const statusOf = async (p: Promise<unknown>): Promise<number | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.status : -1;
  }
};

describe("setUserScopes 守卫", () => {
  it("非 admin 403；目标不存在 404；空输入 400；未知渠道 400 且不落任何行", async () => {
    const { db, admin, ops, pmc, chans, actor } = await seed();
    expect(await statusOf(setUserScopes(actor(pmc), ops.id, { channelIds: [chans[0].id] }, db))).toBe(403);
    expect(await statusOf(getUserScopes(actor(pmc), ops.id, db))).toBe(403);
    expect(await statusOf(setUserScopes(actor(admin), 999999, { channelIds: [chans[0].id] }, db))).toBe(404);
    expect(await statusOf(setUserScopes(actor(admin), ops.id, {}, db))).toBe(400);
    expect(await statusOf(setUserScopes(actor(admin), ops.id, { channelIds: [chans[0].id, 424242] }, db))).toBe(400);
    expect(await statusOf(setUserScopes(actor(admin), ops.id, { deptKeys: ["sales"] }, db))).toBe(-1); // zod 校验失败
    expect(await db.select().from(schema.userDataScopes)).toHaveLength(0);
    expect(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "user_data_scope"))).toHaveLength(0);
  });
});

describe("setUserScopes 写路径", () => {
  it("同事务 replace + 审计；范围变化 bump session_version，旧 JWT 失效；未变化不 bump", async () => {
    const { db, admin, ops, chans, actor } = await seed();
    const v0 = ops.sessionVersion;
    const oldToken = { userId: ops.id, sessionVersion: v0, name: ops.name, roles: ["ops" as const], isApprover: false };
    expect(await refreshSessionIdentity(oldToken, db)).not.toBeNull();

    const r1 = await setUserScopes(actor(admin), ops.id, { channelIds: [chans[1].id, chans[0].id, chans[0].id], deptKeys: ["ops"] }, db);
    expect(r1).toEqual({
      userId: ops.id,
      channelScope: [chans[0].id, chans[1].id].sort((a, b) => a - b),
      deptScope: ["ops"],
      sessionInvalidated: true,
    });
    const rows = await db.select().from(schema.userDataScopes).where(eq(schema.userDataScopes.userId, ops.id));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.createdBy === admin.id)).toBe(true);
    expect(rows.find((r) => r.scopeKind === "dept")?.targetId).toBe(deptKeyToTargetId("ops"));

    // 旧 JWT 立即失效（session_version 已 +1）
    const [u1] = await db.select().from(schema.users).where(eq(schema.users.id, ops.id));
    expect(u1.sessionVersion).toBe(v0 + 1);
    expect(await refreshSessionIdentity(oldToken, db)).toBeNull();
    expect(await refreshSessionIdentity({ ...oldToken, sessionVersion: v0 + 1 }, db)).not.toBeNull();

    // 审计：entity=user_data_scope，before/after 为范围快照
    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "user_data_scope"));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ userId: admin.id, entityId: ops.id, action: "update" });
    expect(logs[0].before).toEqual({ channelIds: null, deptKeys: null });
    expect(logs[0].after).toEqual({ channelIds: r1.channelScope, deptKeys: ["ops"], sessionInvalidated: true });

    // 幂等重放（同一范围）：审计仍记录，但不 bump、不踢下线
    const r2 = await setUserScopes(actor(admin), ops.id, { channelIds: [chans[0].id, chans[1].id] }, db);
    expect(r2.sessionInvalidated).toBe(false);
    const [u2] = await db.select().from(schema.users).where(eq(schema.users.id, ops.id));
    expect(u2.sessionVersion).toBe(v0 + 1);
    expect(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "user_data_scope"))).toHaveLength(2);

    // 只传 channelIds：dept 保持；channelIds=[] 清空渠道（= 不限）并再次 bump
    const r3 = await setUserScopes(actor(admin), ops.id, { channelIds: [] }, db);
    expect(r3).toMatchObject({ channelScope: null, deptScope: ["ops"], sessionInvalidated: true });
    const [u3] = await db.select().from(schema.users).where(eq(schema.users.id, ops.id));
    expect(u3.sessionVersion).toBe(v0 + 2);
    expect(await getUserScopes(actor(admin), ops.id, db)).toEqual({
      userId: ops.id, channelScope: null, deptScope: ["ops"], sessionInvalidated: false,
    });
    expect(await loadUserScopes(db, ops.id)).toEqual({ channelScope: null, deptScope: ["ops"] });
  });

  it("未知渠道使整个事务回滚：先前范围原样保留、无审计行", async () => {
    const { db, admin, ops, chans, actor } = await seed();
    await setUserScopes(actor(admin), ops.id, { channelIds: [chans[2].id] }, db);
    const before = await loadUserScopes(db, ops.id);
    expect(await statusOf(setUserScopes(actor(admin), ops.id, { channelIds: [chans[0].id, 777777], deptKeys: ["pmc"] }, db))).toBe(400);
    expect(await loadUserScopes(db, ops.id)).toEqual(before);
    expect(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "user_data_scope"))).toHaveLength(1);
  });
});

describe("export-worker runAs 透传", () => {
  it("worker 以申请人当前范围构造 runAs：channelScope/deptScope/scopeVersion 与 DB 一致", async () => {
    const { db, admin, ops, chans, actor } = await seed();
    await setUserScopes(actor(admin), ops.id, { channelIds: [chans[1].id], deptKeys: ["ops"] }, db);
    const [fresh] = await db.select().from(schema.users).where(eq(schema.users.id, ops.id));

    const kind = "__d62_scope_probe";
    let seen: SessionUser | null = null;
    EXPORT_KINDS[kind] = {
      nameCn: "范围探针",
      paramsFromSearch: () => ({}),
      produce: async (user: SessionUser) => {
        seen = user;
        return { rows: [], columns: [{ key: "x", title: "x" }], total: 0 };
      },
    } as unknown as (typeof EXPORT_KINDS)[string];
    try {
      const dir = mkdtempSync(path.join(tmpdir(), "d62-scope-"));
      const job = await createExportJob({ id: ops.id }, kind, {}, db);
      const res = await runExportWorkerOnce(db, dir);
      expect(res).toMatchObject({ id: job.id, status: "done" });
    } finally {
      delete EXPORT_KINDS[kind];
    }
    expect(seen).not.toBeNull();
    expect(seen!).toMatchObject({
      id: ops.id,
      roles: ["ops"],
      channelScope: [chans[1].id],
      deptScope: ["ops"],
      sessionVersion: fresh.sessionVersion,
      scopeVersion: fresh.sessionVersion,
    });
  });
});
