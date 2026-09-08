import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { getCapacityCheck } from "@/server/modules/outsource/capacity-check";
import { createTestDb } from "../helpers/db";

describe("预警到加工产能：人工只读情景", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let buyer: SessionUser;
  let skuId: number, rawId: number, factoryId: number, otherId: number, rawSupplierId: number;
  beforeAll(async () => {
    fixture = await createTestDb();
    const db = fixture.db;
    const [u] = await db.insert(schema.users).values({ name: "产能核对采购", roles: ["purchasing"] }).returning();
    buyer = { id: u.id, name: u.name, roles: ["purchasing"], isApprover: false };
    const [spu] = await db.insert(schema.spus).values({ code: "CAP-CHECK", nameCn: "合成精华" }).returning();
    const [sku, raw] = await db.insert(schema.skus).values([
      { code: "CAP-FG", name: "合成精华", skuType: "finished", baseUom: "支", spuId: spu.id },
      { code: "CAP-RAW", name: "合成原料", skuType: "raw", baseUom: "kg", spuId: spu.id },
    ]).returning();
    skuId = sku.id; rawId = raw.id;
    const [factory, other, rawSupplier] = await db.insert(schema.suppliers).values([
      { code: "CAP-F", name: "合成加工厂", kinds: ["processor"], status: "qualified",
        declaredMonthlyCapacity: "1000", capacityUom: "支", surgeCapacityPct: 20,
        capacityValidFrom: "2020-01-01", capacityValidUntil: "2099-12-31", capacityEvidence: "合成签认" },
      { code: "CAP-O", name: "暂停的首次加工厂", kinds: ["processor"], status: "paused" },
      { code: "CAP-R", name: "原料供应商", kinds: ["raw"], status: "qualified" },
    ]).returning();
    factoryId = factory.id; otherId = other.id; rawSupplierId = rawSupplier.id;
    const [bom] = await db.insert(schema.boms).values({ productSkuId: sku.id, versionNo: "1" }).returning();
    const [wo] = await db.insert(schema.woDocs).values({ docNo: "WO-CAP-CHECK", status: "approved", productSkuId: sku.id,
      qty: "900", supplierId: factory.id, feeRatePlan: "1", bomId: bom.id, createdBy: u.id }).returning();
    const [otherWo] = await db.insert(schema.woDocs).values({ docNo: "WO-CAP-CHECK-OTHER", status: "draft", productSkuId: sku.id,
      qty: "50", supplierId: other.id, feeRatePlan: "1", bomId: bom.id, createdBy: u.id }).returning();
    await db.insert(schema.jgDocs).values([
      { docNo: "JG-CAP-CHECK-A", status: "approved", woId: wo.id, supplierId: factory.id, productSkuId: sku.id,
        qty: "900", dueDate: "2090-09-20", feeRateCurrent: "1", createdBy: u.id },
      { docNo: "JG-CAP-CHECK-D", status: "draft", woId: otherWo.id, supplierId: other.id, productSkuId: sku.id,
        qty: "50", dueDate: "2090-09-20", feeRateCurrent: "1", createdBy: u.id },
    ]);
  });
  afterAll(async () => fixture.client.close());
  const scenario = () => ({ skuId, supplierId: factoryId, dueDate: "2090-09-20", candidateQty: "200.0001" });

  it("只列加工厂，不暗选供应商或从预警推算数量；草稿不算已批往来", async () => {
    const result = await getCapacityCheck(buyer, { skuId }, fixture.db);
    expect(result.scenario).toBeNull();
    expect(result.factories).toEqual([
      expect.objectContaining({ id: factoryId, hasApprovedHistory: true }),
      expect.objectContaining({ id: otherId, status: "paused", hasApprovedHistory: false }),
    ]);
    expect(JSON.stringify(result)).not.toContain("bankAccount");
  });
  it("复用JG口径：人工新增量与未结量相加，申报与未知历史分开", async () => {
    const result = await getCapacityCheck(buyer, scenario(), fixture.db);
    expect(result.scenario?.signal).toMatchObject({ candidateQty: "200.0001", scheduledQty: "900.0000", projectedQty: "1100.0001",
      advisoryOnly: true, declared: { state: "comparable", overNormal: true, overSurge: false, normalHeadroomQty: "-100.0001" } });
    expect(result.scenario?.signal.stats.reliable).toBe(false);
  });
  it("暂停且缺申报仍可核对，但不伪造可用产能", async () => {
    const result = await getCapacityCheck(buyer, { ...scenario(), supplierId: otherId }, fixture.db);
    expect(result.factories.find(r => r.id === otherId)?.status).toBe("paused");
    expect(result.scenario?.signal.declared).toMatchObject({ state: "missing", normalHeadroomQty: null });
  });
  it.each(["warehouse", "finance", "quality"])("%s不能用辅助接口越权读取", async role => {
    await expect(getCapacityCheck({ ...buyer, roles: [role] } as SessionUser, scenario(), fixture.db)).rejects.toMatchObject({ status: 403 });
  });
  it.each(["pmc", "ops", "admin"])("%s可核对但仍不自动选择加工厂或数量", async role => {
    const result = await getCapacityCheck({ ...buyer, roles: [role] } as SessionUser, { skuId }, fixture.db);
    expect(result.scenario).toBeNull(); expect(result.factories).toHaveLength(2);
  });
  it("非成品、非加工厂和不存在的SKU明确拒绝", async () => {
    await expect(getCapacityCheck(buyer, { skuId: rawId }, fixture.db)).rejects.toMatchObject({ status: 400 });
    await expect(getCapacityCheck(buyer, { ...scenario(), supplierId: rawSupplierId }, fixture.db)).rejects.toMatchObject({ status: 400 });
    await expect(getCapacityCheck(buyer, { skuId: 2147483647 }, fixture.db)).rejects.toMatchObject({ status: 404 });
  });
  it("日期、精度、范围及半填情景在查询前拒绝", async () => {
    for (const invalid of [
      { ...scenario(), dueDate: "2026-02-30" }, { ...scenario(), candidateQty: "-1" },
      { ...scenario(), candidateQty: "0.0000" }, { ...scenario(), candidateQty: "1.00001" },
      { ...scenario(), candidateQty: "10000000000" }, { ...scenario(), supplierId: "" },
      { skuId, dueDate: "2090-09-20" }, { skuId: "2147483648" },
    ]) await expect(getCapacityCheck(buyer, invalid, fixture.db)).rejects.toBeInstanceOf(ZodError);
  });
  it("重复读取不创建单据、工作项、审计或库存，不改申报", async () => {
    const db = fixture.db;
    const before = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, factoryId));
    await getCapacityCheck(buyer, scenario(), db);
    await getCapacityCheck(buyer, scenario(), db);
    expect(await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, factoryId))).toEqual(before);
    expect(await db.select().from(schema.auditLogs)).toEqual([]);
    expect(await db.select().from(schema.stockLedger)).toEqual([]);
    expect(await db.select().from(schema.workItems)).toEqual([]);
    expect(await db.select().from(schema.jgDocs)).toHaveLength(2);
  });
});
