import { describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { emptyExternalVelocity, loadExternalVelocity, loadExternalVelocitySafe, type ExternalVelocityBySku } from "@/server/modules/report/external-velocity";
import { computeExternalSkuRanking, filterExternalSkuRanking } from "@/server/modules/report/external-sku-ranking";
import { computeInventoryAlerts } from "@/server/modules/report/inventory-alerts";
import { externalWindowFixture } from "../helpers/external-window";

// Mock only the upstream DTO. Consumer queries, sorting, fallback and masking inputs remain real.
vi.mock("@/server/modules/report/external-velocity", async (original) => {
  const actual = await original<typeof import("@/server/modules/report/external-velocity")>();
  return { ...actual, loadExternalVelocity: vi.fn(), loadExternalVelocitySafe: vi.fn() };
});

function quantity(net30: string | null): ExternalVelocityBySku {
  return {
    paid30: "0.0000", refund30: "0.0000", paid90: "0.0000", refund90: "0.0000",
    net30, net90: net30, tmallNet30: net30 ?? "1.0000", tmallNet90: net30 ?? "1.0000",
    pddNet30: "0.0000", pddNet90: "0.0000", pddIdentityCovered: net30 == null,
    lastSoldDate: null, activeDays90: 0, platformSkus: 1,
    windows: externalWindowFixture(net30),
  };
}

describe("external decimal and coverage consumer contract", () => {
  it("ranking preserves precision and leaves incomplete identity coverage unranked, even when observed PDD quantity is zero", async () => {
    const { db, client } = await createTestDb();
    try {
      const [spu] = await db.insert(schema.spus).values({ code: "DEC", nameCn: "精度" }).returning();
      const skus = await db.insert(schema.skus).values(["UNKNOWN", "ZERO", "NEGATIVE", "LARGE-A", "LARGE-B"].map((code) => ({ code, name: code, spuId: spu.id, skuType: "finished" as const, baseUom: "支" }))).returning();
      const model = emptyExternalVelocity("合成观察契约");
      model.state = "ready";
      model.bySku = Object.fromEntries(skus.map((sku, i) => [String(sku.id), quantity([null, "0.0000", "-2.0000", "9007199254740992.0001", "9007199254740992.0002"][i])]));
      vi.mocked(loadExternalVelocity).mockResolvedValue(model);
      const ranked = await computeExternalSkuRanking(db);
      expect(ranked.rows.map((row) => [row.code, row.rank, row.net30])).toEqual([
        ["LARGE-B", 1, "9007199254740992.0002"], ["LARGE-A", 2, "9007199254740992.0001"],
        ["ZERO", 3, "0.0000"], ["NEGATIVE", 4, "-2.0000"], ["UNKNOWN", null, null],
      ]);
      expect(filterExternalSkuRanking(ranked, { platform: "pdd" }).rows).toEqual([]);
      expect(filterExternalSkuRanking(ranked, { platform: "tmall" }).rows.map((row) => row.code)).not.toContain("ZERO");
    } finally { await client.close(); }
  });

  it("inventory alerts distinguish unknown external quantity from genuine zero and retain the internal fallback", async () => {
    const { db, client } = await createTestDb();
    try {
      const [spu] = await db.insert(schema.spus).values({ code: "COV", nameCn: "覆盖" }).returning();
      const [unknown, zero] = await db.insert(schema.skus).values(["COV-UNKNOWN", "COV-ZERO"].map((code) => ({ code, name: code, spuId: spu.id, skuType: "finished" as const, baseUom: "支" }))).returning();
      const [channel] = await db.insert(schema.channels).values({ code: "COV-C", name: "内部", kind: "platform" }).returning();
      await db.insert(schema.salesMonthly).values({ skuId: unknown.id, channelId: channel.id, yearMonth: "2026-08", qty: "183.0000" });
      const model = emptyExternalVelocity("窗口不足");
      model.state = "ready";
      model.bySku = { [unknown.id]: quantity(null), [zero.id]: quantity("0.0000") };
      vi.mocked(loadExternalVelocitySafe).mockResolvedValue(model);
      const result = await computeInventoryAlerts(db);
      expect(result.rows.find((row) => row.skuId === unknown.id)).toMatchObject({ net30External: null, daily: { external: null }, primaryDailySource: "internal" });
      expect(result.rows.find((row) => row.skuId === zero.id)).toMatchObject({ net30External: "0.0000", daily: { external: 0 }, primaryDailySource: null });
    } finally { await client.close(); }
  });
});
