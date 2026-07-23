import { eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  approvalConfigs, auditLogs, poDocs, poLines, skus, spus, suppliers, users, warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { getBalance } from "@/server/posting";
import { approveCt, createCt, getCt, listCts, submitCt } from "@/server/modules/matflow/ct";
import { approveSh, confirmInbound, createQc, createSh, getSh, submitSh } from "@/server/modules/matflow/sh";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * W4 采购收货（SH po 源）+ 采购退货 CT：
 * sh_purchase_in 仅合格数入库 + po_line.receivedQty 累加（基础单位）、
 * 全收自动完成 PO、ct_return 库存− + 已收数回冲、退货量≤已收数守卫。
 */
describe("物料流转 W4：SH 收货（po 源）+ CT 采购退货", () => {
  let db: TestDb;
  let whCreator: SessionUser;
  let whApprover: SessionUser;
  let admin: SessionUser;

  let yl = 0; // 原料：PO 4 袋×25 → 基础 100
  let bc = 0; // 包材：PO 2 箱×1000 → 基础 2000
  let cp = 0; // 不在 PO 上的 SKU
  let whId = 0; // 收货仓
  let po1 = 0;
  let poLineYl = 0;
  let poLineBc = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mkUser = async (name: string, roles: string[], isApprover: boolean): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover }).returning();
      return { id: u.id, name: u.name, roles, isApprover };
    };
    whCreator = await mkUser("仓管制单", ["warehouse"], false);
    whApprover = await mkUser("仓管审批", ["warehouse"], true);
    admin = await mkUser("管理员", ["admin"], true);

    await db.insert(approvalConfigs).values([
      { docType: "sh", approverRole: "warehouse" },
      { docType: "ct", approverRole: "warehouse" },
    ]);

    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
    const mkSku = async (code: string, name: string, skuType: "finished" | "raw" | "packaging", baseUom: string) => {
      const [s] = await db.insert(skus).values({ code, name, spuId: spu.id, skuType, baseUom }).returning();
      return s.id;
    };
    yl = await mkSku("YL00001", "原料A", "raw", "kg");
    bc = await mkSku("BC00001", "包材A", "packaging", "个");
    cp = await mkSku("CP00001", "成品A", "finished", "盒");

    const [supA] = await db
      .insert(suppliers)
      .values({ code: "SUP001", name: "物料供应商A", kinds: ["raw", "packaging"], status: "qualified" })
      .returning();

    const [wh] = await db
      .insert(warehouses)
      .values({ code: "WH-YL", name: "原料仓", kind: "raw", accountingMode: "realtime" })
      .returning();
    whId = wh.id;

    // 已确认执行中的 PO：yl 4袋×25、bc 2箱×1000
    const [po] = await db
      .insert(poDocs)
      .values({ docNo: "PO-T-0001", status: "in_progress", supplierId: supA.id, createdBy: admin.id })
      .returning();
    po1 = po.id;
    const insLines = await db
      .insert(poLines)
      .values([
        { poId: po1, skuId: yl, lineType: "raw", purchaseUom: "袋", uomFactor: "25", qty: "4", price: "3000.00" },
        { poId: po1, skuId: bc, lineType: "packaging", purchaseUom: "箱", uomFactor: "1000", qty: "2", price: "500.00" },
      ])
      .returning();
    poLineYl = insLines[0].id;
    poLineBc = insLines[1].id;
  });

  it("1) po 源收货：sku 必须在 PO 行上；分次收货只更新已收、不整单完成", async () => {
    await expect(
      createSh(whCreator, {
        sourceType: "po", sourceId: po1, warehouseId: whId,
        lines: [{ skuId: cp, actualQty: "10" }],
      }, db),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("不在该 PO 行上") });

    // 第一批：bc 全量 2000（yl 未收 → PO 不完成）
    const sh = await createSh(whCreator, {
      sourceType: "po", sourceId: po1, warehouseId: whId,
      lines: [{ skuId: bc, actualQty: "2000" }],
    }, db);
    const pending = await submitSh(whCreator, sh.id, 1, db);
    await approveSh(whApprover, sh.id, { action: "approve", version: pending.version }, db);

    const detail = await getSh(sh.id, db);
    await createQc(whApprover, {
      shId: sh.id,
      lines: [{ shLineId: detail.lines[0].id, passQty: "1950", failQty: "50", concessionQty: "0", failHandling: "scrap" }],
    }, db);
    const r = await confirmInbound(whCreator, sh.id, db);
    expect(r.status).toBe("completed");

    // 仅合格数入库 + 已收数累加（基础单位）
    expect(await getBalance(db, bc, whId)).toBe("1950.0000");
    const [plBc] = await db.select().from(poLines).where(eq(poLines.id, poLineBc));
    expect(plBc.receivedQty).toBe("1950.0000");
    const [plYl] = await db.select().from(poLines).where(eq(poLines.id, poLineYl));
    expect(plYl.receivedQty).toBe("0.0000");

    // 未全收：PO 仍执行中
    const [po] = await db.select().from(poDocs).where(eq(poDocs.id, po1));
    expect(po.status).toBe("in_progress");
  });

  it("2) 全收自动完成 PO：全部行 receivedQty ≥ qty×uomFactor", async () => {
    // 第二批：bc 补 50（凑满 2000）+ yl 全量 100
    const sh = await createSh(whCreator, {
      sourceType: "po", sourceId: po1, warehouseId: whId,
      lines: [
        { skuId: bc, actualQty: "50" },
        { skuId: yl, actualQty: "100" },
      ],
    }, db);
    const pending = await submitSh(whCreator, sh.id, 1, db);
    await approveSh(whApprover, sh.id, { action: "approve", version: pending.version }, db);
    const detail = await getSh(sh.id, db);
    await createQc(whApprover, {
      shId: sh.id,
      lines: [
        { shLineId: detail.lines[0].id, passQty: "50", failQty: "0", concessionQty: "0" },
        { shLineId: detail.lines[1].id, passQty: "100", failQty: "0", concessionQty: "0" },
      ],
    }, db);
    await confirmInbound(whCreator, sh.id, db);

    expect(await getBalance(db, bc, whId)).toBe("2000.0000");
    expect(await getBalance(db, yl, whId)).toBe("100.0000");
    const [plBc] = await db.select().from(poLines).where(eq(poLines.id, poLineBc));
    const [plYl] = await db.select().from(poLines).where(eq(poLines.id, poLineYl));
    expect(plBc.receivedQty).toBe("2000.0000");
    expect(plYl.receivedQty).toBe("100.0000");

    const [po] = await db.select().from(poDocs).where(eq(poDocs.id, po1));
    expect(po.status).toBe("completed"); // 全收自动完成
  });

  it("3) CT 退货：库存− + 已收数回冲；退超已收 409；行须属于该 PO", async () => {
    // 退超已收：bc 已收 2000，退 5000 → 建单即 409
    await expect(
      createCt(whCreator, {
        poId: po1, warehouseId: whId,
        lines: [{ poLineId: poLineBc, skuId: bc, qty: "5000" }],
      }, db),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("退货量超过已收数") });

    // SKU 与 PO 行不符
    await expect(
      createCt(whCreator, {
        poId: po1, warehouseId: whId,
        lines: [{ poLineId: poLineBc, skuId: yl, qty: "1" }],
      }, db),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("SKU 与 PO 行不符") });

    const ct = await createCt(whCreator, {
      poId: po1, warehouseId: whId,
      lines: [{ poLineId: poLineBc, skuId: bc, qty: "300", reason: "外箱破损" }],
    }, db);
    expect(ct.docNo.startsWith("CT-")).toBe(true);
    const pending = await submitCt(whCreator, ct.id, 1, db);
    const r = await approveCt(whApprover, ct.id, { action: "approve", version: pending.version }, db);
    expect(r).toMatchObject({ status: "completed", idempotent: false });

    expect(await getBalance(db, bc, whId)).toBe("1700.0000");
    const [plBc] = await db.select().from(poLines).where(eq(poLines.id, poLineBc));
    expect(plBc.receivedQty).toBe("1700.0000"); // 已收数回冲

    const detail = await getCt(ct.id, db);
    expect(detail.poDocNo).toBe("PO-T-0001");
    expect(detail.lines[0]).toMatchObject({ poLineId: poLineBc, qty: "300.0000", reason: "外箱破损" });
    expect((await listCts("", { poId: po1, page: 1, pageSize: 10 }, db)).total).toBe(1);
  });

  it("4) CT 审批时点兜底：他单先回冲后本单退超 → 409 且全量回滚", async () => {
    // 现 bc 已收 1700：两张各退 1000 的单，第一张过，第二张审批时 409
    const ctA = await createCt(whCreator, {
      poId: po1, warehouseId: whId,
      lines: [{ poLineId: poLineBc, skuId: bc, qty: "1000" }],
    }, db);
    const ctB = await createCt(whCreator, {
      poId: po1, warehouseId: whId,
      lines: [{ poLineId: poLineBc, skuId: bc, qty: "1000" }],
    }, db);
    const pA = await submitCt(whCreator, ctA.id, 1, db);
    await approveCt(whApprover, ctA.id, { action: "approve", version: pA.version }, db);
    const pB = await submitCt(whCreator, ctB.id, 1, db);
    await expect(
      approveCt(whApprover, ctB.id, { action: "approve", version: pB.version }, db),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("退货量超过已收数") });

    expect(await getBalance(db, bc, whId)).toBe("700.0000");
    const [plBc] = await db.select().from(poLines).where(eq(poLines.id, poLineBc));
    expect(plBc.receivedQty).toBe("700.0000");
  });

  it("5) SoD 与审计：制单人不可审批 CT；sh/ct/po 写动作留痕", async () => {
    const ct = await createCt(whApprover, {
      poId: po1, warehouseId: whId,
      lines: [{ poLineId: poLineBc, skuId: bc, qty: "10" }],
    }, db);
    const p = await submitCt(whApprover, ct.id, 1, db);
    await expect(
      approveCt(whApprover, ct.id, { action: "approve", version: p.version }, db),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining("SELF_APPROVAL") });

    const rows = await db
      .select({ entity: auditLogs.entity, action: auditLogs.action })
      .from(auditLogs)
      .where(inArray(auditLogs.entity, ["sh", "qc", "ct", "po"]));
    const seen = new Set(rows.map((r) => `${r.entity}:${r.action}`));
    for (const key of [
      "sh:create", "sh:submit", "sh:approve", "sh:inbound", "qc:create",
      "ct:create", "ct:submit", "ct:approve", "ct:post_and_complete",
      "po:complete", // 全收自动完成（via sh_inbound）
    ]) {
      expect(seen, `缺少审计: ${key}`).toContain(key);
    }
  });
});
