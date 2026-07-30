import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  approvalConfigs,
  approvals,
  bomLines,
  boms,
  poLines,
  skus,
  spus,
  suppliers,
  users,
  woDocs,
  woLines,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  approveWo,
  createWo,
  generateDocs,
  getWo,
  submitWo,
} from "@/server/modules/outsource/wo";
import { createTestDb, type TestDb } from "../helpers/db";

describe("委外工单：多层 BOM 冻结到末级采购物料", () => {
  let db: TestDb;
  let creator: SessionUser;
  let approver: SessionUser;
  let finished = 0;
  let semi = 0;
  let raw = 0;
  let factory = 0;
  let materialSupplier = 0;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [creatorRow, approverRow] = await db.insert(users).values([
      { name: "多层WO制单", roles: ["pmc"], isApprover: false },
      { name: "多层WO审批", roles: ["pmc"], isApprover: true },
    ]).returning();
    creator = {
      id: creatorRow.id,
      name: creatorRow.name,
      roles: ["pmc"],
      isApprover: false,
    };
    approver = {
      id: approverRow.id,
      name: approverRow.name,
      roles: ["pmc"],
      isApprover: true,
    };
    await db.insert(approvalConfigs).values({ docType: "wo", approverRole: "pmc" });

    const [spu] = await db.insert(spus).values({
      code: "SPU-WO-MULTI",
      nameCn: "多层工单测试",
    }).returning();
    const [finishedRow, semiRow, rawRow] = await db.insert(skus).values([
      { code: "FG-WO-MULTI", name: "成品", spuId: spu.id, skuType: "finished", baseUom: "盒" },
      { code: "SF-WO-MULTI", name: "半成品", spuId: spu.id, skuType: "semi", baseUom: "个" },
      { code: "RM-WO-MULTI", name: "原料", spuId: spu.id, skuType: "raw", baseUom: "克" },
    ]).returning();
    finished = finishedRow.id;
    semi = semiRow.id;
    raw = rawRow.id;
    const [factoryRow, materialSupplierRow] = await db.insert(suppliers).values([
      { code: "SUP-WO-FACTORY", name: "加工厂", kinds: ["processor"], status: "qualified" },
      { code: "SUP-WO-RAW", name: "原料供应商", kinds: ["raw"], status: "qualified" },
    ]).returning();
    factory = factoryRow.id;
    materialSupplier = materialSupplierRow.id;
  });

  const addBom = async (
    productSkuId: number,
    materialSkuId: number,
    qtyPer: string,
    lossRatePct: string,
  ) => {
    const [bom] = await db.insert(boms).values({
      productSkuId,
      versionNo: "V1",
      status: "active",
    }).returning();
    await db.insert(bomLines).values({
      bomId: bom.id,
      materialSkuId,
      qtyPer,
      lossRatePct,
    });
    return bom.id;
  };

  it("审批快照只含末级原料，逐层损耗折算为综合损耗，并可生成 PO", async () => {
    await addBom(finished, semi, "2", "10");
    await addBom(semi, raw, "3", "5");
    const wo = await createWo(creator, {
      productSkuId: finished,
      qty: "100",
      supplierId: factory,
      feeRatePlan: "1",
    }, db);
    const pending = await submitWo(creator, wo.id, wo.version, db);
    await approveWo(approver, wo.id, {
      action: "approve",
      version: pending.version,
    }, db);

    const detail = await getWo(wo.id, db);
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0]).toMatchObject({
      materialSkuId: raw,
      skuCode: "RM-WO-MULTI",
      qtyPer: "6.0000",
      planLossRatePct: "15.50",
      grossReq: "693.0000",
      suggestedQty: "693.0000",
    });
    expect(detail.lines.some((line) => line.materialSkuId === semi)).toBe(false);

    const generated = await generateDocs(creator, wo.id, {
      poGroups: [{
        supplierId: materialSupplier,
        lines: [{ materialSkuId: raw, qty: "693", price: "1" }],
      }],
    }, db);
    expect(generated.pos).toHaveLength(1);
    const lines = await db.select().from(poLines).where(eq(poLines.poId, generated.pos[0].id));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ skuId: raw, lineType: "raw", qty: "693.0000" });
  });

  it("无下级 BOM 的半成品不能冻结为采购行，审批及其审批记录同事务回滚", async () => {
    await addBom(finished, semi, "2", "0");
    const wo = await createWo(creator, {
      productSkuId: finished,
      qty: "100",
      supplierId: factory,
      feeRatePlan: "1",
    }, db);
    const pending = await submitWo(creator, wo.id, wo.version, db);
    await expect(approveWo(approver, wo.id, {
      action: "approve",
      version: pending.version,
    }, db)).rejects.toThrow(/SF-WO-MULTI（semi） 无生效下级 BOM/);

    const [still] = await db.select().from(woDocs).where(eq(woDocs.id, wo.id));
    expect(still.status).toBe("pending");
    expect(await db.select().from(woLines).where(eq(woLines.woId, wo.id))).toHaveLength(0);
    expect(await db.select().from(approvals).where(and(
      eq(approvals.docType, "wo"),
      eq(approvals.docId, wo.id),
    ))).toHaveLength(0);
  });
});
