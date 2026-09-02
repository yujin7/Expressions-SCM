import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  auditLogs, bhDocs, bhLines, channels, poDocs, poLines, salesMonthly, skus, spus,
  stockBalances, stockSnapshots, suppliers, uomConvs, users, warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  createReplenishDraft,
  getReplenishSuggestions,
  isPddWindowIncomplete,
  normalizeReplenishSort,
} from "@/server/modules/replenish/service";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * R11 补货建议：
 * - 在库=全网口径（Σbalances + 快照仓最新快照）；在途=已审批/执行中 PO 未收量（qty×factor−received，逐行下限0）；
 * - 日均销=近3月（由 max(yearMonth) 动态回推）÷91；
 * - 建议量=净需求经 MOQ/倍数取整（uom_convs 首行，基础单位口径，与 wo.ts 快照一致）；
 * - 草稿生成=复用 createBh（R13 人工闸），pmc/admin。
 */
describe("R11 补货建议：口径 + 建议量 + BH 草稿", () => {
  it("拼多多身份已覆盖但净量恰为零时，窗口不足仍不得折算日均", () => {
    expect(isPddWindowIncomplete({ pddIdentityCovered: true }, false)).toBe(true);
    expect(isPddWindowIncomplete({ pddIdentityCovered: true }, true)).toBe(false);
    expect(isPddWindowIncomplete({ pddIdentityCovered: false }, false)).toBe(false);
  });
  let db: TestDb;
  let pmcUser: SessionUser;
  let whUser: SessionUser; // 无权限角色（403 用）
  let cp1 = 0; // 成品：触发建议（MOQ/倍数取整）
  let cp2 = 0; // 成品：库存充足，不触发

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mkUser = async (name: string, roles: string[]): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover: false }).returning();
      return { id: u.id, name: u.name, roles, isApprover: false };
    };
    pmcUser = await mkUser("PMC计划员", ["pmc"]);
    whUser = await mkUser("仓管员", ["warehouse"]);

    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
    const mkSku = async (code: string, name: string, skuType: "finished" | "raw" | "packaging") => {
      const [s] = await db.insert(skus).values({ code, name, spuId: spu.id, skuType, baseUom: "盒" }).returning();
      return s.id;
    };
    cp1 = await mkSku("CP00001", "胶原蛋白肽饮品", "finished");
    cp2 = await mkSku("CP00002", "库存充足成品", "finished");
    await mkSku("CP00003", "无动销成品", "finished");
    await mkSku("YL00001", "胶原蛋白肽粉", "raw");

    const [whA] = await db
      .insert(warehouses)
      .values({ code: "WH-A", name: "成品仓A", kind: "finished", accountingMode: "realtime" })
      .returning();
    const [whS] = await db
      .insert(warehouses)
      .values({ code: "WH-S", name: "保税快照仓", kind: "snapshot", accountingMode: "snapshot" })
      .returning();

    // 在库：实时账 cp1=100 / cp2=5000；快照仓 cp1 两天快照（取最新 50，不叠加旧快照 40）
    await db.insert(stockBalances).values([
      { skuId: cp1, warehouseId: whA.id, qty: "100" },
      { skuId: cp2, warehouseId: whA.id, qty: "5000" },
    ]);
    await db.insert(stockSnapshots).values([
      { warehouseId: whS.id, skuId: cp1, bizDate: "2026-07-01", qty: "40" },
      { warehouseId: whS.id, skuId: cp1, bizDate: "2026-07-10", qty: "50" },
    ]);

    // 在途：approved PO 行 2×10−5=15；draft PO 不计；超收行（1×10−20）下限 0 不倒扣
    const [sup] = await db
      .insert(suppliers)
      .values({ code: "SUP001", name: "供应商A", kinds: ["raw"], status: "qualified" })
      .returning();
    const mkPo = async (docNo: string, status: "draft" | "approved") => {
      const [po] = await db
        .insert(poDocs)
        .values({ docNo, status, supplierId: sup.id, createdBy: pmcUser.id })
        .returning();
      return po.id;
    };
    const poOk = await mkPo("PO-T-001", "approved");
    const poDraft = await mkPo("PO-T-002", "draft");
    const poOver = await mkPo("PO-T-003", "approved");
    await db.insert(poLines).values([
      { poId: poOk, skuId: cp1, lineType: "raw", purchaseUom: "箱", uomFactor: "10", qty: "2", price: "1.00", receivedQty: "5" },
      { poId: poDraft, skuId: cp1, lineType: "raw", purchaseUom: "箱", uomFactor: "10", qty: "999", price: "1.00" },
      { poId: poOver, skuId: cp1, lineType: "raw", purchaseUom: "箱", uomFactor: "10", qty: "1", price: "1.00", receivedQty: "20" },
    ]);

    // 销速：max(yearMonth)=2026-06 → 窗口 2026-04..06；旧月 2026-01 不进窗口
    const [ch] = await db.insert(channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
    await db.insert(salesMonthly).values([
      { skuId: cp1, channelId: ch.id, yearMonth: "2026-04", qty: "300" },
      { skuId: cp1, channelId: ch.id, yearMonth: "2026-05", qty: "300" },
      { skuId: cp1, channelId: ch.id, yearMonth: "2026-06", qty: "310" },
      { skuId: cp1, channelId: ch.id, yearMonth: "2026-01", qty: "99999" },
      { skuId: cp2, channelId: ch.id, yearMonth: "2026-06", qty: "910" },
    ]);

    // MOQ/倍数（基础单位口径，与 wo.ts 快照一致）：cp1 MOQ=300、倍数=50
    await db.insert(uomConvs).values({ skuId: cp1, purchaseUom: "箱", factor: "1", moq: "300", orderMultiple: "50" });
  });

  it("口径：全网在库 + PO在途 + 近3月日均 → 可销天数与建议量（MOQ/倍数取整）", async () => {
    const res = await getReplenishSuggestions({ coverDaysTarget: 45, minCoverAlert: 30 }, db);
    expect(res.total).toBe(3); // 仅成品；原料不进报表
    expect(res.rows.map((r) => r.code)).toEqual(["CP00001", "CP00002", "CP00003"]); // daysCover 升序，无动销殿后
    expect(res.meta.months3).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(res.meta.snapDate).toBe("2026-07-10");
    expect(res.meta.suggestCount).toBe(1);

    const r1 = res.rows[0];
    expect(r1.onHand).toBe(150); // 100 实时 + 50 最新快照（不含旧快照 40）
    expect(r1.inTransit).toBe(15); // 2×10−5；draft 不计；超收行下限 0
    expect(r1.daily).toBe(10); // 910/91
    expect(r1.daysCover).toBe(16.5); // (150+15)/10
    /* E2-05 计划引擎 v2（time-phased）：建议量不再是「日均×覆盖天数 − 在库 − 在途」单桶乘法。
       逐日推演：期初 165（150+15 在途），日耗 10，安全库存 70（无生产周期→7天兜底×10）；
       第 9 天水位跌破安全线 → 补至目标水位（安全 70 + 目标 45 天×10 = 520）需 455；
       施加 MOQ 300 / 倍数 50 → 500。
       与旧口径差异：旧法 285 补后「从今天算」才 45 天，货到时已消耗大半且完全无安全库存。 */
    expect(r1.suggestQty).toBe("500.0000");
    expect(r1.safetyQty).toBe(70);
    expect(r1.safetyMethod).toBe("fallback"); // 夹具无 sku_params 交期 → 诚实降级
    expect(r1.shortageDate).not.toBeNull();
    expect(r1.daysToShortage).toBe(8);
    expect(r1.planExplain.length).toBeGreaterThan(2); // 可解释链

    const r2 = res.rows[1];
    expect(r2.onHand).toBe(5000);
    expect(r2.daysCover).toBe(500);
    expect(r2.suggestQty).toBeNull(); // 未触发预警

    const r3 = res.rows[2];
    expect(r3.daily).toBe(0);
    expect(r3.daysCover).toBeNull(); // 无动销不给建议（避免 0 除）
    expect(r3.suggestQty).toBeNull();
  });

  it("参数联动：目标覆盖天数放大建议量；阈值收紧后不再触发", async () => {
    const big = await getReplenishSuggestions({ coverDaysTarget: 90, minCoverAlert: 30 }, db);
    // 目标覆盖 90 天：补至 安全70 + 90×10 = 970，短缺期水位 65 → 需 905 → 倍数 50 → 950
    expect(big.rows[0].suggestQty).toBe("950.0000");

    /* 触发口径同步升级为「再订货点」：短缺是否落在行动窗口内（有生产周期用生产周期，
       否则用预警阈值）。夹具无生产周期 → 窗口=minCoverAlert。
       窗口 10 天 > 短缺 8 天 → 仍触发（此前按 cover 16.5≥10 判不触发——旧法忽略了安全库存）。 */
    const tight = await getReplenishSuggestions({ coverDaysTarget: 45, minCoverAlert: 10 }, db);
    expect(tight.rows[0].suggestQty).not.toBeNull();

    // 窗口收到 5 天 < 短缺 8 天 → 生产周期内来得及补，不建议下单
    const veryTight = await getReplenishSuggestions({ coverDaysTarget: 45, minCoverAlert: 5 }, db);
    expect(veryTight.rows[0].suggestQty).toBeNull();
    expect(veryTight.meta.suggestCount).toBe(0);
  });

  it("搜索与分页", async () => {
    const q = await getReplenishSuggestions({ q: "无动销" }, db);
    expect(q.total).toBe(1);
    expect(q.rows[0].code).toBe("CP00003");

    const p = await getReplenishSuggestions({ page: 2, pageSize: 2 }, db);
    expect(p.total).toBe(3);
    expect(p.rows.map((r) => r.code)).toEqual(["CP00003"]);
  });

  it("排序：全量排序后分页，数值升降序正确且空值始终置底", async () => {
    const highestStock = await getReplenishSuggestions(
      { sortBy: "onHand", sortOrder: "descend", page: 1, pageSize: 1 },
      db,
    );
    expect(highestStock.rows.map((r) => r.code)).toEqual(["CP00002"]);

    const coverDesc = await getReplenishSuggestions(
      { sortBy: "daysCover", sortOrder: "descend" },
      db,
    );
    expect(coverDesc.rows.map((r) => r.code)).toEqual(["CP00002", "CP00001", "CP00003"]);

    expect(normalizeReplenishSort("not-a-column", "sideways")).toEqual({
      sortBy: "coverFull",
      sortOrder: "ascend",
    });
  });

  it("生成 BH 草稿：复用 createBh，一张草稿多行，双审计留痕", async () => {
    const res = await createReplenishDraft(
      pmcUser,
      { items: [{ skuId: cp1, qty: "300" }, { skuId: cp2, qty: "100" }], remark: "R11 补货测试" },
      db,
    );
    expect(res.docNo).toMatch(/^BH/);

    const [doc] = await db.select().from(bhDocs).where(eq(bhDocs.id, res.id));
    expect(doc.status).toBe("draft"); // 只生成草稿，提交/审批走正常流（R13）
    expect(doc.createdBy).toBe(pmcUser.id);
    expect(doc.remark).toBe("R11 补货测试");

    const lines = await db.select().from(bhLines).where(eq(bhLines.bhId, res.id)).orderBy(bhLines.id);
    expect(lines.map((l) => [l.skuId, l.qty])).toEqual([
      [cp1, "300.0000"],
      [cp2, "100.0000"],
    ]);

    const audits = await db.select().from(auditLogs);
    expect(audits.some((a) => a.entity === "bh" && a.entityId === res.id && a.action === "create")).toBe(true);
    expect(
      audits.some((a) => a.entity === "replenish" && a.entityId === res.id && a.action === "draft_bh" && a.userId === pmcUser.id),
    ).toBe(true);
  });

  it("权限与校验：非 pmc/admin 403；空 items 拒绝", async () => {
    await expect(
      createReplenishDraft(whUser, { items: [{ skuId: cp1, qty: "10" }] }, db),
    ).rejects.toMatchObject({ status: 403 });
    await expect(createReplenishDraft(pmcUser, { items: [] }, db)).rejects.toThrow();
    await expect(
      createReplenishDraft(pmcUser, { items: [{ skuId: cp1, qty: "0" }] }, db),
    ).rejects.toThrow();
  });
});
