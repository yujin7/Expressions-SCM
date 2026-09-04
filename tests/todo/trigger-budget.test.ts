/**
 * 红队审计 A1：待办投影窗口的预算与排序（modules/todo/triggers）。
 *
 * 修复前：告警按 id **升序**取 limit(500)，复核只拿 `limit − alerts.length` 个名额。
 * 于是 open 告警一攒到 500 条：
 *  - 窗口被最老的、早就投影过的告警占满 → 新告警永远进不来；
 *  - 复核项（含 blocked*）名额恒为 0 → 一条都投影不出去；
 *  - 汇总还报 scanned/matched = 500，看上去一切正常。
 * 修复后：两条来源各有独立预算；排序把「还没有在办待办的 / 严重度高的 / 新的」放前面；
 * 预算打满时 summary.truncated = true。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { reviewItems, systemAlerts, users, workItems } from "@/db/schema";
import { collectTodoCandidatesDetailed } from "@/server/modules/todo/triggers";
import { runTodoSync } from "@/jobs/todo-sync";
import { createTestDb, type TestDb } from "../helpers/db";

const NOW = new Date("2026-09-03T01:00:00Z");
const OLD_ALERTS = 600;

describe("todo/triggers：告警与复核各有独立预算，不互相饿死（红队 A1）", () => {
  let db: TestDb;
  let newAlertId: number;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [admin] = await db.insert(users).values({ name: "管理员", roles: ["admin"], isApprover: false }).returning();
    const [pmc] = await db.insert(users).values({ name: "计划", roles: ["pmc"], isApprover: false }).returning();

    // 600 条早已投影、且待办仍在办的老告警（真实的告警风暴形态）
    const olds = await db.insert(systemAlerts).values(
      Array.from({ length: OLD_ALERTS }, (_, i) => ({
        category: "inventory_cover", refKey: `OLD-${i}`, title: `老告警 ${i}`, severity: "medium", status: "open",
      })),
    ).returning({ id: systemAlerts.id });
    await db.insert(workItems).values(olds.map((a) => ({
      title: `老待办 ${a.id}`, assigneeId: pmc.id, assignerId: admin.id, createdBy: admin.id,
      ownerRole: "pmc", status: "open", sourceKind: "alert", sourceRef: String(a.id),
    })));

    // 5 条 open 的 blocked 复核项（修复前名额恒为 0）
    await db.insert(reviewItems).values(Array.from({ length: 5 }, (_, i) => ({
      category: "blocked_release", refType: "sku", refKey: `BLK-${i}`, title: `阻断 ${i}`, status: "open",
    })));

    // 一条刚开出来的新告警（修复前排在第 601 位，永远进不了窗口）
    const [fresh] = await db.insert(systemAlerts).values({
      category: "inventory_cover", refKey: "FRESH", title: "新断货告警", severity: "high", status: "open",
    }).returning({ id: systemAlerts.id });
    newAlertId = fresh.id;
  });

  it("600 条老告警 + 5 条 blocked 复核：复核照样投影，新告警也进得来", async () => {
    const r = await collectTodoCandidatesDetailed(db);
    // 复核预算独立：5 条全在（修复前是 0）
    const reviews = r.candidates.filter((c) => c.sourceKind === "review");
    expect(reviews).toHaveLength(5);
    expect(r.reviewsScanned).toBe(5);
    // 新告警进得来（修复前按 id 升序被 600 条老告警挤在窗口外）
    expect(r.candidates.some((c) => c.sourceKind === "alert" && c.sourceRef === String(newAlertId))).toBe(true);
    // 告警仍按预算截断，但这件事被显式上报，而不是伪装成"扫了 500 条全命中"
    expect(r.alertsScanned).toBe(500);
    expect(r.truncated).toBe(true);
  });

  it("预算截断随投影汇总一起上报（jobs/todo-sync）", async () => {
    const s = await runTodoSync(db, { now: NOW, feishuConfigured: false });
    expect(s.projection?.truncated).toBe(true);
    // 新告警与 5 条复核确实落成了新待办
    const created = await db.select().from(workItems);
    expect(created.filter((w) => w.sourceKind === "review")).toHaveLength(5);
    expect(created.some((w) => w.sourceKind === "alert" && w.sourceRef === String(newAlertId))).toBe(true);
  });

  it("预算没打满时 truncated = false", async () => {
    const r = await collectTodoCandidatesDetailed(db, { limit: 5000 });
    expect(r.truncated).toBe(false);
    expect(r.alertsScanned).toBe(OLD_ALERTS + 1);
  });
});
