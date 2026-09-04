/**
 * W2 工作台「自上次访问以来有什么变化」（workbench/visit-marker + focus 的标记接线）。
 *
 * 三件事必须成立，缺一这个功能就是噪音：
 *  1. **首次访问不标新增**——第一次见到就整屏飘红等于没有信息；
 *  2. 下一次访问只标**上次没见过**的那几条（纯事实比对，不评分、不改排序、不过滤）；
 *  3. 会话窗口内的重复请求**不推进基线**——否则用户按一下刷新，刚才那条「新增」就永远消失了，
 *     而这正是本功能要解决的问题本身。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { users, workbenchVisits } from "@/db/schema";
import {
  isNewVisit,
  markWorkbenchVisit,
  newSinceLastVisit,
  parseSeenKeys,
  WORKBENCH_VISIT_GAP_MS,
} from "@/server/modules/workbench/visit-marker";
import { createTestDb, type TestDb } from "../helpers/db";

describe("纯函数：新增判定与基线前移", () => {
  it("首次访问（无基线）不标任何一条为新增", () => {
    expect(newSinceLastVisit(null, ["a", "b"])).toEqual([]);
  });

  it("只标上次基线里没有的键，且保持传入顺序（严重度序不被打乱）", () => {
    expect(newSinceLastVisit(["b"], ["a", "b", "c"])).toEqual(["a", "c"]);
    expect(newSinceLastVisit(["a", "b", "c"], ["a", "b"])).toEqual([]);
  });

  it("只有距上一次请求超过阈值才算「新的一次访问」", () => {
    const now = new Date("2026-09-04T10:00:00Z");
    expect(isNewVisit(null, now)).toBe(true);
    expect(isNewVisit(new Date(now.getTime() - 60_000), now)).toBe(false);
    expect(isNewVisit(new Date(now.getTime() - WORKBENCH_VISIT_GAP_MS), now)).toBe(true);
  });

  it("jsonb 基线的脏值一律当空（字符串、非数组、混入非字符串项）", () => {
    expect(parseSeenKeys('["a","b"]')).toEqual(["a", "b"]);
    expect(parseSeenKeys("not json")).toEqual([]);
    expect(parseSeenKeys({ a: 1 })).toEqual([]);
    expect(parseSeenKeys(["a", 3, null])).toEqual(["a"]);
  });
});

describe("markWorkbenchVisit（落库）", () => {
  let db: TestDb;
  let userId: number;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [u] = await db.insert(users).values({ name: "总监", roles: ["pmc"] }).returning();
    userId = u.id;
  });

  it("首次访问：不标新增，since=null，并写下基线", async () => {
    const first = await markWorkbenchVisit(db, userId, ["below_lead", "expired_stock"]);
    expect(first.firstVisit).toBe(true);
    expect(first.newKeys).toEqual([]);
    expect(first.since).toBeNull();

    const [row] = await db.select().from(workbenchVisits);
    expect(parseSeenKeys(row.lastSeenKeys)).toEqual(["below_lead", "expired_stock"]);
    expect(parseSeenKeys(row.baselineKeys)).toEqual(["below_lead", "expired_stock"]);
  });

  it("隔天再来：只有上次没见过的那条被标为新增，并给出上次访问时刻", async () => {
    const day1 = new Date("2026-09-03T01:00:00Z");
    await markWorkbenchVisit(db, userId, ["below_lead"], day1);
    const day2 = new Date("2026-09-04T01:00:00Z");
    const delta = await markWorkbenchVisit(db, userId, ["below_lead", "sales_spike"], day2);

    expect(delta.firstVisit).toBe(false);
    expect(delta.newKeys).toEqual(["sales_spike"]);
    expect(new Date(delta.since!).toISOString()).toBe(day1.toISOString());
  });

  it("会话窗口内刷新：基线不动，同一条仍然被标为新增（刷新不该抹掉标记）", async () => {
    const day1 = new Date("2026-09-03T01:00:00Z");
    await markWorkbenchVisit(db, userId, ["below_lead"], day1);
    const day2 = new Date("2026-09-04T01:00:00Z");
    const first = await markWorkbenchVisit(db, userId, ["below_lead", "sales_spike"], day2);
    expect(first.newKeys).toEqual(["sales_spike"]);

    // 一分钟后刷新一次
    const refresh = await markWorkbenchVisit(
      db,
      userId,
      ["below_lead", "sales_spike"],
      new Date(day2.getTime() + 60_000),
    );
    expect(refresh.newKeys, "刷新不得把「新增」标记吃掉").toEqual(["sales_spike"]);
    // 「上次访问」在整段会话内固定指向上一段会话，不会随刷新往前爬
    expect(new Date(refresh.since!).toISOString()).toBe(day1.toISOString());

    // 距最近一次请求（day2 + 60s）再隔一个窗口才算新的一次访问，基线这时才顺移
    const later = await markWorkbenchVisit(
      db,
      userId,
      ["below_lead", "sales_spike"],
      new Date(day2.getTime() + 60_000 + WORKBENCH_VISIT_GAP_MS + 1000),
    );
    expect(later.newKeys, "上一段会话已经看过 sales_spike，新会话不该再标它").toEqual([]);
    expect(new Date(later.since!).toISOString()).toBe(new Date(day2.getTime() + 60_000).toISOString());
  });

  it("标记是每个用户各一份：另一个人的访问不影响我的基线", async () => {
    const [other] = await db.insert(users).values({ name: "计划员", roles: ["pmc"] }).returning();
    const t0 = new Date("2026-09-03T01:00:00Z");
    await markWorkbenchVisit(db, userId, ["below_lead"], t0);
    const otherFirst = await markWorkbenchVisit(db, other.id, ["below_lead"], t0);
    expect(otherFirst.firstVisit, "别人的第一次仍是第一次").toBe(true);

    const t1 = new Date("2026-09-04T01:00:00Z");
    const mine = await markWorkbenchVisit(db, userId, ["below_lead", "stale_data"], t1);
    expect(mine.newKeys).toEqual(["stale_data"]);
  });

  it("接线到工作台聚焦：有登录人才有「自上次访问」，每日摘要的全局视角没有", async () => {
    const { getWorkbenchFocus } = await import("@/server/modules/workbench/focus");
    const user = { id: userId, name: "总监", roles: ["pmc"], isApprover: false };
    const mine = await getWorkbenchFocus(["pmc"], db, user);
    expect(mine.sinceLastVisit, "登录人视角必须带上「自上次访问」摘要").not.toBeNull();
    expect(mine.sinceLastVisit?.firstVisit).toBe(true);
    expect(mine.sinceLastVisit?.newCount).toBe(0);

    // 每日摘要（report/digest）不传 user——那不是「某个人的上一次访问」，不得伪造
    const digestView = await getWorkbenchFocus(["pmc"], db);
    expect(digestView.sinceLastVisit).toBeNull();
    expect(digestView.exceptions.every((e) => e.newSinceLastVisit === undefined)).toBe(true);
  });

  it("非法 userId 直接降级为「无标记」，不写库", async () => {
    const delta = await markWorkbenchVisit(db, 0, ["below_lead"]);
    expect(delta).toEqual({ newKeys: [], since: null, firstVisit: true });
    const rows = await db.select().from(workbenchVisits);
    expect(rows).toHaveLength(0);
  });
});
