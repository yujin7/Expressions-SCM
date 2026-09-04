/**
 * W2 修复（T14 / T15）：记分卡的两条汇总口径。
 *
 * T14 「平均准时率」曾是**各供应商准时率的算术平均**：
 *   9 家各 1 单 100% + 1 家 200 单 50% → 算术平均 95.0%，
 *   而真实的整体准时率是 (9 + 100) / 209 ≈ 52.2%。
 *   一个用来回答「我们整体准不准」的数，被样本量最小的那些供应商主导。
 *   改成 pooled（Σ准时批次 ÷ Σ有承诺交期的批次），并单列被排除的供应商数。
 *
 * T15 质量案件维度只过滤 `status <> 'closed'`，**没有窗口**——一件 2023 年立案、
 *   至今没结的案件在 2026 年照样扣分。这本身是文件头写明的设计意图（久拖不决就该扣），
 *   但页面标着「近 180 天」，读者会以为这几件案子发生在窗口内。
 *   现在把窗口外的未结案件单独计数，并给出明说"本维度不按窗口裁"的标签。
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  poDocs, poLines, poPromiseRevisions, qualityCases, shDocs, shLines,
  skus, spus, suppliers, users, warehouses,
} from "@/db/schema";
import {
  getSupplierScorecard,
  onTimeCounts,
  ON_TIME_AGGREGATION_LABEL,
} from "@/server/modules/report/supplier-scorecard";
import { createTestDb, type TestDb } from "../helpers/db";

describe("纯计数：准时率的分子分母（pooled 汇总的原料）", () => {
  it("分母只数有承诺交期的样本；分子是其中按时到的（与 leadTimeStats 同一条判定）", () => {
    expect(onTimeCounts([
      { actualDays: 10, promisedDays: 12 },
      { actualDays: 20, promisedDays: 12 },
      { actualDays: 12, promisedDays: 12 },
      { actualDays: 5, promisedDays: null },   // 无承诺交期 → 不进分母
    ])).toEqual({ n: 3, hits: 2 });
    expect(onTimeCounts([]), "没有样本就是 0/0，不是 0%").toEqual({ n: 0, hits: 0 });
  });
});

describe("记分卡：整体准时率按样本加权 + 质量案件窗口标签", () => {
  let db: TestDb;
  let bigId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [buyer] = await db.insert(users).values({
      username: "pool_buyer", name: "采购", roles: ["purchasing"], isApprover: true,
    }).returning();
    const [spu] = await db.insert(spus).values({ code: "POOL-SPU", nameCn: "加权测试" }).returning();
    const [sku] = await db.insert(skus).values({
      code: "POOL-SKU", name: "原料", spuId: spu.id, baseUom: "支", skuType: "raw",
    }).returning();
    const [wh] = await db.insert(warehouses).values({ code: "POOL-WH", name: "原料仓", kind: "raw" }).returning();

    let seq = 0;
    /** 造一张 PO + 一次收货：`onTime=true` 时收货早于承诺日 */
    const mkPo = async (supplierId: number, onTime: boolean) => {
      seq += 1;
      const ordered = new Date("2026-08-01T02:00:00Z");
      const promised = "2026-08-20";
      const received = onTime ? "2026-08-15T02:00:00Z" : "2026-08-28T02:00:00Z";
      const [po] = await db.insert(poDocs).values({
        docNo: `PO-POOL-${seq}`, status: "completed", supplierId, createdBy: buyer.id,
        createdAt: ordered, expectedDate: promised,
      }).returning();
      const [line] = await db.insert(poLines).values({
        poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "支", uomFactor: "1",
        qty: "10", price: "1.00", taxIncluded: false, taxRatePct: "13",
        receivedQty: "10", expectedDate: promised,
      }).returning();
      await db.insert(poPromiseRevisions).values({
        poId: po.id, poLineId: line.id, sequence: 1, previousDate: null, promisedDate: promised,
        source: "supplier_confirm", actorType: "supplier_token",
        idempotencyKey: `po:${po.id}:line:${line.id}:promise-seq:1`,
        occurredAt: new Date("2026-08-02T02:00:00Z"),
      });
      const [sh] = await db.insert(shDocs).values({
        docNo: `SH-POOL-${seq}`, status: "completed", sourceType: "po", sourceId: po.id,
        warehouseId: wh.id, createdBy: buyer.id, createdAt: new Date(received),
      }).returning();
      await db.insert(shLines).values({ shId: sh.id, skuId: sku.id, lineType: "normal", actualQty: "10" });
    };

    /* 9 家小供应商各 1 单、全部准时；1 家大供应商 10 单、一半准时。
       算术平均 = (9×100% + 50%) / 10 = 95.0%；pooled = (9 + 5) / 19 ≈ 73.7%。
       （审计里的 9×1 + 1×200 只是量级更极端，结论同构；这里用 10 单跑得快。） */
    for (let i = 1; i <= 9; i++) {
      const [s] = await db.insert(suppliers).values({
        code: `POOL-S${i}`, name: `小供应商${i}`, kinds: ["raw"], status: "qualified",
      }).returning();
      await mkPo(s.id, true);
    }
    const [big] = await db.insert(suppliers).values({
      code: "POOL-BIG", name: "大供应商", kinds: ["raw"], status: "qualified",
    }).returning();
    bigId = big.id;
    for (let i = 0; i < 10; i++) await mkPo(big.id, i < 5);

    /* 一家只有质量案件、没有任何收货的供应商：
       - 它没有承诺交期样本 → 必须被排除在准时率之外（缺数据 ≠ 差）；
       - 案件立案于窗口之外（2023），至今未结 → 仍扣分，但必须被单独数出来。 */
    const [caseOnly] = await db.insert(suppliers).values({
      code: "POOL-CASE", name: "陈年案件供应商", kinds: ["raw"], status: "qualified",
    }).returning();
    const mkCase = async (caseNo: string, title: string, receivedDate: string, createdAt: Date) =>
      db.insert(qualityCases).values({
        caseNo, kind: "complaint", status: "active", supplierId: caseOnly.id,
        title, summary: title, ownerId: buyer.id, createdBy: buyer.id,
        receivedDate, idempotencyKey: caseNo, createdAt,
      });
    await mkCase("QI-OLD-1", "2023 年立案至今未结", "2023-05-01", new Date("2023-05-01T02:00:00Z"));
    await mkCase("QI-NEW-1", "窗口内立案", "2026-09-01", new Date());
  });

  it("T14 整体准时率是 pooled（样本加权），不是各供应商比率的算术平均", async () => {
    const card = await getSupplierScorecard({ windowDays: 1095, pageSize: 500 }, db);

    // pooled 分子/分母必须一起下发，读者能自己复核
    expect(card.summary.onTimeSamples, "9 家各 1 单 + 大供应商 10 单").toBe(19);
    expect(card.summary.onTimeHits, "9 单准时 + 大供应商 5 单准时").toBe(14);
    expect(card.summary.avgOnTimeRate).toBeCloseTo(14 / 19, 4);

    // 算术平均会给出 95.0%——两者必须真的不同，否则这条修复没有分辨力
    const rates = card.rows.filter((r) => r.onTimeRate != null).map((r) => r.onTimeRate as number);
    const unweighted = rates.reduce((a, b) => a + b, 0) / rates.length;
    expect(unweighted).toBeCloseTo(0.95, 4);
    expect(
      card.summary.avgOnTimeRate,
      "算术平均被 9 家各 1 单的小供应商主导；pooled 才回答「我们整体准不准」",
    ).not.toBeCloseTo(unweighted, 3);

    // 大供应商自己的比率仍是 50%（逐行口径不变，只有汇总换了算法）
    expect(card.rows.find((r) => r.supplierId === bigId)?.onTimeRate).toBeCloseTo(0.5, 4);
    expect(card.summary.onTimeAggregationLabel).toBe(ON_TIME_AGGREGATION_LABEL);
    expect(card.summary.onTimeAggregationLabel).toContain("样本加权");
  });

  it("T14 无承诺交期样本的供应商不进分子分母，但被排除的数量必须可见", async () => {
    const card = await getSupplierScorecard({ windowDays: 1095, pageSize: 500 }, db);
    expect(card.summary.onTimeSuppliers, "10 家有交期样本").toBe(10);
    expect(
      card.summary.onTimeExcludedSuppliers,
      "只有质量案件、没有收货的那家：缺数据不按 0% 计入，但也不能悄悄消失",
    ).toBe(1);
    expect(card.summary.onTimeSuppliers + card.summary.onTimeExcludedSuppliers).toBe(card.summary.suppliers);
  });

  it("T15 质量案件不按窗口裁——窗口外的未结案件单独计数，标签明说这一维不受 windowDays 限制", async () => {
    const card = await getSupplierScorecard({ windowDays: 180, pageSize: 500 }, db);
    const row = card.rows.find((r) => r.code === "POOL-CASE")!;
    expect(row.openQualityCases, "两件都未结，两件都扣分").toBe(2);
    expect(row.legacyQualityCases, "其中 1 件立案于 180 天窗口之外").toBe(1);

    expect(card.summary.legacyQualityCases).toBe(1);
    expect(card.summary.qualityCaseScope).toContain("180");
    expect(
      card.summary.qualityCaseScope,
      "页面标着「近 180 天」，就必须在同一处说清这一维不按窗口裁",
    ).toContain("不按");
  });

  it("窗口变长时「窗口外案件」数随之变化（标签不是写死的装饰）", async () => {
    const wide = await getSupplierScorecard({ windowDays: 1095, pageSize: 500 }, db);
    expect(wide.summary.legacyQualityCases, "3 年窗口下 2023 年的案件仍在窗口外").toBe(1);
    const narrow = await getSupplierScorecard({ windowDays: 30, pageSize: 500 }, db);
    expect(narrow.summary.qualityCaseScope).toContain("30");
  });
});
