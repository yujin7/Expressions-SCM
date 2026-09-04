/**
 * W2-#1 大促日历的写入界面。
 *
 * `planning/plan-events.ts` 早有完整 CRUD（GET/POST/PATCH/DELETE）与两个消费者
 * （补货建议行的事件标签、爆单预警的「预期内」降级），但**没有任何页面**——
 * 于是生产 `ops_plan_events` 是 0 行，整条大促感知路径结构性地死着：
 * 写得进（API 在）、没人写得了（界面不在）。
 *
 * 本文件钉住：页面存在并登记进注册表，写路径可从界面走通（新建 → 列表可见 → 补货行标签命中），
 * 以及界面搜索是**服务端分页前**过滤（页内二次筛会让翻页结果自相矛盾）。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { ROUTE_ENTRIES } from "@/lib/route-access";
import { createPlanEvent, listPlanEvents, loadOpenPlanEventsBySku, planEventTag } from "@/server/modules/planning/plan-events";
import { createTestDb } from "../helpers/db";

const root = path.resolve(__dirname, "../..");
const PAGE = "src/app/(app)/planning/events/page.tsx";

describe("运营计划事件：写入界面（W2-#1）", () => {
  it("页面存在、登记进路由注册表，且按列表页状态平台的约定包了 Suspense 与角色门", () => {
    const entry = ROUTE_ENTRIES.find((e) => e.path === "/planning/events");
    expect(entry, "ops_plan_events 的唯一人工入口必须登记进 ROUTE_REGISTRY，否则菜单与命令面板都到不了").toBeDefined();
    expect(entry!.group).toBe("planning");
    expect(entry!.scopedMode).toBe("channel_scoped"); // 事件带 channelId，受限用户按范围裁剪
    expect(entry!.keywords, "有 keywords 才进命令面板").toBeTruthy();

    expect(existsSync(path.join(root, PAGE)), `${PAGE} 不存在`).toBe(true);
    const src = readFileSync(path.join(root, PAGE), "utf8");
    expect(src).toMatch(/export\s+default\s+/);
    expect(src, "useSearchParams 缺 Suspense 边界会整页水合失败").toContain("<Suspense>");
    expect(src, "写权限门必须与服务端 requireAnyRole(ops,pmc) 同口径").toMatch(/canWrite=\{[^}]*ops[^}]*pmc/);

    const client = readFileSync(path.join(root, "src/app/(app)/planning/events/plan-events-client.tsx"), "utf8");
    expect(client, "客户端文件禁止值导入 @/server/*（kind 标签由接口下发）")
      .not.toMatch(/^import\s+(?!type)[^;]*from\s+"@\/server\//m);
    expect(client).toContain("useListState");
  });

  it("从界面新建的事件立刻成为补货行标签与列表可见项；搜索在服务端过滤", async () => {
    const { db, client } = await createTestDb();
    try {
      const [ops] = await db.insert(schema.users).values({ name: "运营小张", roles: ["ops"] }).returning();
      const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "测试" }).returning();
      const [sku] = await db.insert(schema.skus).values({ code: "CP00001", name: "面霜 50g", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
      const [other] = await db.insert(schema.skus).values({ code: "CP00002", name: "水乳 100ml", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
      const user = { id: ops.id, name: ops.name, roles: ["ops"] } as Parameters<typeof createPlanEvent>[0];

      const created = await createPlanEvent(user, {
        skuId: sku.id, kind: "promo", startDate: "2099-09-15", endDate: "2099-09-30", expectedUpliftPct: 120, note: "双11预售",
      }, db);
      await createPlanEvent(user, { skuId: other.id, kind: "launch", startDate: "2099-10-01", note: "新品上市" }, db);

      const all = await listPlanEvents({ roles: ["pmc"] }, {}, db);
      expect(all.total).toBe(2);

      // 搜索必须在库里过滤：total 与 rows 同源，否则翻页时「共 2 条」配「1 行」自相矛盾
      const searched = await listPlanEvents({ roles: ["pmc"] }, { q: "CP00001" }, db);
      expect(searched.total).toBe(1);
      expect(searched.rows.map((r) => r.id)).toEqual([created.id]);
      expect(await listPlanEvents({ roles: ["pmc"] }, { q: "双11" }, db).then((r) => r.total)).toBe(1);

      // 补货建议行的标签消费者立刻看得见
      const bySku = await loadOpenPlanEventsBySku(db, [sku.id, other.id]);
      expect(bySku.get(sku.id)!.map((e) => planEventTag(e))).toEqual(["大促 9/15–9/30"]);
      expect(bySku.get(other.id)!.map((e) => planEventTag(e))).toEqual(["上新 10/1起"]);
    } finally {
      await client.close();
    }
  });
});
