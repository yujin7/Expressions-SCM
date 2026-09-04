/**
 * W2 审计 6 回归：**唯一的真选源决策点旁边必须看得到事实**。
 *
 * 事故形态：`/outsource/wo`「生成单据」按供应商拆 PO 时，供应商是从一个光秃秃的下拉框里选的——
 * 基准价、学习交期 P90、外部历史观察 P50、OTIF、记分卡等级、是否暂停/拉黑，
 * 系统里全都有，一样都没端到人眼前。
 *
 * 钉住：候选来自「有过往来」的供应商；金额按角色剥离（无权限是 null + moneyVisible=false，
 * 不是 0）；观察值带 observation_only 标签；暂停/拉黑的供应商仍然列出但标出来且排在后面；
 * 面板不排名次也不写任何东西。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  approvals, poDocs, poLines, priceLists, shDocs, shLines, skus, spus, suppliers, users, warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { getSourcingAid, OBSERVED_LABEL } from "@/server/modules/outsource/sourcing-aid";
import { createTestDb, type TestDb } from "../helpers/db";

describe("选源决策辅助（W2 审计 6）", () => {
  let db: TestDb;
  let buyer: SessionUser;
  let ops: SessionUser;
  let skuId = 0;
  let supAId = 0;
  let supBId = 0;
  let supPausedId = 0;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [b] = await db.insert(users).values({ name: "采购", roles: ["purchasing"], isApprover: true }).returning();
    const [w] = await db.insert(users).values({ name: "运营", roles: ["ops"] }).returning();
    buyer = { id: b.id, name: b.name, roles: ["purchasing"], isApprover: true, channelScope: null };
    ops = { id: w.id, name: w.name, roles: ["ops"], isApprover: false, channelScope: null };
    const [spu] = await db.insert(spus).values({ code: "SA-SPU", nameCn: "选源产品" }).returning();
    const [sku] = await db.insert(skus).values({ code: "SA-SKU", name: "原料A", spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning();
    skuId = sku.id;
    const [supA, supB, supPaused, supUnrelated] = await db.insert(suppliers).values([
      { code: "SA-A", name: "供应商A", kinds: ["raw"], status: "qualified", level: "B" },
      { code: "SA-B", name: "供应商B", kinds: ["raw"], status: "qualified" },
      { code: "SA-P", name: "已暂停供应商", kinds: ["raw"], status: "paused" },
      { code: "SA-X", name: "毫无往来的供应商", kinds: ["raw"], status: "qualified" },
    ]).returning();
    supAId = supA.id;
    supBId = supB.id;
    supPausedId = supPaused.id;
    expect(supUnrelated.id).toBeGreaterThan(0);

    // A、暂停方有价目表基准价；B 只有历史 PO 行（两条来路都要能把候选带出来）
    await db.insert(priceLists).values([
      { skuId: sku.id, supplierId: supA.id, price: "10.00", effectiveDate: "2020-01-01" },
      { skuId: sku.id, supplierId: supA.id, price: "9.50", effectiveDate: "2026-01-01" },
      { skuId: sku.id, supplierId: supPaused.id, price: "8.00", effectiveDate: "2026-01-01" },
    ]);
    const [wh] = await db.insert(warehouses).values({ code: "SA-WH", name: "原料仓", kind: "raw" }).returning();
    const [po] = await db.insert(poDocs).values({
      docNo: "PO-SA-B", status: "completed", supplierId: supB.id, createdBy: b.id,
      createdAt: new Date("2026-03-01T02:00:00Z"), expectedDate: "2026-03-20",
    }).returning();
    await db.insert(approvals).values({
      docType: "po", docId: po.id, approverId: b.id, action: "approve", cycle: 1,
      createdAt: new Date("2026-03-02T02:00:00Z"),
    });
    await db.insert(poLines).values({
      poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "kg", uomFactor: "1",
      qty: "100", price: "11.00", receivedQty: "100", expectedDate: "2026-03-20",
    });
    const [sh] = await db.insert(shDocs).values({
      docNo: "SH-SA-B", status: "completed", sourceType: "po", sourceId: po.id,
      warehouseId: wh.id, createdBy: b.id, createdAt: new Date("2026-03-18T02:00:00Z"),
    }).returning();
    await db.insert(shLines).values({ shId: sh.id, skuId: sku.id, lineType: "normal", actualQty: "100" });
  });

  it("候选 = 有价目表基准价或有历史采购行的供应商；毫无往来的不进版面", async () => {
    const aid = await getSourcingAid(buyer, { skuId }, db);
    expect(aid.rows.map((r) => r.code).sort()).toEqual(["SA-A", "SA-B", "SA-P"]);
    expect(aid.skuCode).toBe("SA-SKU");
  });

  it("基准价取当前生效行（与 PO 比价 findBaseline 同一取行规则），无价目行为 null", async () => {
    const aid = await getSourcingAid(buyer, { skuId }, db);
    const a = aid.rows.find((r) => r.supplierId === supAId)!;
    expect(aid.moneyVisible).toBe(true);
    expect(a.price).toBe("9.50"); // 2026-01-01 的行胜过 2020-01-01 的行
    expect(a.priceEffectiveDate).toBe("2026-01-01");
    const b = aid.rows.find((r) => r.supplierId === supBId)!;
    expect(b.price).toBeNull(); // 有历史 PO 但没维护价目表——空，不是 0
  });

  it("金额按角色剥离：无价格权限时 moneyVisible=false 且价格为 null（不是 0）", async () => {
    // ops 能看这张面板（会用「生成单据」），但不在 PRICE_VISIBLE_ROLES 里
    const aid = await getSourcingAid(ops, { skuId }, db);
    expect(aid.moneyVisible).toBe(false);
    for (const r of aid.rows) {
      expect(r.price).toBeNull();
      expect(r.priceCurrency).toBeNull();
    }
    // 非金额事实照常下发（不看价的人也需要知道谁被暂停了）
    expect(aid.rows.some((r) => r.blocked)).toBe(true);
  });

  it("暂停/拉黑的供应商仍然列出但标出来，且排在可选项之后（让人知道它为什么不该被选）", async () => {
    const aid = await getSourcingAid(buyer, { skuId }, db);
    const paused = aid.rows.find((r) => r.supplierId === supPausedId)!;
    expect(paused.blocked).toBe(true);
    expect(paused.statusLabel).toBe("已暂停");
    expect(aid.rows[aid.rows.length - 1].supplierId).toBe(supPausedId);
  });

  it("OTIF 标主口径、观察值带 observation_only 标签，且明说本页只读不排名次", async () => {
    const aid = await getSourcingAid(buyer, { skuId }, db);
    expect(aid.otifBasisLabel).toBe("原始承诺");
    for (const r of aid.rows) expect(r.observedLabel).toBe(OBSERVED_LABEL);
    expect(aid.limitations.join("")).toContain("只读");
    expect(aid.limitations.join("")).toContain("observation_only");
    // 供应商 B 有一张按时收齐的 PO → OTIF 可评
    const b = aid.rows.find((r) => r.supplierId === supBId)!;
    expect(b.otifEvaluable).toBe(1);
    expect(b.otifRate).toBe(1);
  });

  it("首次寻源（无价目行也无历史采购行）明说没有可比事实，而不是给一张空表让人以为系统坏了", async () => {
    const [spu] = await db.insert(spus).values({ code: "SA-SPU2", nameCn: "新物料" }).returning();
    const [fresh] = await db.insert(skus).values({ code: "SA-NEW", name: "新原料", spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning();
    const aid = await getSourcingAid(buyer, { skuId: fresh.id }, db);
    expect(aid.rows).toEqual([]);
    expect(aid.limitations.join("")).toContain("首次寻源");
  });

  it("角色门：与选源无关的角色读不到", async () => {
    const finance: SessionUser = { id: buyer.id, name: "财务", roles: ["finance"], isApprover: false, channelScope: null };
    await expect(getSourcingAid(finance, { skuId }, db)).rejects.toMatchObject({ status: 403 });
  });
});
