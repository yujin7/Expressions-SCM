/**
 * 待办真实截止日（闭环审计 #9）：断货告警 paramsSnapshot.orderByDate（最晚下单日）→ 待办 dueDate；
 * 已过去的按今天计；缺失/非法回退 {3,7,14} 缺省表。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { systemAlerts, users, workItems } from "@/db/schema";
import { runTodoSync } from "@/jobs/todo-sync";
import { alertToCandidate, dueDateFromParamsSnapshot, reviewToCandidate } from "@/server/rules/task-triggers";
import { createTestDb, type TestDb } from "../helpers/db";

const NOW = new Date("2026-09-03T01:00:00Z"); // 上海 09-03 09:00

describe("rules/task-triggers：dueDate 来自 paramsSnapshot.orderByDate", () => {
  it("纯函数：合法日期透传，非法/缺失 → null；复核项永远 null", () => {
    expect(dueDateFromParamsSnapshot({ orderByDate: "2026-09-20" })).toBe("2026-09-20");
    expect(dueDateFromParamsSnapshot({ orderByDate: "2026/09/20" })).toBeNull();
    expect(dueDateFromParamsSnapshot({ orderByDate: 20260920 })).toBeNull();
    expect(dueDateFromParamsSnapshot({})).toBeNull();
    expect(dueDateFromParamsSnapshot(null)).toBeNull();
    expect(dueDateFromParamsSnapshot(undefined)).toBeNull();
    const base = { id: 1, category: "inventory_cover", refKey: "X", title: "t", detail: null, severity: "high" };
    expect(alertToCandidate({ ...base, paramsSnapshot: { orderByDate: "2026-09-20", coverDays: 3 } }).dueDate).toBe("2026-09-20");
    expect(alertToCandidate(base).dueDate).toBeNull();
    expect(reviewToCandidate({ id: 2, category: "blocked_x", refType: null, refKey: null, title: "r", detail: null }).dueDate).toBeNull();
  });
});

describe("todo 投影：截止日取最晚下单日", () => {
  let db: TestDb;
  beforeAll(async () => {
    ({ db } = await createTestDb());
    await db.insert(users).values([{ name: "管理员", roles: ["admin"] }, { name: "计划", roles: ["pmc"] }]);
    await db.insert(systemAlerts).values([
      { category: "inventory_cover", refKey: "FUT", title: "未来窗口", severity: "high", status: "open", paramsSnapshot: { orderByDate: "2026-09-20", priorityScore: "12.5" } },
      { category: "inventory_cover", refKey: "PAST", title: "窗口已过", severity: "high", status: "open", paramsSnapshot: { orderByDate: "2026-08-01" } },
      { category: "inventory_cover", refKey: "NONE", title: "无快照", severity: "high", status: "open" },
      { category: "sales_spike", refKey: "SPK", title: "爆单（medium）", severity: "medium", status: "open", paramsSnapshot: { anchorDate: "2026-09-02" } },
    ]);
  });

  it("未来最晚下单日 → 原样；已过 → 今天；无快照 → high 3 天 / normal 7 天缺省", async () => {
    const s = await runTodoSync(db, { now: NOW, feishuConfigured: false });
    expect(s.projection).toMatchObject({ created: 4, failed: 0 });
    const items = await db.select().from(workItems);
    const due = (title: string) => items.find((i) => i.title === title)?.dueDate;
    expect(due("未来窗口")).toBe("2026-09-20");
    expect(due("窗口已过")).toBe("2026-09-03");
    expect(due("无快照")).toBe("2026-09-06");
    expect(due("爆单（medium）")).toBe("2026-09-10");
  });
});
