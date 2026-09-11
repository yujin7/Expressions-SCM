/**
 * 「当月 S&OP 已冻结」必须**开屏就能看见**，而不是勾满 200 行、点提交才吃 409。
 *
 * 此前补货页从不问这件事：闸门只长在写路径（`assertLiveSuggestionsWritable`），
 * 用户先做完全部筛选与勾选，最后收到一句 409——白干一轮，还容易被读成系统故障。
 * 现在 `/api/replenish/sop`（`getSopWorkspace`）下发 `liveSuggestionsFreeze`，
 * 与闸门**同一个查询**（`getLiveSuggestionsFreeze`），页面据此渲染横幅并禁用「生成草稿」。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { planningVersions, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  assertLiveSuggestionsWritable,
  createSopCycle,
  decideSopCycle,
  getLiveSuggestionsFreeze,
  getSopWorkspace,
  transitionSopCycle,
} from "@/server/modules/replenish/sop-cycle";
import { createTestDb, type TestDb } from "../helpers/db";

/** 上海当月——与服务端判定同口径 */
function currentShanghaiMonth(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" })
    .format(now).slice(0, 7);
}

describe("补货页开屏横幅：当月 S&OP 冻结状态由 /api/replenish/sop 下发", () => {
  let db: TestDb;
  let pmc: SessionUser;
  let ops: SessionUser;
  let finance: SessionUser;
  let cycleId = 0;
  const month = currentShanghaiMonth();

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const people = await db.insert(users).values([
      { name: "F-PMC", roles: ["pmc"] },
      { name: "F-运营", roles: ["ops"] },
      { name: "F-财务", roles: ["finance"] },
    ]).returning();
    pmc = { id: people[0].id, name: people[0].name, roles: ["pmc"], isApprover: false };
    ops = { id: people[1].id, name: people[1].name, roles: ["ops"], isApprover: false };
    finance = { id: people[2].id, name: people[2].name, roles: ["finance"], isApprover: false };
    const [plan] = await db.insert(planningVersions).values({
      name: "本月基线", weekStart: "2026-09-01", engineVersion: "test",
      parameters: {}, sourceMeta: {}, lineCount: 5, suggestedCount: 2, suppressedCount: 0,
      digest: "c".repeat(64), idempotencyKey: "freeze-plan-1", createdBy: pmc.id,
    }).returning();
    const cycle = await createSopCycle(pmc, {
      month, name: `${month} 数量计划`, planningVersionId: plan.id,
      idempotencyKey: "0f0ba9a3-8f39-4a08-9a6e-8f2f6f6b1a11",
    }, db);
    cycleId = cycle.id;
  });

  it("共识阶段：未冻结，页面不该拦人", async () => {
    const ws = await getSopWorkspace(pmc, db);
    expect(ws.liveSuggestionsFreeze).toMatchObject({ frozen: false, cycle: null, month });
    await expect(assertLiveSuggestionsWritable(db)).resolves.toBeUndefined();
  });

  it("冻结后：workspace 立刻给出 frozen + 是哪个周期在冻结，且与写闸门同源", async () => {
    await decideSopCycle(ops, { cycleId, version: 1, role: "ops", decision: "agree" }, db);
    await decideSopCycle(pmc, { cycleId, version: 1, role: "pmc", decision: "agree" }, db);
    await decideSopCycle(finance, { cycleId, version: 1, role: "finance", decision: "agree" }, db);
    await transitionSopCycle(pmc, { cycleId, version: 1, target: "frozen" }, db);

    const ws = await getSopWorkspace(pmc, db);
    expect(ws.liveSuggestionsFreeze.frozen).toBe(true);
    expect(ws.liveSuggestionsFreeze.cycle).toMatchObject({ id: cycleId, month, status: "frozen" });

    // 同源：横幅说冻结，闸门就一定拒；反之亦然
    const gate = await getLiveSuggestionsFreeze(db);
    expect(gate).toEqual(ws.liveSuggestionsFreeze);
    await expect(assertLiveSuggestionsWritable(db)).rejects.toMatchObject({ status: 409 });
  });

  it("执行中同样锁死（executing 也不允许从实时建议开草稿）", async () => {
    await transitionSopCycle(pmc, { cycleId, version: 1, target: "executing" }, db);
    const ws = await getSopWorkspace(pmc, db);
    expect(ws.liveSuggestionsFreeze.frozen).toBe(true);
    expect(ws.liveSuggestionsFreeze.cycle?.status).toBe("executing");
  });

  it("周期关闭后解锁", async () => {
    await transitionSopCycle(pmc, { cycleId, version: 1, target: "closed" }, db);
    const ws = await getSopWorkspace(pmc, db);
    expect(ws.liveSuggestionsFreeze).toMatchObject({ frozen: false, cycle: null });
    await expect(assertLiveSuggestionsWritable(db)).resolves.toBeUndefined();
  });
});
