import { beforeAll, describe, expect, it } from "vitest";
import {
  bhDocs, bomLines, boms, ctDocs, flDocs, jgDocs, jsDocs, poDocs, shDocs,
  skus, spus, suppliers, users, warehouses, woDocs,
} from "@/db/schema";
import { ApiError } from "@/server/modules/master/common";
import { getChain } from "@/server/modules/outsource/chain";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * 链路视图：BH→WO→PO/JG→FL→SH→CT→JS 全链组装。
 * - 任一环节为入口都解析到同一 WO 中心，返回同一节点集
 * - current 标记入口单据；缺失环节省略（不造假节点）
 * - 独立 PO（woId=null）：局部链 PO(+SH/CT)
 */
describe("链路视图 getChain：从任意环节还原委外全链", () => {
  let db: TestDb;
  let bhId = 0;
  let woId = 0;
  let poId = 0;
  let jgId = 0;
  let flId = 0;
  let shId = 0;
  let ctId = 0;
  let jsId = 0;
  let soloPoId = 0;
  let soloShId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [u] = await db.insert(users).values({ name: "制单人", roles: ["pmc"], isApprover: false }).returning();
    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
    const [cp] = await db
      .insert(skus)
      .values({ code: "CP00001", name: "成品", spuId: spu.id, skuType: "finished", baseUom: "盒" })
      .returning();
    const [yl] = await db
      .insert(skus)
      .values({ code: "YL00001", name: "原料", spuId: spu.id, skuType: "raw", baseUom: "kg" })
      .returning();
    const [supA] = await db
      .insert(suppliers)
      .values({ code: "SUP001", name: "物料供应商", kinds: ["raw"], status: "qualified" })
      .returning();
    const [supC] = await db
      .insert(suppliers)
      .values({ code: "SUP003", name: "加工厂C", kinds: ["processor"], status: "qualified" })
      .returning();
    const [whRaw] = await db
      .insert(warehouses)
      .values({ code: "WH-YL", name: "原料仓", kind: "raw", accountingMode: "realtime" })
      .returning();
    const [whWx] = await db
      .insert(warehouses)
      .values({ code: "WH-WX", name: "委外仓", kind: "outsource", accountingMode: "realtime", supplierId: supC.id })
      .returning();
    const [bom] = await db
      .insert(boms)
      .values({ productSkuId: cp.id, versionNo: "V1", status: "active", effectiveDate: "2026-01-01" })
      .returning();
    await db.insert(bomLines).values({ bomId: bom.id, materialSkuId: yl.id, qtyPer: "0.05", lossRatePct: "2" });

    const [bh] = await db
      .insert(bhDocs)
      .values({ docNo: "BH-001", status: "completed", createdBy: u.id })
      .returning();
    bhId = bh.id;
    const [wo] = await db
      .insert(woDocs)
      .values({
        docNo: "WO-001", status: "in_progress", createdBy: u.id, bhId: bh.id,
        productSkuId: cp.id, qty: "1000", supplierId: supC.id, feeRatePlan: "2.50", bomId: bom.id,
      })
      .returning();
    woId = wo.id;
    const [po] = await db
      .insert(poDocs)
      .values({ docNo: "PO-001", status: "in_progress", createdBy: u.id, woId: wo.id, supplierId: supA.id })
      .returning();
    poId = po.id;
    const [jg] = await db
      .insert(jgDocs)
      .values({
        docNo: "JG-001", status: "in_progress", createdBy: u.id, woId: wo.id, batchSeq: 1,
        supplierId: supC.id, productSkuId: cp.id, qty: "1000", feeRateCurrent: "2.50",
      })
      .returning();
    jgId = jg.id;
    const [fl] = await db
      .insert(flDocs)
      .values({
        docNo: "FL-001", status: "completed", createdBy: u.id, jgId: jg.id,
        fromWarehouseId: whRaw.id, toWarehouseId: whWx.id,
      })
      .returning();
    flId = fl.id;
    const [sh] = await db
      .insert(shDocs)
      .values({ docNo: "SH-001", status: "completed", createdBy: u.id, sourceType: "jg", sourceId: jg.id, warehouseId: whRaw.id })
      .returning();
    shId = sh.id;
    const [ct] = await db
      .insert(ctDocs)
      .values({ docNo: "CT-001", status: "pending", createdBy: u.id, poId: po.id, warehouseId: whRaw.id })
      .returning();
    ctId = ct.id;
    const [js] = await db
      .insert(jsDocs)
      .values({
        docNo: "JS-001", status: "pending", createdBy: u.id, jgId: jg.id,
        goodQty: "1000", feePayable: "2500.00", settleAmount: "2500.00",
      })
      .returning();
    jsId = js.id;

    // 独立采购：woId=null 的 PO + 其收货单（局部链）
    const [soloPo] = await db
      .insert(poDocs)
      .values({ docNo: "PO-SOLO", status: "in_progress", createdBy: u.id, supplierId: supA.id })
      .returning();
    soloPoId = soloPo.id;
    const [soloSh] = await db
      .insert(shDocs)
      .values({ docNo: "SH-SOLO", status: "pending", createdBy: u.id, sourceType: "po", sourceId: soloPo.id, warehouseId: whRaw.id })
      .returning();
    soloShId = soloSh.id;
  });

  const fullChainNos = ["BH-001", "WO-001", "PO-001", "JG-001", "FL-001", "SH-001", "CT-001", "JS-001"];

  it("从 PO 进入：全链有序（BH→WO→PO→JG→FL→SH→CT→JS，无 TL 则省略），current=PO", async () => {
    const { nodes } = await getChain({ docType: "po", id: poId }, db);
    expect(nodes.map((n) => n.docNo)).toEqual(fullChainNos);
    expect(nodes.map((n) => n.docType)).toEqual(["bh", "wo", "po", "jg", "fl", "sh", "ct", "js"]);
    const cur = nodes.filter((n) => n.current);
    expect(cur).toHaveLength(1);
    expect(cur[0].docType).toBe("po");
    expect(cur[0].id).toBe(poId);
    // 节点字段完备：状态中文标签
    const wo = nodes.find((n) => n.docType === "wo")!;
    expect(wo.status).toBe("in_progress");
    expect(wo.statusLabel).toBe("执行中");
    expect(wo.label).toBe("委外工单");
  });

  it("从 FL/SH/JS/CT/BH 进入：解析到同一链，current 各自标记", async () => {
    for (const [docType, id] of [
      ["fl", flId],
      ["sh", shId],
      ["js", jsId],
      ["ct", ctId],
      ["bh", bhId],
      ["wo", woId],
      ["jg", jgId],
    ] as const) {
      const { nodes } = await getChain({ docType, id }, db);
      expect(nodes.map((n) => n.docNo)).toEqual(fullChainNos);
      const cur = nodes.filter((n) => n.current);
      expect(cur).toHaveLength(1);
      expect(cur[0].docType).toBe(docType);
      expect(cur[0].id).toBe(id);
    }
  });

  it("独立 PO（无 WO）：局部链 PO→SH，current=PO；从其 SH 进入亦然", async () => {
    const { nodes } = await getChain({ docType: "po", id: soloPoId }, db);
    expect(nodes.map((n) => n.docNo)).toEqual(["PO-SOLO", "SH-SOLO"]);
    expect(nodes[0].current).toBe(true);

    const r2 = await getChain({ docType: "sh", id: soloShId }, db);
    expect(r2.nodes.map((n) => n.docNo)).toEqual(["PO-SOLO", "SH-SOLO"]);
    expect(r2.nodes.find((n) => n.current)!.docNo).toBe("SH-SOLO");
  });

  it("单据不存在：404", async () => {
    await expect(getChain({ docType: "po", id: 999999 }, db)).rejects.toMatchObject({ status: 404 });
    await expect(getChain({ docType: "po", id: 999999 }, db)).rejects.toBeInstanceOf(ApiError);
  });
});
