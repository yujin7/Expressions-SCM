/**
 * 主数据健康度：条码覆盖告警。
 *
 * 2026-08-04 实测背景：平台商品与系统主档之间**唯一通的桥是条码**——
 * 商家编码属另一套命名空间（拼多多 `SW1557` vs 系统 `N006-001`，5,376 个 SKU 里 0 命中），
 * 且归一化（前导零 / UPC-A↔EAN-13 / GTIN-14 / 去分隔符）额外命中为 **0**，
 * 说明对不上的条码是主档里根本没有，代码侧救不回来。
 *
 * 本告警要钉住的是「会错成什么样」：拿覆盖不全的平台销量算全局销速，
 * 没条码的 SKU 会显示为**零销量**并被判成滞销——零销量看起来像结论，其实是缺数据。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { channels, salesMonthly, skus, spus } from "@/db/schema";
import { getDataHealth } from "@/server/modules/report/data-health";
import { createTestDb, type TestDb } from "../helpers/db";

describe("主数据健康度：条码覆盖", () => {
  let db: TestDb;

  async function mkFinished(
    code: string,
    barcodeStatus: string | null,
    salesQty = 0,
  ): Promise<void> {
    const [spu] = await db.insert(spus).values({ code: `SPU-${code}`, nameCn: code }).returning();
    const [sku] = await db.insert(skus).values({
      spuId: spu.id,
      code,
      name: `成品 ${code}`,
      skuType: "finished",
      baseUom: "个",
      active: true,
      barcodeStatus,
    }).returning();
    if (salesQty > 0) {
      const [ch] = await db.insert(channels)
        .values({ code: `CH-${code}`, name: `渠道${code}`, kind: "platform" }).returning();
      await db.insert(salesMonthly).values({
        skuId: sku.id, channelId: ch.id, yearMonth: "2026-06", qty: String(salesQty),
      });
    }
  }

  beforeAll(async () => {
    ({ db } = await createTestDb());
    await mkFinished("FG-A", "valid");
    await mkFinished("FG-B", null, 10);   // 无条码，销量小
    await mkFinished("FG-C", null, 900);  // 无条码，销量大 —— 应排在样例最前
  });

  it("统计无条码的在售成品，并在标题里给出覆盖分母", async () => {
    const r = await getDataHealth({ page: 1, pageSize: 50 }, db);
    const w = r.structural.find((x) => x.key === "barcode_missing");
    expect(w, "有成品缺条码时必须报出").toBeTruthy();
    expect(w!.count).toBe(2);
    expect(w!.title).toContain("2 / 3");
    expect(w!.samples.join()).toContain("FG-B");
  });

  it("样例按销量倒序——补条码要从最值钱的补起，否则 20 条等于随机给", async () => {
    const r = await getDataHealth({ page: 1, pageSize: 50 }, db);
    const w = r.structural.find((x) => x.key === "barcode_missing")!;
    expect(w.samples[0], "销量 900 的 FG-C 应排最前").toContain("FG-C");
    expect(w.samples[0]).toContain("近期销量 900");
    expect(w.title, "标题要点明有销量者数量，指明优先级").toContain("2 个有历史销量");
  });

  it("影响说明写清「会错成什么样」，而不是「请检查」", async () => {
    const r = await getDataHealth({ page: 1, pageSize: 50 }, db);
    const w = r.structural.find((x) => x.key === "barcode_missing")!;
    // 必须点明零销量会被误判为滞销这一具体后果
    expect(w.impact).toContain("零销量");
    expect(w.impact).toContain("滞销");
    // 必须说明代码侧救不回来，避免有人再去写模糊匹配
    expect(w.impact).toContain("归一化");
    expect(w.impact, "要写明不是写法不同而是根本没有").toContain("根本没有");
    expect(w.impact).not.toContain("请检查");
  });

  it("全部成品都有条码时不报（不制造无意义告警）", async () => {
    const { db: clean } = await createTestDb();
    const [spu] = await clean.insert(spus).values({ code: "SPU-X", nameCn: "X" }).returning();
    await clean.insert(skus).values({
      spuId: spu.id, code: "FG-X", name: "成品 X", skuType: "finished",
      baseUom: "个", active: true, barcodeStatus: "valid",
    });
    const r = await getDataHealth({ page: 1, pageSize: 50 }, clean);
    expect(r.structural.find((x) => x.key === "barcode_missing")).toBeUndefined();
  });
});
