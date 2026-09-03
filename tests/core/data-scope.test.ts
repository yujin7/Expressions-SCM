/**
 * D62 数据范围解析（core/data-scope.ts）：
 * - admin / 无范围记录 = 不限；受限用户按范围裁剪；范围外请求 403；
 * - 行过滤原语；部门范围（角色码 ↔ ROLES 索引）；loadUserScopes 走 PGlite。
 */
import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/db";
import * as schema from "@/db/schema";
import { ROLES } from "@/server/core/constants";
import {
  deptKeyToTargetId, filterRowsByChannelScope, filterRowsByDeptScope, loadUserScopes, resolveChannelScope,
  resolveDeptScope, targetIdToDeptKey,
} from "@/server/core/data-scope";
import { ApiError } from "@/server/modules/master/common";

const status = (fn: () => unknown): number | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.status : -1;
  }
};

describe("resolveChannelScope", () => {
  it("admin 不限：即使登记了范围也返回 null；带请求渠道则只回该渠道且 forced=false", () => {
    const admin = { roles: ["admin"], channelScope: [1, 2] };
    expect(resolveChannelScope(admin)).toEqual({ channelIds: null, forced: false });
    expect(resolveChannelScope(admin, 9)).toEqual({ channelIds: [9], forced: false });
  });

  it("无范围记录（null / undefined）= 不限", () => {
    expect(resolveChannelScope({ roles: ["ops"], channelScope: null })).toEqual({ channelIds: null, forced: false });
    expect(resolveChannelScope({ roles: ["ops"] })).toEqual({ channelIds: null, forced: false });
    expect(resolveChannelScope({ roles: ["ops"] }, 3)).toEqual({ channelIds: [3], forced: false });
  });

  it("受限用户：未指定 → 全部范围（去重排序，forced）；范围内 → 单渠道 forced；范围外 → 403", () => {
    const ops = { roles: ["ops"], channelScope: [5, 2, 5] };
    expect(resolveChannelScope(ops)).toEqual({ channelIds: [2, 5], forced: true });
    expect(resolveChannelScope(ops, 5)).toEqual({ channelIds: [5], forced: true });
    expect(status(() => resolveChannelScope(ops, 7))).toBe(403);
    expect(() => resolveChannelScope(ops, 7)).toThrow("无权访问该渠道的数据");
  });

  it("非法渠道 ID → 400（受限与不限用户一致）", () => {
    expect(status(() => resolveChannelScope({ roles: ["ops"], channelScope: [1] }, 0))).toBe(400);
    expect(status(() => resolveChannelScope({ roles: ["pmc"] }, 1.5))).toBe(400);
  });
});

describe("filterRowsByChannelScope", () => {
  const rows = [
    { id: 1, channelId: 1 },
    { id: 2, channelId: 2 },
    { id: 3, channelId: null as number | null },
  ];
  it("不限时原样返回（拷贝）；受限时只留范围内，未映射行默认剔除、keepUnassigned 保留", () => {
    const all = filterRowsByChannelScope(rows, (r) => r.channelId, { channelIds: null, forced: false });
    expect(all).toEqual(rows);
    expect(all).not.toBe(rows);
    const scoped = { channelIds: [2], forced: true };
    expect(filterRowsByChannelScope(rows, (r) => r.channelId, scoped).map((r) => r.id)).toEqual([2]);
    expect(filterRowsByChannelScope(rows, (r) => r.channelId, scoped, { keepUnassigned: true }).map((r) => r.id)).toEqual([2, 3]);
  });
});

describe("resolveDeptScope / 部门键映射", () => {
  it("dept_key ↔ target_id 以 ROLES 索引往返；未知键 400", () => {
    ROLES.forEach((r, i) => {
      expect(deptKeyToTargetId(r)).toBe(i);
      expect(targetIdToDeptKey(i)).toBe(r);
    });
    expect(targetIdToDeptKey(99)).toBeNull();
    expect(status(() => deptKeyToTargetId("sales"))).toBe(400);
  });

  it("口径与渠道一致：admin/无记录不限；受限范围外 403；未知部门 400", () => {
    expect(resolveDeptScope({ roles: ["admin"], deptScope: ["ops"] })).toEqual({ deptKeys: null, forced: false });
    expect(resolveDeptScope({ roles: ["ops"] }, "pmc")).toEqual({ deptKeys: ["pmc"], forced: false });
    const u = { roles: ["ops"], deptScope: ["warehouse", "ops"] };
    expect(resolveDeptScope(u)).toEqual({ deptKeys: ["ops", "warehouse"], forced: true });
    expect(resolveDeptScope(u, "ops")).toEqual({ deptKeys: ["ops"], forced: true });
    expect(status(() => resolveDeptScope(u, "finance"))).toBe(403);
    expect(status(() => resolveDeptScope(u, "sales"))).toBe(400);
    const rows = [{ d: "ops" }, { d: "finance" }, { d: null as string | null }];
    expect(filterRowsByDeptScope(rows, (r) => r.d, { deptKeys: ["ops"], forced: true })).toEqual([{ d: "ops" }]);
  });
});

describe("loadUserScopes（PGlite）", () => {
  it("无记录 → 两类均 null；有记录 → 渠道 id 去重排序、部门以角色码返回", async () => {
    const { db } = await createTestDb();
    const [admin] = await db.insert(schema.users).values({ username: "adm", name: "管理员", roles: ["admin"] }).returning();
    const [u] = await db.insert(schema.users).values({ username: "ops1", name: "运营甲", roles: ["ops"] }).returning();
    expect(await loadUserScopes(db, u.id)).toEqual({ channelScope: null, deptScope: null });

    const chans = await db.insert(schema.channels).values([
      { code: "tmall", name: "天猫", kind: "platform" },
      { code: "pdd", name: "拼多多", kind: "platform" },
    ]).returning();
    await db.insert(schema.userDataScopes).values([
      { userId: u.id, scopeKind: "channel", targetId: chans[1].id, createdBy: admin.id },
      { userId: u.id, scopeKind: "channel", targetId: chans[0].id, createdBy: admin.id },
      { userId: u.id, scopeKind: "dept", targetId: deptKeyToTargetId("ops"), createdBy: admin.id },
    ]);
    const s = await loadUserScopes(db, u.id);
    expect(s.channelScope).toEqual([chans[0].id, chans[1].id].sort((a, b) => a - b));
    expect(s.deptScope).toEqual(["ops"]);
    // 别人的记录互不影响
    expect(await loadUserScopes(db, admin.id)).toEqual({ channelScope: null, deptScope: null });
  });
});
