/** E3-06 审批简报卡：审批那一刻的上下文 */
import { describe, it, expect, beforeAll } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { bhDocs, bhLines, channels, salesMonthly, skus, spus, stockBalances, users, warehouses } from "@/db/schema";
import { getApprovalBrief } from "@/server/modules/inbox/approval-brief";
import { ApiError } from "@/server/modules/master/common";

describe("审批简报卡", () => {
  let db: TestDb;
  let bhId = 0;
  let skuOver = 0; // 库存充裕
  let skuDead = 0; // 有库存无动销

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [u] = await db.insert(users).values({ name: "运营", roles: ["ops"], isApprover: false }).returning();
    const [spu] = await db.insert(spus).values({ code: "PA", nameCn: "简报测试" }).returning();
    const mk = async (code: string, name: string) => {
      const [s] = await db.insert(skus).values({ code, name, spuId: spu.id, skuType: "finished", baseUom: "件" }).returning();
      return s.id;
    };
    skuOver = await mk("BR-OVER", "库存充裕品");
    skuDead = await mk("BR-DEAD", "无动销品");
    const [wh] = await db.insert(warehouses).values({ code: "BR-W", name: "仓", kind: "finished", accountingMode: "realtime" }).returning();

    // 库存充裕：在库 10000，日均 ~10 → 可销 1000 天
    await db.insert(stockBalances).values([
      { skuId: skuOver, warehouseId: wh.id, qty: "10000" },
      { skuId: skuDead, warehouseId: wh.id, qty: "500" },
    ]);
    const [ch] = await db.insert(channels).values({ code: "C", name: "渠道", kind: "platform" }).returning();
    await db.insert(salesMonthly).values([
      { skuId: skuOver, channelId: ch.id, yearMonth: "2026-04", qty: "300" },
      { skuId: skuOver, channelId: ch.id, yearMonth: "2026-05", qty: "300" },
      { skuId: skuOver, channelId: ch.id, yearMonth: "2026-06", qty: "310" },
    ]);
    // skuDead 无销量记录 → 无动销

    const [doc] = await db.insert(bhDocs).values({ docNo: "BH-BRIEF-1", status: "pending", createdBy: u.id }).returning();
    bhId = doc.id;
    await db.insert(bhLines).values([
      { bhId, skuId: skuOver, qty: "100" },
      { bhId, skuId: skuDead, qty: "50" },
    ]);
  });

  it("返回逐行上下文：本单量/在库/可销/在途", async () => {
    const b = await getApprovalBrief("bh", bhId, db);
    expect(b.docNo).toBe("BH-BRIEF-1");
    expect(b.lines.length).toBe(2);
    const over = b.lines.find((l) => l.code === "BR-OVER")!;
    expect(over.docQty).toBe(100);
    expect(over.onHand).toBe(10000);
    expect(over.daysCover).not.toBeNull();
  });

  it("库存充裕的行被标记（可销>180 天）", async () => {
    const b = await getApprovalBrief("bh", bhId, db);
    const over = b.lines.find((l) => l.code === "BR-OVER")!;
    expect(over.flags.some((f) => f.includes("库存已充裕"))).toBe(true);
  });

  it("有库存但无动销的行被标记", async () => {
    const b = await getApprovalBrief("bh", bhId, db);
    const dead = b.lines.find((l) => l.code === "BR-DEAD")!;
    expect(dead.daysCover).toBeNull();
    expect(dead.flags.some((f) => f.includes("无动销"))).toBe(true);
  });

  it("汇总统计出有关注点的行数", async () => {
    const b = await getApprovalBrief("bh", bhId, db);
    expect(b.summary.lineCount).toBe(2);
    expect(b.summary.flaggedLines).toBeGreaterThan(0);
    expect(b.summary.totalQty).toBe(150);
  });

  it("人工直录单据标注为「系统未参与数量测算」", async () => {
    const b = await getApprovalBrief("bh", bhId, db);
    expect(b.origin.fromSuggestion).toBe(false);
    expect(b.origin.note).toContain("人工直录");
  });

  it("不支持的单据类型明确拒绝（不静默返回空）", async () => {
    await expect(getApprovalBrief("po", 1, db)).rejects.toThrow(ApiError);
  });

  it("单据不存在 → 404", async () => {
    await expect(getApprovalBrief("bh", 999999, db)).rejects.toThrow(/单据不存在/);
  });
});
