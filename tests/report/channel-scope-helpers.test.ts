/**
 * D62 渠道范围落地的两个 helper：
 * - report/channel-scope.ts：渠道 code → id → core/data-scope.resolveChannelScope，回给报表可下推 SQL 的形状；
 * - report/channel-observation.ts：店铺 → 渠道映射（aliases(channel, JIANDAOYUN) 精确匹配）、未映射进 alias_exceptions、按范围裁剪店铺行。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { ApiError } from "@/server/modules/master/common";
import {
  channelScopeCondition, isChannelRestricted, resolveChannelScopeByCode, UNRESTRICTED_SCOPE,
} from "@/server/modules/report/channel-scope";
import {
  filterShopRowsByChannelScope, loadShopChannelMap, queueUnmappedShops, SHOP_CHANNEL_ALIAS_SCOPE,
} from "@/server/modules/report/channel-observation";

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
  const [tmall] = await db.insert(schema.channels).values({ code: "TMALL", name: "天猫", kind: "platform" }).returning();
  const [jd] = await db.insert(schema.channels).values({ code: "JD", name: "京东", kind: "platform" }).returning();
  const [pdd] = await db.insert(schema.channels).values({ code: "PDD", name: "拼多多", kind: "platform" }).returning();
  return { db, tmall, jd, pdd };
}

describe("resolveChannelScopeByCode", () => {
  it("不限用户：无 code → UNRESTRICTED；有 code → [id] 且 forced=false；不存在的 code 保持 EXISTS(code) 行为（channelIds=null）", async () => {
    const { db, tmall } = await seed();
    const pmc = { roles: ["pmc"] };
    expect(await resolveChannelScopeByCode(db, pmc)).toBe(UNRESTRICTED_SCOPE);
    expect(await resolveChannelScopeByCode(db, undefined)).toBe(UNRESTRICTED_SCOPE);
    expect(await resolveChannelScopeByCode(db, pmc, "TMALL")).toEqual({ channelIds: [tmall.id], forced: false, scopeLabel: null, channelCode: "TMALL" });
    expect(await resolveChannelScopeByCode(db, pmc, "  NOPE ")).toEqual({ channelIds: null, forced: false, scopeLabel: null, channelCode: "NOPE" });
    expect(isChannelRestricted(pmc)).toBe(false);
    expect(isChannelRestricted({ roles: ["admin"], channelScope: [tmall.id] })).toBe(false);
    expect(isChannelRestricted({ roles: ["ops"], channelScope: [tmall.id] })).toBe(true);
  });

  it("受限用户：未指定 → 全部范围（排序、标签按 id 序顿号连接）；范围内 → 单渠道；范围外/不存在 → 403；admin 恒不限", async () => {
    const { db, tmall, jd, pdd } = await seed();
    const ops = { roles: ["ops"], channelScope: [jd.id, tmall.id] };
    expect(await resolveChannelScopeByCode(db, ops)).toEqual({
      channelIds: [tmall.id, jd.id].sort((a, b) => a - b),
      forced: true,
      scopeLabel: tmall.id < jd.id ? "天猫、京东" : "京东、天猫",
      channelCode: null,
    });
    expect(await resolveChannelScopeByCode(db, ops, "JD")).toEqual({ channelIds: [jd.id], forced: true, scopeLabel: "京东", channelCode: "JD" });
    expect(await statusOf(resolveChannelScopeByCode(db, ops, "PDD"))).toBe(403);
    expect(await statusOf(resolveChannelScopeByCode(db, ops, "NOPE"))).toBe(403);
    expect(pdd.id).toBeGreaterThan(0);
    const admin = { roles: ["admin"], channelScope: [jd.id] };
    expect(await resolveChannelScopeByCode(db, admin)).toBe(UNRESTRICTED_SCOPE);
    expect((await resolveChannelScopeByCode(db, admin, "PDD")).forced).toBe(false);
  });

  it("channelScopeCondition 只在 forced 时下推；空集合 fail closed（drizzle inArray([]) = false）", async () => {
    const { db, tmall } = await seed();
    const col = schema.salesMonthly.channelId;
    expect(channelScopeCondition(col, UNRESTRICTED_SCOPE)).toBeUndefined();
    expect(channelScopeCondition(col, { channelIds: [tmall.id], forced: false, scopeLabel: null, channelCode: "TMALL" })).toBeUndefined();
    expect(channelScopeCondition(col, { channelIds: [tmall.id], forced: true, scopeLabel: "天猫", channelCode: null })).toBeDefined();
    const cond = channelScopeCondition(col, { channelIds: [], forced: true, scopeLabel: null, channelCode: null });
    expect(cond).toBeDefined();
    const rows = await db.select({ id: schema.salesMonthly.id }).from(schema.salesMonthly).where(cond);
    expect(rows).toEqual([]);
  });
});

describe("店铺 → 渠道映射（channel-observation helper）", () => {
  it("只按 aliases(channel, JIANDAOYUN) 精确匹配；GLOBAL scope 的同名别名不算；未映射保留键为 null", async () => {
    const { db, tmall, jd } = await seed();
    await db.insert(schema.aliases).values([
      { aliasType: "channel", scope: SHOP_CHANNEL_ALIAS_SCOPE, rawValue: "NING天猫旗舰店", targetId: tmall.id },
      { aliasType: "channel", scope: SHOP_CHANNEL_ALIAS_SCOPE, rawValue: "NING京东自营", targetId: jd.id },
      { aliasType: "channel", scope: "GLOBAL", rawValue: "只在GLOBAL的店", targetId: jd.id },
      { aliasType: "warehouse", scope: SHOP_CHANNEL_ALIAS_SCOPE, rawValue: "同名但是仓库别名", targetId: jd.id },
    ]);
    const map = await loadShopChannelMap(db, ["NING天猫旗舰店", " NING京东自营 ", "只在GLOBAL的店", "同名但是仓库别名", "野店", "野店", ""]);
    expect(map.byShop).toEqual({
      NING天猫旗舰店: tmall.id,
      NING京东自营: jd.id,
      只在GLOBAL的店: null,
      同名但是仓库别名: null,
      野店: null,
    });
    expect(map.unmapped).toEqual(["只在GLOBAL的店", "同名但是仓库别名", "野店"]);
    expect(map.mappedCount).toBe(2);
    expect(await loadShopChannelMap(db, [])).toEqual({ byShop: {}, unmapped: [], mappedCount: 0 });
  });

  it("未映射店铺进 alias_exceptions（open、scope=JIANDAOYUN），幂等：第二次入队 0 条", async () => {
    const { db } = await seed();
    expect(await queueUnmappedShops(db, ["野店A", "野店B", "野店A", " "])).toBe(2);
    expect(await queueUnmappedShops(db, ["野店A", "野店C"])).toBe(1);
    const rows = await db.select().from(schema.aliasExceptions).where(eq(schema.aliasExceptions.aliasType, "channel"));
    expect(rows.map((r) => r.rawValue).sort()).toEqual(["野店A", "野店B", "野店C"]);
    expect(rows.every((r) => r.status === "open" && r.scope === SHOP_CHANNEL_ALIAS_SCOPE)).toBe(true);
    expect(rows[0].context).toEqual({ source: "channel-observation" });
  });

  it("按范围裁剪店铺行：不限原样拷贝；受限只留映射到范围内渠道的店铺，未映射剔除", () => {
    const map = { byShop: { 天猫店: 1, 京东店: 2, 野店: null }, unmapped: ["野店"], mappedCount: 2 };
    const rows = [{ shop: "天猫店", units: 1 }, { shop: "京东店", units: 2 }, { shop: "野店", units: 3 }, { shop: "没见过的店", units: 4 }];
    const all = filterShopRowsByChannelScope(rows, (r) => r.shop, map, { channelIds: null });
    expect(all).toEqual(rows);
    expect(all).not.toBe(rows);
    expect(filterShopRowsByChannelScope(rows, (r) => r.shop, map, { channelIds: [1] }).map((r) => r.shop)).toEqual(["天猫店"]);
    expect(filterShopRowsByChannelScope(rows, (r) => r.shop, map, { channelIds: [1, 2] }).map((r) => r.shop)).toEqual(["天猫店", "京东店"]);
    expect(filterShopRowsByChannelScope(rows, (r) => r.shop, map, { channelIds: [9] })).toEqual([]);
  });
});
