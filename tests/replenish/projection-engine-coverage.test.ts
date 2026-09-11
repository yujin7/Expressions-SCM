/**
 * W2 修复（T11）：补货曲线抽屉对**引擎未覆盖**的 SKU 必须说"没算过"，不得画一条 0 的平线。
 *
 * 事故形态：补货引擎只跑 active 成品。引擎没有该 SKU 的行时，
 * `startOnHand / daily / safetyQty` 一律落到 0，`projectInventory` 于是画出一条平直的 0 线，
 * `timePhasedNetReq` 在「0 ≥ 安全库存 0」下不报短缺，抽屉打上绿色的
 * 「视野内水位始终不低于安全库存」——对一个停用品/半成品/包材，这是**编出来的安心**。
 *
 * 现在返回显式的 `engineCovered: false` + 原因，所有引擎口径的数为 null（不是 0）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { channels, salesMonthly, skus, spus, stockBalances, users, warehouses } from "@/db/schema";
import { getSkuProjection } from "@/server/modules/replenish/projection";
import { createTestDb, type TestDb } from "../helpers/db";

describe("库存曲线：引擎覆盖范围必须显式", () => {
  let db: TestDb;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    await db.insert(users).values({ name: "计划员", roles: ["pmc"], isApprover: false });
    const [spu] = await db.insert(spus).values({ code: "PJ1", nameCn: "曲线测试" }).returning();
    const [wh] = await db.insert(warehouses).values({
      code: "PJW", name: "主仓", kind: "finished", accountingMode: "realtime", active: true,
    }).returning();
    const [ch] = await db.insert(channels).values({ code: "PJCH", name: "渠道", kind: "platform" }).returning();

    const mk = async (code: string, opts: { active: boolean; skuType: "finished" | "semi" | "packaging" }) => {
      const [sku] = await db.insert(skus).values({
        code, name: code, spuId: spu.id, baseUom: "支", ...opts,
      }).returning();
      await db.insert(stockBalances).values({ skuId: sku.id, warehouseId: wh.id, batchId: null, qty: "500.0000" });
      await db.insert(salesMonthly).values({ skuId: sku.id, channelId: ch.id, yearMonth: "2026-08", qty: "300" });
      return sku;
    };
    await mk("PJ-LIVE", { active: true, skuType: "finished" });
    await mk("PJ-DEAD", { active: false, skuType: "finished" });
    await mk("PJ-SEMI", { active: true, skuType: "semi" });
  });

  it("引擎覆盖的成品：engineCovered=true，数值照常给", async () => {
    const p = await getSkuProjection("PJ-LIVE", 120, db);
    expect(p.engineCovered).toBe(true);
    expect(p.engineCoverageReason).toBeNull();
    expect(p.engineCoverageNote).toBeNull();
    expect(p.points.length, "覆盖的 SKU 才画曲线").toBeGreaterThan(0);
    expect(typeof p.startOnHand).toBe("number");
    expect(typeof p.daily).toBe("number");
  });

  it("已停用的 SKU：显式「未覆盖」，且**不给** 0 —— 0 会被读成「算过，结果是 0」", async () => {
    const p = await getSkuProjection("PJ-DEAD", 120, db);
    expect(p.engineCovered).toBe(false);
    expect(p.engineCoverageReason).toBe("inactive");
    expect(p.engineCoverageNote).toContain("停用");

    expect(p.startOnHand, "在库不是 0，是「没算过」").toBeNull();
    expect(p.bookOnHand).toBeNull();
    expect(p.daily).toBeNull();
    expect(p.safetyQty).toBeNull();
    expect(p.leadDays).toBeNull();
  });

  it("未覆盖时不得给出任何「安全」结论：无曲线、无短缺日、无下单日", async () => {
    const p = await getSkuProjection("PJ-SEMI", 120, db);
    expect(p.engineCovered).toBe(false);
    expect(p.engineCoverageReason).toBe("not_finished");

    expect(p.points, "不画曲线——一条 0 的平线加一句「不会跌破安全库存」是假结论").toEqual([]);
    expect(p.shortageDate).toBeNull();
    expect(p.daysToShortage).toBeNull();
    expect(p.orderByDate).toBeNull();
    expect(p.orderWindowMissed).toBe(false);
    expect(p.stockoutDate).toBeNull();
  });

  it("抽屉组件按 engineCovered 分支渲染，绿色「不低于安全库存」不得出现在未覆盖分支", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(process.cwd(), "src/components/ProjectionDrawer.tsx"),
      "utf8",
    );
    expect(src).toContain("engineCovered === false");
    expect(src).toContain("不在补货引擎覆盖范围内");
    // 未覆盖分支必须出现在"视野内水位始终不低于安全库存"之前（它是一条 early return 分支）
    expect(src.indexOf("engineCovered === false")).toBeLessThan(src.indexOf("视野内水位始终不低于安全库存"));
  });
});
