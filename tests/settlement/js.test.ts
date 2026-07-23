import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  approvalConfigs, auditLogs, bomLines, boms, flDocs, flLines, jgDocs, jgFeeSegments,
  jsDocs, jsLines, priceLists, qcLines, qcRecords, shDocs, shLines, skus, spus,
  stockBalances, stockLedger, suppliers, sysParams, tlDocs, tlLines, users,
  warehouses, woDocs, woLines,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { settle } from "@/server/rules/settlement";
import {
  approveJs, closeJgReceiving, createJs, getJs, listJss, previewJs, submitJs,
} from "@/server/modules/settlement/js";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * W4 委外结算 JS（R5 逐物料）集成测试。
 * 夹具全部直插（FL/TL/SH/QC 由 matflow 模块并行开发中——表共享、模块不共享）；
 * 品类损耗率与 seed 同口径：packaging 5% / raw 2%；让步价率设 50 以验证 D6 比例。
 * 扣款价 = price_lists 代理口径（D23 候选偏差，deductPriceSource=price_list_proxy）。
 */
describe("委外结算 W4：previewJs/createJs/approveJs → js_loss_writeoff（R5 逐物料，禁止轧差）", () => {
  let db: TestDb;
  let pmcCreator: SessionUser;
  let financeApprover: SessionUser;
  let financePmc: SessionUser; // 双角色：SoD 自审拦截用
  let admin: SessionUser;

  let cp = 0; // 成品
  let yl = 0; // 原料 lossCategory=raw(2%)  价 120.00
  let bc = 0; // 包材 lossCategory=packaging(5%)  价 0.45
  let bc2 = 0; // 包材 无价格表（扣款价代理缺价→0+警告）
  let bomId = 0;
  let whFin = 0;
  let whRaw = 0;

  const T_SEG1 = new Date("2026-06-01T00:00:00Z");
  const T_SH1 = new Date("2026-07-01T00:00:00Z");
  const T_FEE_CHANGE = new Date("2026-07-10T00:00:00Z");
  const T_SH2 = new Date("2026-07-15T00:00:00Z");

  let seq = 0;

  type ShSpec = {
    createdAt: Date;
    status?: "approved" | "completed";
    lines: {
      lineType: "normal" | "rework" | "spare";
      actualQty: string;
      passQty?: string;
      concessionQty?: string;
    }[];
  };

  /** 每场景独立 供应商+委外仓+WO+JG（+FL/TL/SH/QC/期初委外仓余额），互不串数 */
  async function mkScenario(opts: {
    jgStatus?: "in_progress" | "completed" | "closed";
    feeRateCurrent: string;
    segments?: { rate: string; effectiveFrom: Date }[];
    materials: { skuId: number; qtyPer: string }[];
    fl?: { skuId: number; qty: string }[];
    tl?: { skuId: number; qty: string }[];
    shs?: ShSpec[];
    outsourceBalances?: { skuId: number; qty: string }[];
  }) {
    seq += 1;
    const [sup] = await db
      .insert(suppliers)
      .values({ code: `SUPX${seq}`, name: `加工厂${seq}`, kinds: ["processor"], status: "qualified" })
      .returning();
    const [whWx] = await db
      .insert(warehouses)
      .values({ code: `WH-WX${seq}`, name: `委外仓${seq}`, kind: "outsource", supplierId: sup.id })
      .returning();
    const [wo] = await db
      .insert(woDocs)
      .values({
        docNo: `WO-T-${seq}`, status: "completed", productSkuId: cp, qty: "1000",
        supplierId: sup.id, feeRatePlan: "2.00", bomId, createdBy: admin.id,
      })
      .returning();
    await db.insert(woLines).values(
      opts.materials.map((m) => ({
        woId: wo.id, materialSkuId: m.skuId, qtyPer: m.qtyPer,
        grossReq: m.qtyPer, suggestedQty: "0",
      })),
    );
    const [jg] = await db
      .insert(jgDocs)
      .values({
        docNo: `JG-T-${seq}`, status: opts.jgStatus ?? "completed", woId: wo.id,
        supplierId: sup.id, productSkuId: cp, qty: "1000",
        feeRateCurrent: opts.feeRateCurrent, createdBy: admin.id,
      })
      .returning();
    if (opts.segments?.length) {
      await db.insert(jgFeeSegments).values(
        opts.segments.map((s) => ({ jgId: jg.id, rate: s.rate, effectiveFrom: s.effectiveFrom })),
      );
    }
    if (opts.fl?.length) {
      const [fl] = await db
        .insert(flDocs)
        .values({
          docNo: `FL-T-${seq}`, status: "approved", jgId: jg.id,
          fromWarehouseId: whRaw, toWarehouseId: whWx.id, createdBy: admin.id,
        })
        .returning();
      await db.insert(flLines).values(opts.fl.map((l) => ({ flId: fl.id, skuId: l.skuId, qty: l.qty })));
    }
    if (opts.tl?.length) {
      const [tl] = await db
        .insert(tlDocs)
        .values({
          docNo: `TL-T-${seq}`, status: "completed", jgId: jg.id,
          fromWarehouseId: whWx.id, toWarehouseId: whRaw, createdBy: admin.id,
        })
        .returning();
      await db.insert(tlLines).values(
        opts.tl.map((l) => ({ tlId: tl.id, skuId: l.skuId, qty: l.qty, reason: "surplus_return" as const })),
      );
    }
    let shSeq = 0;
    for (const sh of opts.shs ?? []) {
      shSeq += 1;
      const [shDoc] = await db
        .insert(shDocs)
        .values({
          docNo: `SH-T-${seq}-${shSeq}`, status: sh.status ?? "completed",
          sourceType: "jg", sourceId: jg.id, warehouseId: whFin,
          createdBy: admin.id, createdAt: sh.createdAt,
        })
        .returning();
      const insertedLines = await db
        .insert(shLines)
        .values(
          sh.lines.map((l) => ({
            shId: shDoc.id, skuId: cp, lineType: l.lineType, actualQty: l.actualQty,
          })),
        )
        .returning();
      const qcable = insertedLines.filter((l) => l.lineType !== "spare");
      if (qcable.length) {
        const [qc] = await db
          .insert(qcRecords)
          .values({ shId: shDoc.id, conclusion: "合格", createdBy: admin.id })
          .returning();
        await db.insert(qcLines).values(
          qcable.map((l, i) => {
            const spec = sh.lines.filter((x) => x.lineType !== "spare")[i];
            return {
              qcId: qc.id, shLineId: l.id,
              passQty: spec.passQty ?? "0",
              concessionQty: spec.concessionQty ?? "0",
            };
          }),
        );
      }
    }
    if (opts.outsourceBalances?.length) {
      await db.insert(stockBalances).values(
        opts.outsourceBalances.map((b) => ({ skuId: b.skuId, warehouseId: whWx.id, qty: b.qty })),
      );
    }
    return { woId: wo.id, jgId: jg.id, whWxId: whWx.id, supplierId: sup.id };
  }

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mkUser = async (name: string, roles: string[], isApprover: boolean): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover }).returning();
      return { id: u.id, name: u.name, roles, isApprover };
    };
    pmcCreator = await mkUser("PMC制单", ["pmc"], false);
    financeApprover = await mkUser("财务审批", ["finance"], true);
    financePmc = await mkUser("财务兼PMC", ["pmc", "finance"], true);
    admin = await mkUser("管理员", ["admin"], true);

    await db.insert(approvalConfigs).values([{ docType: "js", approverRole: "finance" }]);
    await db.insert(sysParams).values([
      { scope: "category:packaging", key: "loss_rate_pct", value: "5" },
      { scope: "category:raw", key: "loss_rate_pct", value: "2" },
      { scope: "global", key: "concession_price_ratio", value: "50" }, // D6 比例可验证（非 100 默认）
    ]);

    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "结算测试产品" }).returning();
    const mkSku = async (
      code: string, name: string, skuType: "finished" | "raw" | "packaging",
      lossCategory: string | null,
    ) => {
      const [s] = await db
        .insert(skus)
        .values({ code, name, spuId: spu.id, skuType, baseUom: "个", lossCategory })
        .returning();
      return s.id;
    };
    cp = await mkSku("CP00001", "成品", "finished", null);
    yl = await mkSku("YL00001", "原料粉", "raw", "raw");
    bc = await mkSku("BC00001", "瓶身", "packaging", "packaging");
    bc2 = await mkSku("BC00002", "彩盒(无价)", "packaging", "packaging");

    const [sup0] = await db
      .insert(suppliers)
      .values({ code: "SUP000", name: "物料供应商", kinds: ["raw", "packaging"], status: "qualified" })
      .returning();
    await db.insert(priceLists).values([
      { skuId: yl, supplierId: sup0.id, price: "120.00", effectiveDate: "2026-01-01" },
      { skuId: bc, supplierId: sup0.id, price: "0.40", effectiveDate: "2026-01-01" },
      { skuId: bc, supplierId: sup0.id, price: "0.45", effectiveDate: "2026-06-01" }, // 取生效日≤今日最新
      // bc2 故意无价格行（测试 6）
    ]);

    const [whF] = await db
      .insert(warehouses)
      .values({ code: "WH-CP", name: "成品仓", kind: "finished" })
      .returning();
    whFin = whF.id;
    const [whR] = await db
      .insert(warehouses)
      .values({ code: "WH-YL", name: "原料仓", kind: "raw" })
      .returning();
    whRaw = whR.id;

    const [bom] = await db
      .insert(boms)
      .values({ productSkuId: cp, versionNo: "V1", status: "active", effectiveDate: "2026-01-01" })
      .returning();
    bomId = bom.id;
    await db.insert(bomLines).values([
      { bomId, materialSkuId: yl, qtyPer: "0.05", lossRatePct: "2" },
      { bomId, materialSkuId: bc, qtyPer: "10", lossRatePct: "5" },
    ]);
  });

  it("1) 审计反例全流程：超发包材→扣款=settle() 输出；审批过账 js_loss_writeoff，委外仓逐料减实际损耗至 0", async () => {
    const sc = await mkScenario({
      feeRateCurrent: "2.20",
      segments: [
        { rate: "2.00", effectiveFrom: T_SEG1 },
        { rate: "2.20", effectiveFrom: T_FEE_CHANGE },
      ],
      materials: [
        { skuId: yl, qtyPer: "0.05" },
        { skuId: bc, qtyPer: "10" },
      ],
      fl: [
        { skuId: yl, qty: "55" },
        { skuId: bc, qty: "11000" },
      ],
      tl: [{ skuId: yl, qty: "4" }],
      shs: [
        { createdAt: T_SH1, lines: [{ lineType: "normal", actualQty: "500", passQty: "500" }] },
        { createdAt: T_SH2, lines: [{ lineType: "normal", actualQty: "500", passQty: "500" }] },
      ],
      // 模拟此前 FL/TL/SH 过账后的委外仓净余额 = 实际损耗（YL 1 / BC 1000）
      outsourceBalances: [
        { skuId: yl, qty: "1" },
        { skuId: bc, qty: "1000" },
      ],
    });

    // ---- 预览 = rules settle() 的输出（数学唯一权威，禁止在模块内重算） ----
    const preview = await previewJs(sc.jgId, "0", db);
    const expected = settle({
      goodQty: "1000",
      concessionQty: "0",
      spareQty: "0",
      feeSegments: [
        { qty: "500", rate: "2.00" },
        { qty: "500", rate: "2.20" },
      ],
      concessionPrice: "1.10", // 2.20×50%
      manualAdj: "0",
      materials: [
        { materialSkuId: yl, qtyPer: "0.05", issuedQty: "55", returnedQty: "4", allowedLossRatePct: "2", avgPrice: "120.00" },
        { materialSkuId: bc, qtyPer: "10", issuedQty: "11000", returnedQty: "0", allowedLossRatePct: "5", avgPrice: "0.45" },
      ],
    });
    expect(preview.effectiveQty).toBe(expected.effectiveQty);
    expect(preview.feePayable).toBe(expected.feePayable); // 500×2.00+500×2.20=2100.00
    expect(preview.feePayable).toBe("2100.00");
    expect(preview.deductionTotal).toBe(expected.deductionTotal);
    expect(preview.deductionTotal).toBe("225.00"); // 超额 500×0.45
    expect(preview.settleAmount).toBe("1875.00");
    expect(preview.deductPriceSource).toBe("price_list_proxy");
    expect(preview.surplusMaterials).toEqual([]);

    const pvYl = preview.lines.find((l) => l.materialSkuId === yl)!;
    expect(pvYl).toMatchObject({ stdQty: "50.0000", allowedLoss: "1.0000", actualLoss: "1.0000", excessLoss: "0.0000" });
    const pvBc = preview.lines.find((l) => l.materialSkuId === bc)!;
    expect(pvBc).toMatchObject({
      stdQty: "10000.0000", allowedLoss: "500.0000", actualLoss: "1000.0000",
      excessLoss: "500.0000", deductPrice: "0.45", deductAmount: "225.00",
    });

    // ---- 创建（JG 已收货关闭）→ jsLines 与预览一致 ----
    const doc = await createJs(pmcCreator, { jgId: sc.jgId }, db);
    expect(doc.docNo.startsWith("JS-")).toBe(true);
    expect(doc.settleAmount).toBe("1875.00");
    const rows = await db.select().from(jsLines).where(eq(jsLines.jsId, doc.id));
    expect(rows).toHaveLength(2);
    const rowBc = rows.find((r) => r.materialSkuId === bc)!;
    expect(rowBc).toMatchObject({
      issuedQty: "11000.0000", returnedQty: "0.0000", stdQty: "10000.0000",
      allowedLoss: "500.0000", actualLoss: "1000.0000", excessLoss: "500.0000",
      deductPrice: "0.45", deductAmount: "225.00",
    });

    // ---- 提交 + 财务审批 → 同事务损耗核销 ----
    const pending = await submitJs(pmcCreator, doc.id, { version: doc.version }, db);
    const r = await approveJs(financeApprover, doc.id, { action: "approve", version: pending.version }, db);
    expect(r).toMatchObject({ status: "completed", idempotent: false });

    const ledger = await db
      .select()
      .from(stockLedger)
      .where(and(eq(stockLedger.sourceDocType, "js_loss_writeoff"), eq(stockLedger.sourceDocId, doc.id)));
    expect(ledger).toHaveLength(2); // YL −1、BC −1000（逐物料，仅正损耗）
    const ledBc = ledger.find((l) => l.skuId === bc)!;
    expect(ledBc.qtyDelta).toBe("-1000.0000");
    expect(ledBc.warehouseId).toBe(sc.whWxId);

    // 核销后该 JG 委外仓余额必须 = 0（《01》§4）
    const bals = await db.select().from(stockBalances).where(eq(stockBalances.warehouseId, sc.whWxId));
    for (const b of bals) expect(b.qty).toBe("0.0000");

    // 详情：行 + 审批时间线 + 取价口径
    const detail = await getJs(doc.id, db);
    expect(detail.lines).toHaveLength(2);
    expect(detail.approvals.length).toBeGreaterThan(0);
    expect(detail.deductPriceSource).toBe("price_list_proxy");
  });

  it("2) 加工费分段：改价前后两张 SH → feePayable = q1×2.00 + q2×2.20", async () => {
    const sc = await mkScenario({
      feeRateCurrent: "2.20",
      segments: [
        { rate: "2.00", effectiveFrom: T_SEG1 },
        { rate: "2.20", effectiveFrom: T_FEE_CHANGE },
      ],
      materials: [{ skuId: bc, qtyPer: "1" }],
      fl: [{ skuId: bc, qty: "1000" }],
      shs: [
        { createdAt: T_SH1, lines: [{ lineType: "normal", actualQty: "300", passQty: "300" }] },
        { createdAt: T_SH2, lines: [{ lineType: "normal", actualQty: "700", passQty: "700" }] },
      ],
    });
    const preview = await previewJs(sc.jgId, "0", db);
    expect(preview.feeSegments).toEqual([
      { qty: "300.0000", feeRate: "2.00" },
      { qty: "700.0000", feeRate: "2.20" },
    ]);
    expect(preview.feePayable).toBe("2140.00"); // 300×2.00 + 700×2.20
    expect(preview.deductionTotal).toBe("0.00"); // 发料=净标准用量，零损耗
    expect(preview.settleAmount).toBe("2140.00");
  });

  it("3) 让步+备品：让步按 现价×价率 计费；备品不计加工费但计入净标准用量基数", async () => {
    const sc = await mkScenario({
      feeRateCurrent: "2.00",
      segments: [{ rate: "2.00", effectiveFrom: T_SEG1 }],
      materials: [{ skuId: bc, qtyPer: "10" }],
      fl: [{ skuId: bc, qty: "10000" }], // = 10×(800+100+100)，零损耗
      shs: [
        {
          createdAt: T_SH1,
          status: "completed",
          lines: [
            { lineType: "normal", actualQty: "900", passQty: "800", concessionQty: "100" },
            { lineType: "spare", actualQty: "100" },
          ],
        },
      ],
    });
    const preview = await previewJs(sc.jgId, "0", db);
    expect(preview.goodQty).toBe("800.0000");
    expect(preview.concessionQty).toBe("100.0000");
    expect(preview.spareQty).toBe("100.0000");
    expect(preview.effectiveQty).toBe("1000.0000"); // 备品/让步同样消耗物料
    expect(preview.concessionPrice).toBe("1.00"); // 2.00 × 50%（concession_price_ratio）
    // 800×2.00 + 100×1.00 = 1700；备品 100 不计加工费
    expect(preview.feePayable).toBe("1700.00");
    expect(preview.lines[0].stdQty).toBe("10000.0000"); // 基数含备品
    expect(preview.deductionTotal).toBe("0.00");
  });

  it("4) 结余闸门：负实际损耗 → 审批 409；acknowledgeSurplus+说明 → 通过且该料不过账、留痕", async () => {
    const sc = await mkScenario({
      feeRateCurrent: "2.00",
      segments: [{ rate: "2.00", effectiveFrom: T_SEG1 }],
      materials: [
        { skuId: yl, qtyPer: "0.05" },
        { skuId: bc, qtyPer: "10" },
      ],
      // Q=100：YL std=5，发10退6 → 实际损耗 −1（结余）；BC std=1000，发1100 → 损耗100（允许50，超50）
      fl: [
        { skuId: yl, qty: "10" },
        { skuId: bc, qty: "1100" },
      ],
      tl: [{ skuId: yl, qty: "6" }],
      shs: [{ createdAt: T_SH1, lines: [{ lineType: "normal", actualQty: "100", passQty: "100" }] }],
      outsourceBalances: [
        { skuId: yl, qty: "-1" }, // 结余料仍留仓（此处仅验证不再被核销触碰）
        { skuId: bc, qty: "100" },
      ],
    });
    const preview = await previewJs(sc.jgId, "0", db);
    expect(preview.surplusMaterials).toEqual([{ skuId: yl, skuCode: "YL00001", surplus: "1.0000" }]);

    const doc = await createJs(pmcCreator, { jgId: sc.jgId }, db);
    const pending = await submitJs(pmcCreator, doc.id, { version: doc.version }, db);

    // 未确认结余 → 409，指名物料与结余量
    await expect(
      approveJs(financeApprover, doc.id, { action: "approve", version: pending.version }, db),
    ).rejects.toThrow(/YL00001.*结余1\.0000.*退料\(TL\)/);
    // 确认但缺说明 → 校验失败（留痕强制）
    await expect(
      approveJs(financeApprover, doc.id, {
        action: "approve", version: pending.version, acknowledgeSurplus: true,
      }, db),
    ).rejects.toThrow(/短溢说明/);

    const r = await approveJs(financeApprover, doc.id, {
      action: "approve", version: pending.version,
      acknowledgeSurplus: true, surplusNote: "厂方少领 1 件原料，双方对账确认",
    }, db);
    expect(r.status).toBe("completed");

    // 结余（负损耗）物料不过账——仅 BC 有核销流水
    const ledger = await db
      .select()
      .from(stockLedger)
      .where(and(eq(stockLedger.sourceDocType, "js_loss_writeoff"), eq(stockLedger.sourceDocId, doc.id)));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].skuId).toBe(bc);
    expect(ledger[0].qtyDelta).toBe("-100.0000");
    const [bcBal] = await db
      .select()
      .from(stockBalances)
      .where(and(eq(stockBalances.warehouseId, sc.whWxId), eq(stockBalances.skuId, bc)));
    expect(bcBal.qty).toBe("0.0000"); // BC 核销后归零
    const [ylBal] = await db
      .select()
      .from(stockBalances)
      .where(and(eq(stockBalances.warehouseId, sc.whWxId), eq(stockBalances.skuId, yl)));
    expect(ylBal.qty).toBe("-1.0000"); // 结余料未被触碰（真实结余留账）

    // 短溢确认审计留痕
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity, "js"), eq(auditLogs.entityId, doc.id), eq(auditLogs.action, "approve")));
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toMatchObject({
      acknowledgeSurplus: true,
      surplusNote: "厂方少领 1 件原料，双方对账确认",
    });
  });

  it("5) 一 JG 一 JS(409)；JG 未关闭不可开单；手工调整必须留痕；SoD 财务自审拦截；jg-close 流转", async () => {
    // 场景 1 的 JG 已有 JS → 再创建 409
    const [existingJs] = await db.select().from(jsDocs).orderBy(jsDocs.id).limit(1);
    await expect(createJs(pmcCreator, { jgId: existingJs.jgId }, db)).rejects.toThrow(/一 JG 一 JS/);

    // JG in_progress：先拒绝开单 → closeJgReceiving（in_progress→completed）→ 可开单
    const sc = await mkScenario({
      jgStatus: "in_progress",
      feeRateCurrent: "2.00",
      segments: [{ rate: "2.00", effectiveFrom: T_SEG1 }],
      materials: [{ skuId: bc, qtyPer: "1" }],
      fl: [{ skuId: bc, qty: "100" }],
      shs: [{ createdAt: T_SH1, lines: [{ lineType: "normal", actualQty: "100", passQty: "100" }] }],
    });
    await expect(createJs(pmcCreator, { jgId: sc.jgId }, db)).rejects.toThrow(/尚未收货关闭/);
    const [jgRow] = await db.select().from(jgDocs).where(eq(jgDocs.id, sc.jgId));
    const closed = await closeJgReceiving(pmcCreator, sc.jgId, jgRow.version, db);
    expect(closed.status).toBe("completed");
    // 已完成的 JG 不可重复关闭
    await expect(closeJgReceiving(pmcCreator, sc.jgId, closed.version, db)).rejects.toThrow(/不可关闭/);

    // 手工调整 ≠ 0 必须留痕说明
    await expect(
      createJs(pmcCreator, { jgId: sc.jgId, manualAdj: "-5.00" }, db),
    ).rejects.toThrow(/调整说明/);

    // SoD：财务兼 PMC 自己制单后不得自审（审批人≠制单人，管理员亦不豁免）
    const doc = await createJs(financePmc, {
      jgId: sc.jgId, manualAdj: "-5.00", manualAdjNote: "扣除来回运费分摊",
    }, db);
    expect(doc.manualAdj).toBe("-5.00");
    expect(doc.settleAmount).toBe("195.00"); // 100×2.00 − 0 − 5
    const pending = await submitJs(financePmc, doc.id, { version: doc.version }, db);
    await expect(
      approveJs(financePmc, doc.id, { action: "approve", version: pending.version }, db),
    ).rejects.toThrow(/SELF_APPROVAL/);
    // 另一位财务审批人可通过
    const r = await approveJs(financeApprover, doc.id, { action: "approve", version: pending.version }, db);
    expect(r.status).toBe("completed");

    // 手工调整创建留痕（audit after 带 manualAdjNote）
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity, "js"), eq(auditLogs.entityId, doc.id), eq(auditLogs.action, "create")));
    expect(audits[0].after).toMatchObject({ manualAdj: "-5.00", manualAdjNote: "扣除来回运费分摊" });

    // 列表联查（jg/wo/supplier）
    const list = await listJss("", { page: 1, pageSize: 10 }, db);
    expect(list.total).toBeGreaterThanOrEqual(3);
    const row = (list.rows as { jgDocNo: string; supplierName: string; woDocNo: string }[])[0];
    expect(row.jgDocNo).toBeTruthy();
    expect(row.woDocNo).toBeTruthy();
    expect(row.supplierName).toBeTruthy();
  });

  it("6) 扣款价代理：无 price_lists 行 → deductPrice=0 + 预览警告 + 口径标识", async () => {
    const sc = await mkScenario({
      feeRateCurrent: "2.00",
      segments: [{ rate: "2.00", effectiveFrom: T_SEG1 }],
      materials: [{ skuId: bc2, qtyPer: "1" }],
      fl: [{ skuId: bc2, qty: "200" }], // std=100，损耗 100 全超额——但无价可扣
      shs: [{ createdAt: T_SH1, lines: [{ lineType: "normal", actualQty: "100", passQty: "100" }] }],
    });
    const preview = await previewJs(sc.jgId, "0", db);
    expect(preview.deductPriceSource).toBe("price_list_proxy");
    const line = preview.lines[0];
    expect(line.deductPrice).toBe("0.00");
    expect(line.excessLoss).toBe("95.0000"); // 100 − 允许 5%×100
    expect(line.deductAmount).toBe("0.00"); // 缺价 → 0，不臆造
    expect(preview.warnings.some((w) => w.includes("BC00002") && w.includes("无价格表"))).toBe(true);
  });
});
