/**
 * W2 工作台「自上次访问以来有什么变化」（workbench/visit-marker + focus 的标记接线）。
 *
 * 五件事必须成立，缺一这个功能就是噪音：
 *  1. **首次访问不标新增**——第一次见到就整屏飘红等于没有信息；
 *  2. 下一次访问只标**上次没见过**的那几条（纯事实比对，不评分、不改排序、不过滤）；
 *  3. 会话窗口内的重复请求**不推进基线**——否则用户按一下刷新，刚才那条「新增」就永远消失了，
 *     而这正是本功能要解决的问题本身；
 *  4. **条目级**变化要看得见：例外键是分类，`inventory_cover` 从 2 个 SKU 涨到 200 个 SKU
 *     键一个字都没变，只比键就会写出「上次访问后无新增」；
 *  5. **记忆表不可用 ≠ 首次访问**：迁移没跑时曾一律返回 firstVisit:true，
 *     于是一个坏掉的功能永远伪装成「首次访问」这个正常状态。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { users, workbenchVisits } from "@/db/schema";
import {
  diffVisitEntries,
  isNewVisit,
  markWorkbenchVisit,
  newSinceLastVisit,
  parseSeenEntries,
  parseSeenKeys,
  WORKBENCH_VISIT_GAP_MS,
  type VisitSnapshotEntry,
} from "@/server/modules/workbench/visit-marker";
import { createTestDb, type TestDb } from "../helpers/db";

/** 快照条目：键 + 该分类下的条目数 */
const e = (k: string, c: number | null = 1): VisitSnapshotEntry => ({ k, c });

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

  it("旧格式快照（纯键数组）读回来条目数为未知（null），不被当成 0", () => {
    expect(parseSeenEntries('["a","b"]')).toEqual([{ k: "a", c: null }, { k: "b", c: null }]);
    expect(parseSeenEntries([{ k: "a", c: 7 }])).toEqual([{ k: "a", c: 7 }]);
    expect(parseSeenEntries([{ c: 7 }, { k: "b", c: "x" }])).toEqual([{ k: "b", c: null }]);
  });
});

