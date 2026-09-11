/**
 * 补货页「已开单/在途」列的数据源（`/api/outsource/duplicate-check` → `checkRecentOrders`）。
 *
 * 此前这份守卫只在**确认弹窗**里查一次：用户是在勾完 200 行之后才知道
 * 「这个 SKU 三天前已经开过单」——那时判断早就做完了。现在按当前页 SKU 预取、直接上列，
 * 勾之前就能看见。守卫只提示不阻断（追加/分批下单是正当业务）。
 *
 * 本文件钉住列真正依赖的三件事：按 skuId 分组、BH/WO 分类型、窗口与未结状态的边界。
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { checkRecentOrders } from "@/server/modules/outsource/duplicate-guard";
import { createTestDb, type TestDb } from "../helpers/db";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe("checkRecentOrders：补货页逐行「已开单/在途」的数据源", () => {
  let db: TestDb;
  let hot = 0; // 近 7 天有 BH + WO
  let old = 0; // 只有 8 天前的 BH（窗口外）
  let done = 0; // 有单但已完结（不算未结）
  let clean = 0; // 没开过单

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [u] = await db.insert(schema.users).values({ name: "运营", roles: ["ops"] }).returning();
    const [spu] = await db.insert(schema.spus).values({ code: "P30001", nameCn: "重复下单测试品" }).returning();
    const mk = async (code: string) => {
      const [s] = await db.insert(schema.skus).values({
        code, name: `品${code}`, spuId: spu.id, skuType: "finished", baseUom: "支", active: true,
      }).returning();
      return s.id;
    };
    hot = await mk("CP30001");
    old = await mk("CP30002");
    done = await mk("CP30003");
    clean = await mk("CP30004");

    const mkBh = async (docNo: string, skuId: number, status: "pending" | "completed", createdAt: Date) => {
      const [d] = await db.insert(schema.bhDocs).values({ docNo, status, createdBy: u.id, createdAt }).returning();
      await db.insert(schema.bhLines).values({ bhId: d.id, skuId, qty: "300.0000" });
    };
    await mkBh("BH-DUP-1", hot, "pending", daysAgo(3));
    await mkBh("BH-DUP-2", old, "pending", daysAgo(8));
    await mkBh("BH-DUP-3", done, "completed", daysAgo(1));

    const [sup] = await db.insert(schema.suppliers).values({
      code: "SUP-DUP", name: "加工厂", kinds: ["processor"], status: "qualified",
    }).returning();
    const [bom] = await db.insert(schema.boms).values({
      productSkuId: hot, versionNo: "V1", status: "active",
    }).returning();
    await db.insert(schema.woDocs).values({
      docNo: "WO-DUP-1", status: "approved", productSkuId: hot, qty: "500.0000",
      supplierId: sup.id, feeRatePlan: "2.00", bomId: bom.id, createdBy: u.id, createdAt: daysAgo(2),
    });
  });

  it("按 skuId 分组、按 BH/WO 分类型——正是列上 BH×n / WO×n 两个 Tag 的来源", async () => {
    const res = await checkRecentOrders([hot, old, done, clean], 7, db);
    expect(res.windowDays).toBe(7);
    expect(res.skuHitCount).toBe(1);
    const hits = res.hitsBySku[hot];
    expect(hits.map((h) => h.docType).sort()).toEqual(["BH", "WO"]);
    expect(hits.find((h) => h.docType === "BH")).toMatchObject({ docNo: "BH-DUP-1", status: "pending", qty: 300, daysAgo: 3 });
    expect(hits.find((h) => h.docType === "WO")).toMatchObject({ docNo: "WO-DUP-1", status: "approved", qty: 500, daysAgo: 2 });
  });

  it("窗口外与已完结的不算命中；没开过单的 SKU 列上就是「—」", async () => {
    const res = await checkRecentOrders([hot, old, done, clean], 7, db);
    expect(res.hitsBySku[old]).toBeUndefined();
    expect(res.hitsBySku[done]).toBeUndefined();
    expect(res.hitsBySku[clean]).toBeUndefined();
    // 放宽窗口到 14 天，8 天前那张就该出现——证明边界是窗口而不是漏查
    const wide = await checkRecentOrders([old], 14, db);
    expect(wide.hitsBySku[old]?.[0]).toMatchObject({ docNo: "BH-DUP-2", docType: "BH" });
  });

  it("空入参不查库、返回空结果（列在数据未到时不该报错）", async () => {
    expect(await checkRecentOrders([], 7, db)).toEqual({ windowDays: 7, hitsBySku: {}, skuHitCount: 0 });
  });
});
