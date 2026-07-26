import { eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  approvalConfigs, auditLogs, boms, jgDocs, offsetPools, shDocs, skus, spus,
  stockLedger, suppliers, sysParams, users, warehouses, woDocs, woLines,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { getBalance } from "@/server/posting";
import {
  approveSh, confirmInbound, createQc, createSh, getSh, listShs, submitSh,
} from "@/server/modules/matflow/sh";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * W4 收货 SH（jg 源）+ QC + 入库确认：
 * 累计校验（分母=JG数量−已判不合格+容差，《02》§3）、rework/spare 不占累计、
 * QC 三分（合格/不合格/让步）、检验前不入库、
 * 过账 sh_outsource_in（成品仓+合格+让步；委外仓−qtyPer×(合格+让步+备品)）+
 * spare_in（零成本+对冲池）、二次入库 409。
 */
describe("物料流转 W4：SH 收货（jg 源）+ QC + 入库", () => {
  let db: TestDb;
  let whCreator: SessionUser;
  let whApprover: SessionUser;
  let admin: SessionUser;

  let cp = 0; // 成品
  let yl = 0; // 原料 qtyPer 0.05
  let bc = 0; // 包材 qtyPer 10
  let whFinId = 0; // 成品仓
  let whWxId = 0; // 委外仓
  let jg1 = 0; // JG 数量 1000，容差 5% → 50

  let sh1 = 0; // normal 400 + spare 5
  let sh1NormalLineId = 0;
  let sh1SpareLineId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mkUser = async (name: string, roles: string[], isApprover: boolean): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover }).returning();
      return { id: u.id, name: u.name, roles, isApprover };
    };
    whCreator = await mkUser("仓管制单", ["warehouse"], false);
    whApprover = await mkUser("仓管审批", ["warehouse"], true);
    admin = await mkUser("管理员", ["admin"], true);

    await db.insert(approvalConfigs).values([{ docType: "sh", approverRole: "warehouse" }]);
    await db.insert(sysParams).values({ scope: "global", key: "over_receive_tolerance_pct", value: "5" });

    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
    const mkSku = async (code: string, name: string, skuType: "finished" | "raw" | "packaging", baseUom: string) => {
      const [s] = await db.insert(skus).values({ code, name, spuId: spu.id, skuType, baseUom }).returning();
      return s.id;
    };
    cp = await mkSku("CP00001", "成品A", "finished", "盒");
    yl = await mkSku("YL00001", "原料A", "raw", "kg");
    bc = await mkSku("BC00001", "包材A", "packaging", "个");

    const [supProc] = await db
      .insert(suppliers)
      .values({ code: "SUP001", name: "加工厂C", kinds: ["processor"], status: "qualified" })
      .returning();

    const [whFin] = await db
      .insert(warehouses)
      .values({ code: "WH-CP", name: "成品仓", kind: "finished", accountingMode: "realtime" })
      .returning();
    whFinId = whFin.id;
    const [whWx] = await db
      .insert(warehouses)
      .values({ code: "WH-WX", name: "委外仓C", kind: "outsource", accountingMode: "realtime", supplierId: supProc.id })
      .returning();
    whWxId = whWx.id;

    const [bom] = await db
      .insert(boms)
      .values({ productSkuId: cp, versionNo: "V1", status: "active", effectiveDate: "2026-01-01" })
      .returning();
    const [wo] = await db
      .insert(woDocs)
      .values({
        docNo: "WO-T-0001", status: "approved", productSkuId: cp, qty: "1000",
        supplierId: supProc.id, feeRatePlan: "2.50", bomId: bom.id, createdBy: admin.id,
      })
      .returning();
    await db.insert(woLines).values([
      { woId: wo.id, materialSkuId: yl, qtyPer: "0.05", planLossRatePct: "2", grossReq: "51", suggestedQty: "51" },
      { woId: wo.id, materialSkuId: bc, qtyPer: "10", planLossRatePct: "5", grossReq: "10500", suggestedQty: "10500" },
    ]);
    const [jg] = await db
      .insert(jgDocs)
      .values({
        docNo: "JG-T-0001", status: "in_progress", woId: wo.id, supplierId: supProc.id,
        productSkuId: cp, qty: "1000", feeRateCurrent: "2.50", createdBy: admin.id,
      })
      .returning();
    jg1 = jg.id;
  });

  it("1) 建单校验：sku 必须=JG 成品；QC 前不可入库；未审批不可检验", async () => {
    await expect(
      createSh(whCreator, {
        sourceType: "jg", sourceId: jg1, warehouseId: whFinId,
        lines: [{ skuId: yl, actualQty: "10" }],
      }, db),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("加工成品") });

    const sh = await createSh(whCreator, {
      sourceType: "jg", sourceId: jg1, warehouseId: whFinId,
      lines: [
        { skuId: cp, lineType: "normal", expectedQty: "400", actualQty: "400", batchNo: "B2026-01" },
        { skuId: cp, lineType: "spare", actualQty: "5" },
      ],
    }, db);
    sh1 = sh.id;
    expect(sh.docNo.startsWith("SH-")).toBe(true);

    // 未审批：不可检验、不可入库
    await expect(
      createQc(whCreator, { shId: sh1, lines: [{ shLineId: 1, passQty: "1", failQty: "0", concessionQty: "0" }] }, db),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("须先审批") });
    await expect(confirmInbound(whCreator, sh1, db)).rejects.toMatchObject({
      status: 409, message: expect.stringContaining("须先审批"),
    });

    const pending = await submitSh(whCreator, sh1, 1, db);
    const r = await approveSh(whApprover, sh1, { action: "approve", version: pending.version }, db);
    expect(r).toMatchObject({ status: "approved", idempotent: false });

    // 审批后仍未过账（检验前不入库）
    expect(await getBalance(db, cp, whFinId)).toBe("0");

    // 审批后、检验前：入库仍被拒（收货必检）
    await expect(confirmInbound(whCreator, sh1, db)).rejects.toMatchObject({
      status: 409, message: expect.stringContaining("收货必检"),
    });

    const detail = await getSh(sh1, db);
    expect(detail.inbound).toBe(false);
    expect(detail.qc).toBeNull();
    expect(detail.sourceDocNo).toBe("JG-T-0001");
    sh1NormalLineId = detail.lines[0].id;
    sh1SpareLineId = detail.lines[1].id;
  });

  it("2) QC：判定必须完整覆盖实收和全部收货行；一单一检；行须属于本单", async () => {
    await expect(
      createQc(whApprover, {
        shId: sh1,
        lines: [{ shLineId: sh1NormalLineId, passQty: "350", failQty: "30", concessionQty: "30" }], // 410 > 400
      }, db),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("必须完整覆盖实收") });

    await expect(
      createQc(whApprover, {
        shId: sh1,
        lines: [{ shLineId: 99999, passQty: "1", failQty: "0", concessionQty: "0" }],
      }, db),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("不属于该收货单") });

    await expect(
      createQc(whApprover, {
        shId: sh1,
        lines: [
          { shLineId: sh1NormalLineId, passQty: "350", failQty: "30", concessionQty: "20", failHandling: "rework" },
        ],
      }, db),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("覆盖全部收货行") });

    const qc = await createQc(whApprover, {
      shId: sh1,
      conclusion: "抽检合格率 87.5%",
      lines: [
        { shLineId: sh1NormalLineId, passQty: "350", failQty: "30", concessionQty: "20", failHandling: "rework" },
        { shLineId: sh1SpareLineId, passQty: "5", failQty: "0", concessionQty: "0" },
      ],
    }, db);
    expect(qc.lines).toHaveLength(2);

    // 一单一检
    await expect(
      createQc(whApprover, {
        shId: sh1,
        lines: [{ shLineId: sh1NormalLineId, passQty: "1", failQty: "0", concessionQty: "0" }],
      }, db),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("一单一检") });
  });

  it("3) 入库确认：成品仓+(合格+让步)+备品；委外仓−qtyPer×(合格+让步+备品)；对冲池零成本；二次入库 409", async () => {
    const r = await confirmInbound(whCreator, sh1, db);
    expect(r.status).toBe("completed");

    // 成品仓：正常行 350+20=370，备品行 +5（零成本另一事件）→ 375
    expect(await getBalance(db, cp, whFinId)).toBe("375.0000");
    // 委外仓净标准用量扣减：Q=370+5=375 → yl −0.05×375=−18.75；bc −10×375=−3750（委外仓可负=垫料）
    expect(await getBalance(db, yl, whWxId)).toBe("-18.7500");
    expect(await getBalance(db, bc, whWxId)).toBe("-3750.0000");

    // 两个独立过账事件：sh_outsource_in（成品+370 / 材料−）与 spare_in（+5）
    const inLedger = await db.select().from(stockLedger).where(eq(stockLedger.sourceDocType, "sh_outsource_in"));
    expect(inLedger).toHaveLength(3); // 成品 1 腿 + 材料 2 腿
    const spareLedger = await db.select().from(stockLedger).where(eq(stockLedger.sourceDocType, "spare_in"));
    expect(spareLedger).toHaveLength(1);
    expect(spareLedger[0]).toMatchObject({ skuId: cp, warehouseId: whFinId, qtyDelta: "5.0000" });

    // 对冲池：kind=spare，amount=0（零成本）
    const pools = await db.select().from(offsetPools).where(eq(offsetPools.kind, "spare"));
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({ skuId: cp, qty: "5.0000", amount: "0.00", sourceDocType: "sh", sourceDocId: sh1 });

    // SH 完成 + inbound 标记
    const detail = await getSh(sh1, db);
    expect(detail.status).toBe("completed");
    expect(detail.inbound).toBe(true);
    expect(detail.qc).not.toBeNull();
    expect(detail.qc!.lines[0]).toMatchObject({ passQty: "350.0000", failQty: "30.0000", concessionQty: "20.0000" });

    // 二次入库 → 409（余额不变）
    await expect(confirmInbound(whCreator, sh1, db)).rejects.toMatchObject({
      status: 409, message: expect.stringContaining("不可重复入库"),
    });
    expect(await getBalance(db, cp, whFinId)).toBe("375.0000");
  });

  it("4) 累计校验：分次累加；超上限(JG数量−已判不合格+容差) 409；rework/spare 不占累计", async () => {
    // sh1 正常行 400 已生效，已判不合格 30，容差 5%→50：上限 = 1000−30+50 = 1020
    // sh2 normal 600：400+600=1000 ≤ 1020 → 通过
    const sh2 = await createSh(whCreator, {
      sourceType: "jg", sourceId: jg1, warehouseId: whFinId,
      lines: [{ skuId: cp, lineType: "normal", actualQty: "600" }],
    }, db);
    const p2 = await submitSh(whCreator, sh2.id, 1, db);
    await approveSh(whApprover, sh2.id, { action: "approve", version: p2.version }, db);

    // sh3 normal 50：1000+50=1050 > 1020 → 建单即 409
    await expect(
      createSh(whCreator, {
        sourceType: "jg", sourceId: jg1, warehouseId: whFinId,
        lines: [{ skuId: cp, lineType: "normal", actualQty: "50" }],
      }, db),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("累计收货超限") });

    // rework（返工重交，冲抵前不合格）与 spare（备品）不占累计 → 放行
    const shRw = await createSh(whCreator, {
      sourceType: "jg", sourceId: jg1, warehouseId: whFinId,
      lines: [
        { skuId: cp, lineType: "rework", actualQty: "30" },
        { skuId: cp, lineType: "spare", actualQty: "3" },
      ],
    }, db);
    expect(shRw.status).toBe("draft");

    // 审批时点兜底重查：两张并行待审单不能双双越限
    // sh4 normal 20（建单时 1000+20=1020 恰好达上限，放行）
    const sh4 = await createSh(whCreator, {
      sourceType: "jg", sourceId: jg1, warehouseId: whFinId,
      lines: [{ skuId: cp, lineType: "normal", actualQty: "20" }],
    }, db);
    const sh5 = await createSh(whCreator, {
      sourceType: "jg", sourceId: jg1, warehouseId: whFinId,
      lines: [{ skuId: cp, lineType: "normal", actualQty: "20" }],
    }, db);
    const p4 = await submitSh(whCreator, sh4.id, 1, db);
    await approveSh(whApprover, sh4.id, { action: "approve", version: p4.version }, db); // 累计 1020=上限
    const p5 = await submitSh(whCreator, sh5.id, 1, db);
    await expect(
      approveSh(whApprover, sh5.id, { action: "approve", version: p5.version }, db),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("累计收货超限") });
    const [doc5] = await db.select().from(shDocs).where(eq(shDocs.id, sh5.id));
    expect(doc5.status).toBe("pending"); // 审批整体回滚

    const list = await listShs("", { sourceType: "jg", sourceId: jg1, page: 1, pageSize: 20 }, db);
    expect(list.total).toBe(5); // sh1/sh2/shRw/sh4/sh5
  });

  it("5) SoD 与审计：制单人不可审批；sh/qc 写动作全留痕", async () => {
    const sh = await createSh(whApprover, {
      sourceType: "jg", sourceId: jg1, warehouseId: whFinId,
      lines: [{ skuId: cp, lineType: "spare", actualQty: "1" }],
    }, db);
    const p = await submitSh(whApprover, sh.id, 1, db);
    await expect(
      approveSh(whApprover, sh.id, { action: "approve", version: p.version }, db),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining("SELF_APPROVAL") });

    const rows = await db
      .select({ entity: auditLogs.entity, action: auditLogs.action })
      .from(auditLogs)
      .where(inArray(auditLogs.entity, ["sh", "qc", "offset_pool"]));
    const seen = new Set(rows.map((r) => `${r.entity}:${r.action}`));
    for (const key of [
      "sh:create", "sh:submit", "sh:approve", "sh:inbound",
      "qc:create", "offset_pool:spare_in",
    ]) {
      expect(seen, `缺少审计: ${key}`).toContain(key);
    }
  });
});