describe("条目级比对（分类键不变、里面的条目变多也是变化）", () => {
  it("同一个键条目数从 2 涨到 200 → grownKeys 命中（这正是「无新增」谎报的那一晚）", () => {
    const d = diffVisitEntries([e("inventory_cover", 2)], [e("inventory_cover", 200)]);
    expect(d.newKeys, "键没变，不算新出现").toEqual([]);
    expect(d.grownKeys, "条目数变多必须被看见").toEqual(["inventory_cover"]);
    expect(d.previousCounts.inventory_cover).toBe(2);
  });

  it("条目数持平或减少都不算变化（只标增，不制造噪音）", () => {
    expect(diffVisitEntries([e("a", 5)], [e("a", 5)]).grownKeys).toEqual([]);
    expect(diffVisitEntries([e("a", 5)], [e("a", 1)]).grownKeys).toEqual([]);
  });

  it("上次条目数未知（旧格式快照）时不判增长——宁可漏标，不凭空造假新增", () => {
    const d = diffVisitEntries([e("a", null)], [e("a", 200)]);
    expect(d.grownKeys).toEqual([]);
    expect(d.previousCounts.a).toBeNull();
  });

  it("新出现的键仍走 newKeys；首次访问（基线 null）两边都空", () => {
    expect(diffVisitEntries([e("a", 1)], [e("a", 1), e("b", 1)]).newKeys).toEqual(["b"]);
    const first = diffVisitEntries(null, [e("a", 1)]);
    expect(first.newKeys).toEqual([]);
    expect(first.grownKeys).toEqual([]);
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

  it("首次访问：不标新增，since=null，state=first_visit，并写下基线", async () => {
    const first = await markWorkbenchVisit(db, userId, [e("below_lead"), e("expired_stock")]);
    expect(first.firstVisit).toBe(true);
    expect(first.state).toBe("first_visit");
    expect(first.newKeys).toEqual([]);
    expect(first.since).toBeNull();

    const [row] = await db.select().from(workbenchVisits);
    expect(parseSeenKeys(row.lastSeenKeys)).toEqual(["below_lead", "expired_stock"]);
    expect(parseSeenKeys(row.baselineKeys)).toEqual(["below_lead", "expired_stock"]);
  });

  it("快照落库带条目数：隔天同一个键条目数变多也算变化", async () => {
    const day1 = new Date("2026-09-03T01:00:00Z");
    await markWorkbenchVisit(db, userId, [e("inventory_cover", 2)], day1);
    const [row] = await db.select().from(workbenchVisits);
    expect(parseSeenEntries(row.lastSeenKeys), "落库必须带条目数，否则隔天无从比较")
      .toEqual([{ k: "inventory_cover", c: 2 }]);

    const day2 = new Date("2026-09-04T01:00:00Z");
    const delta = await markWorkbenchVisit(db, userId, [e("inventory_cover", 200)], day2);
    expect(delta.newKeys).toEqual([]);
    expect(delta.grownKeys, "2 → 200 个 SKU 必须标出来").toEqual(["inventory_cover"]);
    expect(delta.previousCounts.inventory_cover).toBe(2);
    expect(delta.state).toBe("compared");
  });

  it("隔天再来：只有上次没见过的那条被标为新增，并给出上次访问时刻", async () => {
    const day1 = new Date("2026-09-03T01:00:00Z");
    await markWorkbenchVisit(db, userId, [e("below_lead")], day1);
    const day2 = new Date("2026-09-04T01:00:00Z");
    const delta = await markWorkbenchVisit(db, userId, [e("below_lead"), e("sales_spike")], day2);

    expect(delta.firstVisit).toBe(false);
    expect(delta.newKeys).toEqual(["sales_spike"]);
    expect(new Date(delta.since!).toISOString()).toBe(day1.toISOString());
  });

  it("会话窗口内刷新：基线不动，同一条仍然被标为新增（刷新不该抹掉标记）", async () => {
    const day1 = new Date("2026-09-03T01:00:00Z");
    await markWorkbenchVisit(db, userId, [e("below_lead")], day1);
    const day2 = new Date("2026-09-04T01:00:00Z");
    const first = await markWorkbenchVisit(db, userId, [e("below_lead"), e("sales_spike")], day2);
    expect(first.newKeys).toEqual(["sales_spike"]);

    // 一分钟后刷新一次
    const refresh = await markWorkbenchVisit(
      db,
      userId,
      [e("below_lead"), e("sales_spike")],
      new Date(day2.getTime() + 60_000),
    );
    expect(refresh.newKeys, "刷新不得把「新增」标记吃掉").toEqual(["sales_spike"]);
    // 「上次访问」在整段会话内固定指向上一段会话，不会随刷新往前爬
    expect(new Date(refresh.since!).toISOString()).toBe(day1.toISOString());

    // 距最近一次请求（day2 + 60s）再隔一个窗口才算新的一次访问，基线这时才顺移
    const later = await markWorkbenchVisit(
      db,
      userId,
      [e("below_lead"), e("sales_spike")],
      new Date(day2.getTime() + 60_000 + WORKBENCH_VISIT_GAP_MS + 1000),
    );
    expect(later.newKeys, "上一段会话已经看过 sales_spike，新会话不该再标它").toEqual([]);
    expect(new Date(later.since!).toISOString()).toBe(new Date(day2.getTime() + 60_000).toISOString());
  });

  it("标记是每个用户各一份：另一个人的访问不影响我的基线", async () => {
    const [other] = await db.insert(users).values({ name: "计划员", roles: ["pmc"] }).returning();
    const t0 = new Date("2026-09-03T01:00:00Z");
    await markWorkbenchVisit(db, userId, [e("below_lead")], t0);
    const otherFirst = await markWorkbenchVisit(db, other.id, [e("below_lead")], t0);
    expect(otherFirst.firstVisit, "别人的第一次仍是第一次").toBe(true);

    const t1 = new Date("2026-09-04T01:00:00Z");
    const mine = await markWorkbenchVisit(db, userId, [e("below_lead"), e("stale_data")], t1);
    expect(mine.newKeys).toEqual(["stale_data"]);
  });

  it("接线到工作台聚焦：有登录人才有「自上次访问」，每日摘要的全局视角没有", async () => {
    const { getWorkbenchFocus } = await import("@/server/modules/workbench/focus");
    const user = { id: userId, name: "总监", roles: ["pmc"], isApprover: false };
    const mine = await getWorkbenchFocus(["pmc"], db, user);
    expect(mine.sinceLastVisit, "登录人视角必须带上「自上次访问」摘要").not.toBeNull();
    expect(mine.sinceLastVisit?.firstVisit).toBe(true);
    expect(mine.sinceLastVisit?.state).toBe("first_visit");
    expect(mine.sinceLastVisit?.newCount).toBe(0);
    expect(mine.sinceLastVisit?.grownCount).toBe(0);

    // 每日摘要（report/digest）不传 user——那不是「某个人的上一次访问」，不得伪造
    const digestView = await getWorkbenchFocus(["pmc"], db);
    expect(digestView.sinceLastVisit).toBeNull();
    expect(digestView.exceptions.every((e2) => e2.newSinceLastVisit === undefined)).toBe(true);
  });

  it("非法 userId 直接降级为「无标记」，且**不谎称首次访问**，不写库", async () => {
    const delta = await markWorkbenchVisit(db, 0, [e("below_lead")]);
    expect(delta.state, "拿不到标记 ≠ 这是你的第一次访问").toBe("unavailable");
    expect(delta.firstVisit).toBe(false);
    expect(delta.newKeys).toEqual([]);
    expect(delta.grownKeys).toEqual([]);
    const rows = await db.select().from(workbenchVisits);
    expect(rows).toHaveLength(0);
  });

  it("记忆表不可用（迁移未跑）：state=unavailable，firstVisit=false——坏掉的功能不得伪装成正常状态", async () => {
    await db.execute("DROP TABLE IF EXISTS workbench_visits CASCADE");
    const delta = await markWorkbenchVisit(db, userId, [e("below_lead")]);
    expect(delta.state).toBe("unavailable");
    expect(delta.firstVisit, "表不可用被报成「首次访问」时，界面会永远显示首次访问").toBe(false);
  });
});
