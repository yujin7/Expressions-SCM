/**
 * 架构护栏（D62 渠道范围落地，W2-E）：受限账号不得越过自己的渠道范围。
 *
 * 钉住三件事：
 * 1. 越权：受限账号请求他人渠道（或不存在的渠道 code）→ ApiError 403；
 * 2. 响应不含他人渠道行：驾驶舱 / 决策工作室 / 销量归因 / 备货申请列表只含本渠道数据，admin 与未登记范围的用户不裁剪；
 * 3. 销售金额对 ops 被剥离：salesAmount ∈ SENSITIVE_FIELDS，maskSensitive 对 ops 深剥，驾驶舱结算金额块对 ops 为 null。
 * 另有静态护栏：渠道维路由必须把身份传进 service（否则裁剪永远不生效）、注册表口径与页面实现一致。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { SENSITIVE_FIELDS } from "@/server/core/constants";
import { loadUserScopes } from "@/server/core/data-scope";
import { maskSensitive, type SessionUser } from "@/server/core/dto";
import { scopedModeForPath } from "@/lib/route-access";
import { ApiError } from "@/server/modules/master/common";
import { listBhs } from "@/server/modules/outsource/bh";
import { getDashboard } from "@/server/modules/report/dashboard";
import { getDecisionStudio } from "@/server/modules/report/decision-studio";
import { getSalesBridge } from "@/server/modules/report/sales-bridge";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const statusOf = async (p: Promise<unknown>): Promise<number | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.status : -1;
  }
};

async function seed() {
  const { db } = await createTestDb();
  const mkUser = async (username: string, name: string, roles: string[]) => {
    const [u] = await db.insert(schema.users).values({ username, name, roles }).returning();
    return u;
  };
  const admin = await mkUser("adm", "管理员", ["admin"]);
  const opsTmall = await mkUser("ops_tm", "天猫运营", ["ops"]);
  const opsTmall2 = await mkUser("ops_tm2", "天猫运营二", ["ops"]);
  const opsJd = await mkUser("ops_jd", "京东运营", ["ops"]);
  const opsFree = await mkUser("ops_free", "未限运营", ["ops"]);
  const [tmall] = await db.insert(schema.channels).values({ code: "TMALL", name: "天猫", kind: "platform" }).returning();
  const [jd] = await db.insert(schema.channels).values({ code: "JD", name: "京东", kind: "platform" }).returning();
  await db.insert(schema.userDataScopes).values([
    { userId: opsTmall.id, scopeKind: "channel", targetId: tmall.id, createdBy: admin.id },
    { userId: opsTmall2.id, scopeKind: "channel", targetId: tmall.id, createdBy: admin.id },
    { userId: opsJd.id, scopeKind: "channel", targetId: jd.id, createdBy: admin.id },
  ]);
  const [spu] = await db.insert(schema.spus).values({ code: "P31001", nameCn: "范围测试品" }).returning();
  const [ning] = await db.insert(schema.brands).values({ code: "NING", nameCn: "NING" }).returning();
  const mkSku = async (code: string) => {
    const [s] = await db.insert(schema.skus).values({
      code, name: `货品${code}`, spuId: spu.id, skuType: "finished", baseUom: "支", brandId: ning.id,
    }).returning();
    return s;
  };
  const a = await mkSku("CS-A");
  const b = await mkSku("CS-B");
  await db.insert(schema.salesMonthly).values([
    { skuId: a.id, channelId: tmall.id, yearMonth: "2026-05", qty: "80" },
    { skuId: a.id, channelId: tmall.id, yearMonth: "2026-06", qty: "100" },
    { skuId: b.id, channelId: jd.id, yearMonth: "2026-05", qty: "30" },
    { skuId: b.id, channelId: jd.id, yearMonth: "2026-06", qty: "40" },
  ]);
  await db.insert(schema.bhDocs).values([
    { docNo: "BH-T1", createdBy: opsTmall.id },
    { docNo: "BH-T2", createdBy: opsTmall2.id },
    { docNo: "BH-J1", createdBy: opsJd.id },
    { docNo: "BH-F1", createdBy: opsFree.id },
  ]);
  const session = async (u: typeof admin): Promise<SessionUser> => ({
    id: u.id, name: u.name, roles: u.roles as string[], isApprover: u.isApprover, ...(await loadUserScopes(db, u.id)),
  });
  return {
    db, tmall, jd,
    admin: await session(admin),
    opsTmall: await session(opsTmall),
    opsJd: await session(opsJd),
    opsFree: await session(opsFree),
  };
}

describe("D62 越权：受限账号请求他人渠道 → 403", () => {
  it("驾驶舱 / 决策工作室：范围外渠道与不存在的渠道 code 一律 403", async () => {
    const { db, opsTmall } = await seed();
    expect(opsTmall.channelScope).toHaveLength(1);
    expect(await statusOf(getDashboard(opsTmall, { channel: "JD" }, db))).toBe(403);
    expect(await statusOf(getDashboard(opsTmall, { channel: "NOPE" }, db))).toBe(403);
    expect(await statusOf(getDecisionStudio({ dimension: "channel", scope: { channel: "JD" } }, db, opsTmall))).toBe(403);
    expect(await statusOf(getDecisionStudio({ dimension: "channel", scope: { channel: "NOPE" } }, db, opsTmall))).toBe(403);
    // 本渠道可以点名请求（forced 仍为 true）
    const own = await getDashboard(opsTmall, { channel: "TMALL" }, db);
    expect(own.scope).toMatchObject({ channel: "TMALL", forced: true, scopeLabel: "天猫" });
  });
});

describe("D62 响应不含他人渠道行", () => {
  it("驾驶舱：受限 ops 只见本渠道销售聚合，库存等公开内容仍在 notAppliedTo；admin / 未登记范围的用户不裁剪", async () => {
    const { db, opsTmall, opsJd, admin, opsFree } = await seed();
    const t = await getDashboard(opsTmall, {}, db);
    expect(t.scope).toMatchObject({ channel: null, forced: true, scopeLabel: "天猫" });
    expect(t.channelMix.map((c) => c.name)).toEqual(["天猫"]);
    expect(t.kpi.salesLastMonth).toBe(100);
    expect(t.topSkus.map((s) => s.code)).toEqual(["CS-A"]);
    expect(t.scope.notAppliedTo).toContain("库存总量");
    expect(t.scope.notAppliedTo).toContain("临期风险");
    expect(t.insights.join("\n")).not.toContain("渠道集中度");

    const j = await getDashboard(opsJd, {}, db);
    expect(j.channelMix.map((c) => c.name)).toEqual(["京东"]);
    expect(j.kpi.salesLastMonth).toBe(40);

    for (const u of [admin, opsFree]) {
      const d = await getDashboard(u, {}, db);
      expect(d.scope.forced).toBe(false);
      expect(d.scope.scopeLabel).toBeNull();
      expect(d.channelMix.map((c) => c.name).sort()).toEqual(["京东", "天猫"]);
      expect(d.kpi.salesLastMonth).toBe(140);
    }
    // 旧调用形状（仅角色）仍等价于不限
    expect((await getDashboard(["ops"], {}, db)).kpi.salesLastMonth).toBe(140);
  });

  it("决策工作室：渠道维只剩本渠道；JST 日事实没有渠道维度 → 受限用户 gate 不呈现", async () => {
    const { db, opsTmall, admin } = await seed();
    const r = await getDecisionStudio({ dimension: "channel" }, db, opsTmall);
    expect(r.channelScope).toMatchObject({ forced: true, label: "天猫" });
    expect(r.groups.map((g) => g.key)).toEqual(["TMALL"]);
    expect(r.pivot.map((p) => p.key)).toEqual(["TMALL"]);
    expect(r.comparison.current).toBe(100);
    expect(r.daily.state).toBe("insufficient");
    expect(r.daily.gate).toContain("渠道范围");
    const bySku = await getDecisionStudio({ dimension: "sku" }, db, opsTmall);
    expect(bySku.groups.map((g) => g.key)).toEqual(["CS-A"]);

    const all = await getDecisionStudio({ dimension: "channel" }, db, admin);
    expect(all.channelScope.forced).toBe(false);
    expect(all.groups.map((g) => g.key).sort()).toEqual(["JD", "TMALL"]);
    expect((await getDecisionStudio({ dimension: "channel" }, db)).groups).toHaveLength(2); // 无身份（后台任务）= 不限
  });

  it("销量归因：受限 ops 的两期与三维归因都只在本渠道盘子里", async () => {
    const { db, opsTmall, admin } = await seed();
    const r = await getSalesBridge({ dim: "channel", fromYm: "2026-05", toYm: "2026-06" }, db, opsTmall);
    expect(r.channelScope).toEqual({ forced: true, label: "天猫" });
    expect(r.from).toBe(80);
    expect(r.to).toBe(100);
    expect(r.items.map((i) => i.label)).toEqual(["天猫"]);
    expect(r.attribution.channel.ups.map((i) => i.label)).toEqual(["天猫"]);
    expect(r.attribution.channel.downs).toEqual([]);
    const bySku = await getSalesBridge({ dim: "sku", fromYm: "2026-05", toYm: "2026-06" }, db, opsTmall);
    expect(bySku.items.map((i) => i.key)).toEqual(["CS-A"]);

    const all = await getSalesBridge({ dim: "channel", fromYm: "2026-05", toYm: "2026-06" }, db, admin);
    expect(all.channelScope.forced).toBe(false);
    expect(all.from).toBe(110);
    expect(all.to).toBe(140);
    expect(all.items.map((i) => i.label).sort()).toEqual(["京东", "天猫"]);
  });

  it("备货申请列表：受限 ops 只见本人制单 + 同渠道制单人的单据；admin / 未登记范围者见全部", async () => {
    const { db, opsTmall, opsJd, admin, opsFree } = await seed();
    const page = { page: 1, pageSize: 20 };
    const docNos = (r: { rows: unknown[] }) => (r.rows as { docNo: string }[]).map((x) => x.docNo).sort();
    const t = await listBhs("", page, db, opsTmall);
    expect(t.total).toBe(2);
    expect(docNos(t)).toEqual(["BH-T1", "BH-T2"]);
    const j = await listBhs("", page, db, opsJd);
    expect(docNos(j)).toEqual(["BH-J1"]);
    expect((await listBhs("", page, db, admin)).total).toBe(4);
    expect((await listBhs("", page, db, opsFree)).total).toBe(4);
    expect((await listBhs("", page, db)).total).toBe(4);
    // 搜索条件与范围条件是 AND：受限 ops 搜到他人渠道的单号也拿不到
    expect((await listBhs("BH-J1", page, db, opsTmall)).total).toBe(0);
  });
});

describe("D62 销售金额对 ops 被剥离", () => {
  it("salesAmount 在 SENSITIVE_FIELDS 中；maskSensitive 对 ops 深剥、对 finance 保留；驾驶舱结算块对 ops 为 null", async () => {
    expect(SENSITIVE_FIELDS).toContain("salesAmount");
    const payload = { month: "2026-06", salesAmount: "1234.50", rows: [{ channel: "天猫", salesAmount: "1000.00", qty: 3 }] };
    const ops = maskSensitive(payload, ["ops"]);
    expect(JSON.stringify(ops)).not.toContain("salesAmount");
    expect(ops.rows[0]).toEqual({ channel: "天猫", qty: 3 });
    expect(maskSensitive(payload, ["finance"]).salesAmount).toBe("1234.50");
    expect(maskSensitive(payload, ["pmc"]).rows[0].salesAmount).toBe("1000.00");

    const { db, opsTmall, admin } = await seed();
    expect((await getDashboard(opsTmall, {}, db)).settlement).toBeNull();
    expect((await getDashboard(admin, {}, db)).settlement).not.toBeNull();
  });
});

describe("D62 静态护栏：渠道维路由必须把身份交给 service，注册表口径与实现一致", () => {
  it("dashboard / decision-studio / sales-bridge / bh 路由与驾驶舱页面都把 user 传进 service", () => {
    expect(read("src/app/api/report/dashboard/route.ts")).toMatch(/getDashboard\(\s*fresh\s*,/);
    expect(read("src/app/(app)/report/dashboard/page.tsx")).toMatch(/getDashboard\(\s*user\s*,/);
    expect(read("src/app/api/report/decision-studio/route.ts")).toMatch(/getDecisionStudio\([\s\S]*?\},\s*undefined,\s*user\)/);
    expect(read("src/app/api/report/sales-bridge/route.ts")).toMatch(/getSalesBridge\([\s\S]*?\},\s*undefined,\s*user\)/);
    expect(read("src/app/api/outsource/bh/route.ts")).toMatch(/listBhs\([\s\S]*?,\s*undefined,\s*user\)/);
  });

  it("service 层用唯一权威解析范围（core/data-scope 经 report/channel-scope），不自建本地判定", () => {
    const helper = read("src/server/modules/report/channel-scope.ts");
    expect(helper).toContain('from "@/server/core/data-scope"');
    expect(helper).toContain("resolveChannelScope(");
    for (const f of ["src/server/modules/report/dashboard.ts", "src/server/modules/report/decision-studio.ts", "src/server/modules/report/sales-bridge.ts"]) {
      expect(read(f), f).toContain("resolveChannelScopeByCode(");
      expect(read(f), f).toContain("channelScopeCondition(");
    }
    expect(read("src/server/modules/outsource/bh.ts")).toContain("bhReadScope(db, user)");
    expect(read("src/server/core/bh-read-scope.ts")).toContain("userDataScopes");
  });

  it("注册表：已落地裁剪的渠道维页面标 channel_scoped，公开内容（库存总量/临期/到货日历）标 public", () => {
    for (const p of ["/report/dashboard", "/report/decision-studio", "/report/sales-bridge", "/outsource/bh"]) {
      expect(scopedModeForPath(p), p).toBe("channel_scoped");
    }
    // 注：routeByPath 忽略 query，"/report/demand?tab=stock_summary" 会命中 planning 那条（channel_scoped），故不在此列
    for (const p of ["/inventory/balance", "/inventory/expiry", "/report/inbound-calendar", "/report/inventory-analytics"]) {
      expect(scopedModeForPath(p), p).toBe("public");
    }
  });
});
