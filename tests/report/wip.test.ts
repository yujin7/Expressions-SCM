import { beforeAll, describe, expect, it } from "vitest";
import {
  boms, flDocs, flLines, jgDocs, qcLines, qcRecords, shDocs, shLines,
  skus, spus, suppliers, users, warehouses, woDocs,
} from "@/db/schema";
import { listWip } from "@/server/modules/report/wip";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * W5 委外在制看板：聚合口径与 matflow/sh.ts 一致——
 * receivedGood/Concession=已入库(SH completed)QC 合格/让步（normal+rework 行，spare 不计）；
 * pendingQty=JG数量−Σ已生效 SH 正常行实收（rework 冲抵不占累计、spare 不占 JG 数量）。
 */
describe("委外在制看板 listWip：收货进度聚合 + 逾期 + 过滤", () => {
  let db: TestDb;
  let adminId = 0;
  let cp = 0;
  let yl = 0;
  let bomId = 0;
  let whFin = 0;
  let supA = 0; // 有在制 JG 的加工厂
  let supB = 0; // 逾期 JG 的加工厂
  let jgMain = 0;
  let jgOverdue = 0;
  let jgDone = 0;

  const PAST = "2026-01-01";
  const FUTURE = "2099-12-31";
  let seq = 0;

  async function mkJg(opts: {
    supplierId: number;
    qty: string;
    status: "pending" | "approved" | "in_progress" | "completed" | "closed" | "draft" | "void";
    dueDate?: string | null;
  }) {
    seq += 1;
    const [wo] = await db
      .insert(woDocs)
      .values({
        docNo: `WO-W5-${seq}`, status: "completed", productSkuId: cp, qty: opts.qty,
        supplierId: opts.supplierId, feeRatePlan: "2.00", bomId, createdBy: adminId,
      })
      .returning();
    const [jg] = await db
      .insert(jgDocs)
      .values({
        docNo: `JG-W5-${seq}`, status: opts.status, woId: wo.id, supplierId: opts.supplierId,
        productSkuId: cp, qty: opts.qty, dueDate: opts.dueDate ?? null,
        feeRateCurrent: "2.00", createdBy: adminId,
      })
      .returning();
    return jg.id;
  }

  async function mkSh(opts: {
    jgId: number;
    status: "draft" | "pending" | "approved" | "completed";
    lines: { lineType: "normal" | "rework" | "spare"; actualQty: string; passQty?: string; concessionQty?: string }[];
  }) {
    seq += 1;
    const [sh] = await db
      .insert(shDocs)
      .values({
        docNo: `SH-W5-${seq}`, status: opts.status, sourceType: "jg", sourceId: opts.jgId,
        warehouseId: whFin, createdBy: adminId,
      })
      .returning();
    const inserted = await db
      .insert(shLines)
      .values(opts.lines.map((l) => ({ shId: sh.id, skuId: cp, lineType: l.lineType, actualQty: l.actualQty })))
      .returning();
    const graded = opts.lines.some((l) => l.passQty != null || l.concessionQty != null);
    if (graded) {
      const [qc] = await db
        .insert(qcRecords)
        .values({ shId: sh.id, conclusion: "检验", createdBy: adminId })
        .returning();
      await db.insert(qcLines).values(
        inserted.map((row, i) => ({
          qcId: qc.id,
          shLineId: row.id,
          passQty: opts.lines[i].passQty ?? "0",
          concessionQty: opts.lines[i].concessionQty ?? "0",
        })),
      );
    }
    return sh.id;
  }

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [admin] = await db.insert(users).values({ name: "管理员", roles: ["admin"], isApprover: true }).returning();
    adminId = admin.id;

    const [spu] = await db.insert(spus).values({ code: "P0W5", nameCn: "看板测试产品" }).returning();
    const [s1] = await db
      .insert(skus)
      .values({ code: "CPW5001", name: "看板成品", spuId: spu.id, skuType: "finished", baseUom: "个" })
      .returning();
    cp = s1.id;
    const [s2] = await db
      .insert(skus)
      .values({ code: "YLW5001", name: "看板原料", spuId: spu.id, skuType: "raw", baseUom: "kg" })
      .returning();
    yl = s2.id;

    const [a] = await db
      .insert(suppliers)
      .values({ code: "SUPW5A", name: "看板加工厂A", kinds: ["processor"], status: "qualified" })
      .returning();
    supA = a.id;
    const [b] = await db
      .insert(suppliers)
      .values({ code: "SUPW5B", name: "看板加工厂B", kinds: ["processor"], status: "qualified" })
      .returning();
    supB = b.id;

    const [whF] = await db.insert(warehouses).values({ code: "WH-W5F", name: "成品仓W5", kind: "finished" }).returning();
    whFin = whF.id;
    const [whR] = await db.insert(warehouses).values({ code: "WH-W5R", name: "原料仓W5", kind: "raw" }).returning();
    const [whX] = await db
      .insert(warehouses)
      .values({ code: "WH-W5X", name: "委外仓W5", kind: "outsource", supplierId: supA })
      .returning();

    const [bom] = await db
      .insert(boms)
      .values({ productSkuId: cp, versionNo: "V1", status: "active", effectiveDate: "2026-01-01" })
      .returning();
    bomId = bom.id;

    // ---- 主场景 JG：qty=1000，多张 SH 混行型/混状态 ----
    jgMain = await mkJg({ supplierId: supA, qty: "1000", status: "in_progress", dueDate: FUTURE });
    // SH1 completed：normal 300（合格 280 + 让步 15，5 待判不合格）
    await mkSh({
      jgId: jgMain, status: "completed",
      lines: [{ lineType: "normal", actualQty: "300", passQty: "280", concessionQty: "15" }],
    });
    // SH2 completed：rework 20（合格 20，冲抵原不合格——计合格数、不占累计）+ spare 10（不占任何口径）
    await mkSh({
      jgId: jgMain, status: "completed",
      lines: [
        { lineType: "rework", actualQty: "20", passQty: "20" },
        { lineType: "spare", actualQty: "10" },
      ],
    });
    // SH3 approved（已生效未入库）：normal 200 已检 190——占累计但不计已收合格（未入库）
    await mkSh({
      jgId: jgMain, status: "approved",
      lines: [{ lineType: "normal", actualQty: "200", passQty: "190" }],
    });
    // SH4 draft：normal 999——不占任何口径
    await mkSh({ jgId: jgMain, status: "draft", lines: [{ lineType: "normal", actualQty: "999" }] });

    // 发料 2 行（approved FL）+ 1 张 draft FL（不计）
    const [fl] = await db
      .insert(flDocs)
      .values({
        docNo: "FL-W5-1", status: "approved", jgId: jgMain,
        fromWarehouseId: whR.id, toWarehouseId: whX.id, createdBy: adminId,
      })
      .returning();
    await db.insert(flLines).values([
      { flId: fl.id, skuId: yl, qty: "55" },
      { flId: fl.id, skuId: cp, qty: "1" },
    ]);
    const [flDraft] = await db
      .insert(flDocs)
      .values({
        docNo: "FL-W5-2", status: "draft", jgId: jgMain,
        fromWarehouseId: whR.id, toWarehouseId: whX.id, createdBy: adminId,
      })
      .returning();
    await db.insert(flLines).values([{ flId: flDraft.id, skuId: yl, qty: "5" }]);

    // ---- 逾期 JG（supB，到期日已过，执行中）----
    jgOverdue = await mkJg({ supplierId: supB, qty: "500", status: "in_progress", dueDate: PAST });

    // ---- 已完成 JG（到期日已过但 completed → 不逾期，不计在制）----
    jgDone = await mkJg({ supplierId: supA, qty: "100", status: "completed", dueDate: PAST });
    await mkSh({
      jgId: jgDone, status: "completed",
      lines: [{ lineType: "normal", actualQty: "100", passQty: "100" }],
    });

    // ---- draft/void JG：不出表 ----
    await mkJg({ supplierId: supA, qty: "50", status: "draft" });
    await mkJg({ supplierId: supA, qty: "60", status: "void" });
  });

  it("1) 行集合：draft/void 排除；聚合口径与 sh.ts 一致（rework 计合格不占累计、spare 双不占、approved SH 占累计不计已收）", async () => {
    const { rows } = await listWip({}, db);
    expect(rows.map((r) => r.jgId).sort()).toEqual([jgMain, jgOverdue, jgDone].sort());

    const main = rows.find((r) => r.jgId === jgMain)!;
    expect(main.woNo).toMatch(/^WO-W5-/);
    expect(main.supplierName).toBe("看板加工厂A");
    expect(main.productSkuCode).toBe("CPW5001");
    expect(main.orderQty).toBe("1000.0000");
    // 已收合格 = completed SH 的 pass：280(normal) + 20(rework)；approved SH 的 190 不计
    expect(main.receivedGood).toBe("300.0000");
    expect(main.receivedConcession).toBe("15.0000");
    // 待收 = 1000 − 正常行累计(300 completed + 200 approved；rework/spare/draft 不占)
    expect(main.pendingQty).toBe("500.0000");
    expect(main.issuedMaterialLines).toBe(2); // draft FL 行不计
    expect(main.overdue).toBe(false);

    const done = rows.find((r) => r.jgId === jgDone)!;
    expect(done.pendingQty).toBe("0.0000");
    expect(done.overdue).toBe(false); // 已完成——过期不算逾期
  });

  it("2) 逾期与汇总卡：dueDate<今日 且 状态非 completed；汇总只计在制（非 completed/closed）", async () => {
    const { rows, summary } = await listWip({}, db);
    const overdueRow = rows.find((r) => r.jgId === jgOverdue)!;
    expect(overdueRow.overdue).toBe(true);
    expect(overdueRow.pendingQty).toBe("500.0000");

    expect(summary.wipCount).toBe(2); // jgMain + jgOverdue（jgDone completed 不计）
    expect(summary.overdueCount).toBe(1);
    expect(summary.pendingTotal).toBe("1000.0000"); // 500 + 500
  });

  it("3) 过滤：supplierId 与 仅逾期（汇总随筛选集合，不随裁行）", async () => {
    const bySup = await listWip({ supplierId: supB }, db);
    expect(bySup.rows).toHaveLength(1);
    expect(bySup.rows[0].jgId).toBe(jgOverdue);
    expect(bySup.summary.wipCount).toBe(1);

    const onlyOverdue = await listWip({ overdueOnly: true }, db);
    expect(onlyOverdue.rows.map((r) => r.jgId)).toEqual([jgOverdue]);
    // 汇总仍是全集口径（卡片数字不因"仅逾期"裁行而变）
    expect(onlyOverdue.summary.wipCount).toBe(2);
    expect(onlyOverdue.summary.pendingTotal).toBe("1000.0000");
  });

  it("4) 无金额字段泄漏（R9：本报表运营/仓管可见，故行内不得含任何价格键）", async () => {
    const { rows } = await listWip({}, db);
    const banned = ["feeRateCurrent", "feeRatePlan", "price", "feePayable", "settleAmount", "amount"];
    for (const row of rows) {
      for (const key of Object.keys(row)) expect(banned).not.toContain(key);
    }
  });
});
