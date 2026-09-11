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
import { ApiError } from "@/server/modules/master/common";

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
    // S2：ack 现在与 close 同权限——该行 ownerRole=ops，故以 ops 身份知悉（列表读仍用 pmc 会话）
    await ackAlert({ id: userId, name: "计划员", roles: ["ops"], isApprover: false }, first.id, db);
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

  it("精确 ID 忽略陈旧状态/类别/严重度/知悉/搜索/页码，保留关闭原因和脱敏", async () => {
    const [target] = await db.insert(schema.systemAlerts).values({
      category: "inventory_cover", title: "精确来源告警", severity: "high", ownerRole: "pmc",
      paramsSnapshot: { amount: "123.00", safeCount: 7 },
    }).returning();
    const actor = { id: userId, name: "计划员", roles: ["pmc"], isApprover: false };
    await ackAlert(actor, target.id, db);
    await closeAlert(actor, target.id, "false_positive", "已核对来源", db);
    const query = `?id=${target.id}&status=open&category=other&severity=low&acked=0&q=not-found&page=99&pageSize=1`;
    const body = await call(query);
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.rows.map((r) => r.id)).toEqual([target.id]);
    expect(body.rows[0]).toMatchObject({
      ackedByName: "计划员", closeReasonCode: "false_positive", closeNote: "已核对来源", closedByName: "计划员",
      paramsSnapshot: { safeCount: 7 },
    });
    // R9 explicitly allows PMC to see prices; use the same focused record under an ops
    // session to test masking, rather than accidentally requiring a stricter product policy.
    expect(body.rows[0].paramsSnapshot?.amount).toBe("123.00");
    mocks.guardRead.mockResolvedValueOnce({ id: userId, name: "运营", roles: ["ops"], isApprover: false });
    const masked = await call(query);
    expect(masked.total).toBe(1);
    expect(masked.page).toBe(1);
    expect(masked.rows[0]).toMatchObject({ id: target.id, closeReasonCode: "false_positive", paramsSnapshot: { safeCount: 7 } });
    expect(masked.rows[0].paramsSnapshot).not.toHaveProperty("amount");
  });

  it("不存在的精确 ID 返回空结果，不回落到其他告警", async () => {
    const body = await call("?id=2147483647&page=99");
    expect(body).toMatchObject({ total: 0, rows: [], page: 1 });
  });

  it.each(["", " ", "0", "-1", "+1", "01", "1.0", "1e2", "0x10", "NaN", "2147483648", "https://example.com"])("非法精确 ID %j 返回安全 400", async (id) => {
    const response = await GET(new NextRequest(`http://localhost/api/alerts?${new URLSearchParams({ id })}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
  });

  it("精确 ID 不绕过认证", async () => {
    mocks.guardRead.mockRejectedValueOnce(new ApiError(401, "未登录"));
    const response = await GET(new NextRequest("http://localhost/api/alerts?id=1"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "未登录" });
  });

  it("精确 ID 仍按店铺渠道裁剪；范围外/未知/混合归属不能泄露行或 total", async () => {
    await db.insert(schema.aliases).values([
      { aliasType: "channel", scope: "JIANDAOYUN", rawValue: "范围内店", targetId: 11 },
      { aliasType: "channel", scope: "JIANDAOYUN", rawValue: "范围外店", targetId: 22 },
    ]);
    const targets = await db.insert(schema.systemAlerts).values([
      { category: "sales_spike", title: "本渠道", dedupeKey: "sales_spike:platform:范围内店|SKU1" },
      { category: "sales_spike", title: "其他渠道", dedupeKey: "sales_spike:platform:范围外店|SKU2" },
      { category: "sales_spike", title: "未映射", dedupeKey: "sales_spike:platform:未知店|SKU3" },
      { category: "sales_spike", title: "跨渠道汇总", detail: "店铺 范围内店、范围外店；聚合数量", dedupeKey: "sales_spike:sku:88" },
    ]).returning();
    const restricted = { id: userId, name: "运营", roles: ["ops"], isApprover: false, channelScope: [11], deptScope: ["ops"] };
    mocks.guardRead.mockResolvedValue(restricted);
    try {
      const own = await call(`?id=${targets[0].id}&category=other&severity=high&page=99`);
      expect(own.total).toBe(1);
      expect(own.rows.map((r) => r.id)).toEqual([targets[0].id]);
      for (const target of targets.slice(1)) {
        const body = await call(`?id=${target.id}&page=99`);
        expect(body.total).toBe(0);
        expect(body.rows).toEqual([]);
      }
      mocks.guardRead.mockResolvedValue({ ...restricted, channelScope: [] });
      expect((await call(`?id=${targets[0].id}`)).rows).toEqual([]);
      mocks.guardRead.mockResolvedValue({ ...restricted, roles: ["admin"] });
      expect((await call(`?id=${targets[1].id}`)).rows.map((r) => r.id)).toEqual([targets[1].id]);
    } finally {
      mocks.guardRead.mockResolvedValue({ id: userId, name: "计划员", roles: ["pmc"], isApprover: false });
    }
  });
});
