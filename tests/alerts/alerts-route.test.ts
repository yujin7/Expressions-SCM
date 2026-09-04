/**
 * /api/alerts 列表路由（UX 走查）：category / severity / acked=0 筛选、page/pageSize 分页、total 与 ackedByName 下发。
 * 数据库用 PGlite（getDbAsync mock 到测试库），鉴权 mock。
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { ackAlert, closeAlert, upsertAlerts } from "@/server/modules/alerts/engine";

const mocks = vi.hoisted(() => ({ guardRead: vi.fn(), db: null as unknown }));
vi.mock("@/db", () => ({ getDbAsync: vi.fn(async () => mocks.db) }));
vi.mock("@/server/modules/master/common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/modules/master/common")>();
  return { ...original, guardRead: mocks.guardRead };
});

import { GET } from "@/app/api/alerts/route";

interface Row {
  id: number; category: string; severity: string | null; ackedAt: string | null; ackedByName: string | null;
  dedupeKey: string | null; ownerRole: string | null; sourceRule: string | null; paramsSnapshot: Record<string, unknown> | null;
  autoResolved?: boolean;
  closeReasonCode?: string | null; closeNote?: string | null; closedAt?: string | null; closedByName?: string | null;
}
interface Body { rows: Row[]; total: number; page: number; pageSize: number }

describe("/api/alerts 列表：筛选、分页、总数、知悉人", () => {
  let db: TestDb;
  let client: { close: () => Promise<void> };
  let userId = 0;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db; client = t.client; mocks.db = db;
    const [u] = await db.insert(schema.users).values({ name: "计划员", roles: ["pmc"] }).returning();
    userId = u.id;
    const cand = (k: string, severity: "high" | "medium") => ({ refKey: k, dedupeKey: `sales_spike:sku:${k}`, title: `爆单 ${k}`, severity, ownerRole: "ops", sourceRule: "rules/sales-spike", paramsSnapshot: { risePct: 50, anchorDate: "2026-09-03" } });
    await upsertAlerts(db, { category: "sales_spike", candidates: [cand("1", "high"), cand("2", "high"), cand("3", "medium")] });
    await upsertAlerts(db, { category: "inventory_cover", candidates: [{ refKey: "N1", dedupeKey: "inventory_cover:9", title: "断货", severity: "high", ownerRole: "pmc" }] });
    const [a1] = await db.select().from(schema.systemAlerts).where(schema.systemAlerts.refKey === undefined ? undefined : undefined).limit(1);
    void a1;
    const first = (await db.select({ id: schema.systemAlerts.id }).from(schema.systemAlerts).orderBy(schema.systemAlerts.id).limit(1))[0];
    await ackAlert({ id: userId, name: "计划员", roles: ["pmc"], isApprover: false }, first.id, db);
    mocks.guardRead.mockResolvedValue({ id: userId, name: "计划员", roles: ["pmc"], isApprover: false });
  });
  afterAll(async () => { await client.close(); });

  const call = async (qs: string): Promise<Body> => {
    const res = await GET(new NextRequest(`http://localhost/api/alerts${qs}`));
    expect(res.status).toBe(200);
    return (await res.json()) as Body;
  };

  it("缺省 status=open 返回全部类别，带 total 与分页元数据", async () => {
    const body = await call("");
    expect(body.total).toBe(4);
    expect(body.rows).toHaveLength(4);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    // 引擎字段原样下发（前端展开行渲染规则来源 / 参数快照 / 责任角色）
    const spike = body.rows.find((r) => r.category === "sales_spike")!;
    expect(spike.sourceRule).toBe("rules/sales-spike");
    expect(spike.paramsSnapshot).toMatchObject({ risePct: 50 });
    expect(spike.ownerRole).toBe("ops");
    expect(spike.dedupeKey).toMatch(/^sales_spike:sku:/);
  });

  it("category / severity / acked=0 筛选，total 随筛选变化", async () => {
    expect((await call("?category=sales_spike")).total).toBe(3);
    expect((await call("?category=inventory_cover")).total).toBe(1);
    expect((await call("?severity=medium")).total).toBe(1);
    const unacked = await call("?category=sales_spike&acked=0");
    expect(unacked.total).toBe(2);
    expect(unacked.rows.every((r) => r.ackedAt == null)).toBe(true);
  });

  it("已知悉的行带 ackedByName；分页 pageSize=2 取第 2 页只剩余量", async () => {
    const all = await call("?category=sales_spike");
    const acked = all.rows.find((r) => r.ackedAt != null)!;
    expect(acked.ackedByName).toBe("计划员");
    const p2 = await call("?category=sales_spike&page=2&pageSize=2");
    expect(p2.total).toBe(3);
    expect(p2.rows).toHaveLength(1);
    expect(p2.pageSize).toBe(2);
  });

  it("status=resolved 没有行时 total=0", async () => {
    const body = await call("?status=resolved");
    expect(body.total).toBe(0);
    expect(body.rows).toEqual([]);
  });

  /* W2：已关闭视图必须回答"为什么关的、谁关的"。关闭原因只存在 alert_events 台账里，
     列表不带出来的话，误报复盘与阈值调参就只能靠猜（这正是 W2 立项的证据）。 */
  it("status=resolved 的行带最近一条 close 事件的原因/备注/关闭人", async () => {
    const [target] = await db.select({ id: schema.systemAlerts.id })
      .from(schema.systemAlerts).orderBy(schema.systemAlerts.id).limit(1);
    await closeAlert(
      { id: userId, name: "计划员", roles: ["ops"], isApprover: false },
      target.id, "false_positive", "基线窗口缺 4 天，涨幅虚高", db,
    );

    const body = await call("?status=resolved");
    expect(body.total).toBe(1);
    const row = body.rows[0];
    expect(row.id).toBe(target.id);
    expect(row.autoResolved).toBe(false);
    expect(row.closeReasonCode).toBe("false_positive");
    expect(row.closeNote).toBe("基线窗口缺 4 天，涨幅虚高");
    expect(row.closedByName).toBe("计划员");
    expect(row.closedAt).toBeTruthy();
  });

  it("open 列表不做 close 台账查询，行上不带关闭字段（避免误读为已关闭）", async () => {
    const body = await call("?status=open");
    expect(body.rows.every((r) => r.closeReasonCode === undefined)).toBe(true);
  });
});
