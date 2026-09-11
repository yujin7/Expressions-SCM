/**
 * 安全审计 S3：`/alerts` 与 `/inventory/alerts` 在 route-access 里标了 `channel_scoped`，
 * 但 `/api/alerts` 与 `/api/report/sales-spike` 一直没有任何渠道过滤——而爆单预警的
 * 标题/详情/去重键里直接写着**店铺名与平台 SKU**，受限渠道账号照样读得到别人家店的爆单。
 * 驾驶舱第 4 屏的 `alertLifecycle.recurrence[].dedupeKey`（同样编码 店铺|平台SKU）是第三个出口，
 * 它的兄弟块（外部需求、四象限）早就按 scope.forced 跳过了，只有它原样下发。
 *
 * 口径钉住：
 * - 受限用户只看得到**全部店铺都在自己渠道里**的行；跨店铺汇总行（含范围外店铺）与
 *   归属不明（未映射 / 无法从告警行还原店铺）的行一律剔除——不确定不是可见的理由；
 * - 非店铺维类别（如 inventory_cover）不受影响；
 * - admin 与未登记范围的用户逐字等价于改造前。
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { loadUserScopes } from "@/server/core/data-scope";
import type { SessionUser } from "@/server/core/dto";
import { upsertAlerts } from "@/server/modules/alerts/engine";
import { SHOP_CHANNEL_ALIAS_SCOPE } from "@/server/modules/report/channel-observation";
import { alertShopNames } from "@/server/modules/report/shop-channel-scope";
import { loadAlertLifecycle } from "@/server/modules/report/cockpit-trends";
import { scopedModeForPath } from "@/lib/route-access";
import type { SalesSpikeReadModel, SpikeHit } from "@/server/modules/report/sales-spike";
import { createTestDb, type TestDb } from "../helpers/db";

const TMALL_SHOP = "天猫旗舰店";
const JD_SHOP = "京东自营店";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  guardRead: vi.fn(),
  loadSalesSpike: vi.fn(),
  refreshSalesSpike: vi.fn(),
}));
vi.mock("@/db", () => ({ getDbAsync: vi.fn(async () => mocks.db) }));
vi.mock("@/server/modules/master/common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/modules/master/common")>();
  return { ...original, guardRead: mocks.guardRead };
});
vi.mock("@/server/modules/report/sales-spike", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/modules/report/sales-spike")>(),
  loadSalesSpike: mocks.loadSalesSpike,
  refreshSalesSpike: mocks.refreshSalesSpike,
}));

const { GET: alertsGet } = await import("@/app/api/alerts/route");
const { GET: spikeGet } = await import("@/app/api/report/sales-spike/route");

interface AlertsBody { rows: { id: number; category: string; dedupeKey: string | null; detail: string | null }[]; total: number }

const hit = (shopName: string, platformSkuId: string | null): SpikeHit => ({
  kind: platformSkuId ? "platform" : "sku", skuId: platformSkuId ? null : 1, code: platformSkuId ? null : "CP1",
  name: null, shopName, platformSkuId, anchorDate: "2026-09-03", days: [], baseline: "10", threshold: "15",
  risePct: "80", href: "/inventory/alerts?tab=spike", reason: "连续 3 天", gaps: 0, expected: false,
  planEventRef: null, expectedUpliftPct: null, planEventWindow: null,
});

interface Ctx { db: TestDb; admin: SessionUser; opsTmall: SessionUser; opsFree: SessionUser }

async function seed(): Promise<Ctx> {
  const { db } = await createTestDb();
  mocks.db = db;
  const mk = async (name: string, roles: string[]) => (await db.insert(schema.users).values({ name, roles }).returning())[0];
  const admin = await mk("管理员", ["admin"]);
  const opsTmall = await mk("天猫运营", ["ops"]);
  const opsFree = await mk("未限运营", ["ops"]);
  const [tmall] = await db.insert(schema.channels).values({ code: "TMALL", name: "天猫", kind: "platform" }).returning();
  const [jd] = await db.insert(schema.channels).values({ code: "JD", name: "京东", kind: "platform" }).returning();
  await db.insert(schema.userDataScopes).values([{ userId: opsTmall.id, scopeKind: "channel", targetId: tmall.id, createdBy: admin.id }]);
  // 店铺 → 渠道映射的唯一权威：aliases(channel, JIANDAOYUN)
  await db.insert(schema.aliases).values([
    { aliasType: "channel", scope: SHOP_CHANNEL_ALIAS_SCOPE, rawValue: TMALL_SHOP, targetId: tmall.id },
    { aliasType: "channel", scope: SHOP_CHANNEL_ALIAS_SCOPE, rawValue: JD_SHOP, targetId: jd.id },
  ]);
  await upsertAlerts(db, {
    category: "sales_spike",
    candidates: [
      { refKey: `${TMALL_SHOP}|A1`, dedupeKey: `sales_spike:platform:${TMALL_SHOP}|A1`, title: "爆单（未映射 A1）", detail: `店铺 ${TMALL_SHOP}；基线 10`, severity: "medium", ownerRole: "ops" },
      { refKey: `${JD_SHOP}|B2`, dedupeKey: `sales_spike:platform:${JD_SHOP}|B2`, title: "爆单（未映射 B2）", detail: `店铺 ${JD_SHOP}；基线 20`, severity: "medium", ownerRole: "ops" },
      { refKey: "CP1", dedupeKey: "sales_spike:sku:1", title: "爆单 CP1", detail: `店铺 ${TMALL_SHOP}；基线 30`, severity: "high", ownerRole: "ops" },
      { refKey: "CP2", dedupeKey: "sales_spike:sku:2", title: "爆单 CP2", detail: `店铺 ${TMALL_SHOP}、${JD_SHOP}；基线 40`, severity: "high", ownerRole: "ops" },
      { refKey: "CP3", dedupeKey: "sales_spike:sku:3", title: "爆单 CP3", detail: null, severity: "high", ownerRole: "ops" },
    ],
  });
  await upsertAlerts(db, {
    category: "inventory_cover",
    candidates: [{ refKey: "N1", dedupeKey: "inventory_cover:9", title: "断货", severity: "high", ownerRole: "pmc" }],
  });
  const session = async (u: { id: number; name: string; roles: string[]; isApprover: boolean }): Promise<SessionUser> => ({
    id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, ...(await loadUserScopes(db, u.id)),
  });
  return { db, admin: await session(admin), opsTmall: await session(opsTmall), opsFree: await session(opsFree) };
}

const callAlerts = async (user: SessionUser, qs = ""): Promise<AlertsBody> => {
  mocks.guardRead.mockResolvedValue(user);
  const res = await alertsGet(new NextRequest(`http://localhost/api/alerts${qs}`));
  expect(res.status).toBe(200);
  return (await res.json()) as AlertsBody;
};

describe("S3 /api/alerts：店铺维告警按渠道范围裁剪", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await seed(); });

  it("受限账号只见本渠道店铺的爆单；他人店铺、跨店铺汇总、归属不明的行都不下发", async () => {
    const body = await callAlerts(ctx.opsTmall);
    const keys = body.rows.map((r) => r.dedupeKey);
    expect(keys).toContain(`sales_spike:platform:${TMALL_SHOP}|A1`);
    expect(keys).toContain("sales_spike:sku:1");
    expect(keys).toContain("inventory_cover:9"); // 非店铺维类别不受影响
    expect(keys).not.toContain(`sales_spike:platform:${JD_SHOP}|B2`);
    expect(keys).not.toContain("sales_spike:sku:2"); // 天猫 + 京东汇总行：件数混着别人家的店
    expect(keys).not.toContain("sales_spike:sku:3"); // 还原不出店铺 = 不可归属 = 不下发
    expect(JSON.stringify(body)).not.toContain(JD_SHOP);
    // total 与分页跟着一起裁（先裁剪再分页，不是分页后再删行）
    expect(body.total).toBe(3);
    expect(body.rows).toHaveLength(3);
  });

  it("admin 与未登记范围的账号逐字等价于改造前（6 条全见）", async () => {
    for (const u of [ctx.admin, ctx.opsFree]) {
      const body = await callAlerts(u);
      expect(body.total).toBe(6);
      expect(JSON.stringify(body)).toContain(JD_SHOP);
    }
  });

  it("与既有筛选是 AND：受限账号按 category 筛也拿不到他人渠道的行", async () => {
    const body = await callAlerts(ctx.opsTmall, "?category=sales_spike");
    expect(body.total).toBe(2);
    expect(JSON.stringify(body)).not.toContain(JD_SHOP);
  });

  it("店铺还原：platform 行取自去重键，已映射 SKU 行取自 detail 的「店铺 …」段，都取不到 → null", () => {
    expect(alertShopNames({ category: "sales_spike", dedupeKey: `sales_spike:platform:${TMALL_SHOP}|A1` })).toEqual([TMALL_SHOP]);
    expect(alertShopNames({ category: "sales_spike", dedupeKey: "sales_spike:sku:2", detail: `店铺 ${TMALL_SHOP}、${JD_SHOP}；基线 40` })).toEqual([TMALL_SHOP, JD_SHOP]);
    expect(alertShopNames({ category: "sales_spike", dedupeKey: "sales_spike:sku:3", detail: null })).toBeNull();
  });
});

describe("S3 /api/report/sales-spike：命中行按渠道范围裁剪", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await seed(); });

  const model = (): SalesSpikeReadModel => ({
    key: "sales-spike/v3", builtAt: "2026-09-03T00:00:00.000Z", sourceBinding: "t", state: "ready",
    evaluations: [
      { dedupeKey: "sales_spike:sku:1", shopNames: [TMALL_SHOP], kind: "sku", platformSeries: 1, complete: true, calendar: false },
      { dedupeKey: "sales_spike:sku:2", shopNames: [TMALL_SHOP, JD_SHOP], kind: "sku", platformSeries: 2, complete: false, calendar: true },
    ],
    anchorDate: "2026-09-03", sourceAsOf: "2026-09-03",
    params: { consecutiveDays: 3, risePct: 50, minBaseQty: 5, baselineDays: 7 },
    coverage: { platformSeries: 3, mappedSeries: 2, systemSkus: 2, calendarSkus: 0, calendarPct: null, expectedHits: 0, evaluatedItems: 1, incompleteItems: 1 },
    hits: [hit(TMALL_SHOP, null), hit(`${TMALL_SHOP}、${JD_SHOP}`, null)],
    unmappedHits: [hit(TMALL_SHOP, "A1"), hit(JD_SHOP, "B2")],
    limitations: [],
  });

  const callSpike = async (user: SessionUser) => {
    mocks.loadSalesSpike.mockResolvedValue(model());
    mocks.guardRead.mockResolvedValue(user);
    const res = await spikeGet(new NextRequest("http://localhost/api/report/sales-spike"));
    expect(res.status).toBe(200);
    return (await res.json()) as { hits: SpikeHit[]; unmappedHits: SpikeHit[]; hitCount: number; unmappedCount: number };
  };

  it("受限账号：只留本渠道店铺的命中行，计数同步收敛，响应里不出现他人店铺名", async () => {
    const body = await callSpike(ctx.opsTmall);
    expect(body.hits.map((h) => h.shopName)).toEqual([TMALL_SHOP]);
    expect(body.unmappedHits.map((h) => h.platformSkuId)).toEqual(["A1"]);
    expect(body.hitCount).toBe(1);
    expect(body.unmappedCount).toBe(1);
    expect(JSON.stringify(body)).not.toContain(JD_SHOP);
    expect(body).not.toHaveProperty("evaluations");
    expect(body).toHaveProperty("coverage.incompleteItems", 0);
    expect(body).toHaveProperty("coverage.platformSeries", 1);
  });

  it("admin 不裁剪", async () => {
    const body = await callSpike(ctx.admin);
    expect(body.hits).toHaveLength(2);
    expect(body.unmappedHits).toHaveLength(2);
    expect(JSON.stringify(body)).toContain(JD_SHOP);
  });
});

describe("S3 驾驶舱第 4 屏：受限账号不下发复发去重键", () => {
  it("recurrence 为空且标 recurrenceWithheld；计数类聚合仍下发", async () => {
    const { db } = await seed();
    // 同一去重键再开一次（关掉旧行后重开）才构成"复发对"
    await db.update(schema.systemAlerts).set({ status: "resolved", autoResolved: true, resolvedAt: new Date() });
    await upsertAlerts(db, {
      category: "sales_spike",
      candidates: [{ refKey: `${JD_SHOP}|B2`, dedupeKey: `sales_spike:platform:${JD_SHOP}|B2`, title: "爆单（未映射 B2）", detail: `店铺 ${JD_SHOP}`, severity: "medium", ownerRole: "ops" }],
    });
    const open = await loadAlertLifecycle(db);
    expect(open.recurrence.length).toBeGreaterThan(0);
    expect(open.recurrenceWithheld).toBe(false);
    expect(JSON.stringify(open.recurrence)).toContain(JD_SHOP);

    const scoped = await loadAlertLifecycle(db, { channelScopeForced: true });
    expect(scoped.recurrence).toEqual([]);
    expect(scoped.recurrenceWithheld).toBe(true);
    expect(JSON.stringify(scoped)).not.toContain(JD_SHOP);
    expect(scoped.total).toBe(open.total); // 计数不含店铺标识，继续下发
    expect(scoped.byRule).toEqual(open.byRule);
  });
});

describe("S3 注册表与实现一致", () => {
  it("/alerts 与 /inventory/alerts 仍标 channel_scoped（登记与落地现在对得上了）", () => {
    expect(scopedModeForPath("/alerts")).toBe("channel_scoped");
    expect(scopedModeForPath("/inventory/alerts")).toBe("channel_scoped");
  });
});
