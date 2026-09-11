/**
 * 盘点期 + 小样分组汇总（0727 会议行动项 #1）。
 *
 * 原文：「整理 7 月底盘点的小样库存数据，**单独标注小样分类**，提供给孙明，
 * 便于其清晰区分库存类别」。此前两头都缺：
 * - `pd_docs` 只有 `created_at`，按创建时间筛等于按**录入时间**筛——
 *   补录或次月才录的盘点会落到错误的期间；
 * - 盘点明细不带业务用途，导不出「带小样标注」的清单，更没有分组小计。
 */
import { describe, expect, it } from "vitest";
import { skus, spus, stockBalances, users, warehouses } from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { createCountTask, getCountTask, listCountTasks } from "@/server/modules/inventory/count";

async function setup() {
  const { db } = await createTestDb();
  const [user] = await db.insert(users).values({
    username: "pd_actor", name: "仓管", roles: ["warehouse"], isApprover: false,
  }).returning();
  const actor = { id: user.id, name: user.name, roles: user.roles, isApprover: false };
  const [wh] = await db.insert(warehouses).values({
    code: "WH-PD", name: "盘点测试仓", kind: "finished", accountingMode: "realtime", active: true,
  }).returning();
  const [spu] = await db.insert(spus).values({ code: "P33001", nameCn: "盘点测试品" }).returning();

  const mk = async (code: string, role: string, qty: string) => {
    const [row] = await db.insert(skus).values({
      code, name: `货品${code}`, spuId: spu.id, skuType: "finished", baseUom: "支", commercialRole: role,
    }).returning();
    await db.insert(stockBalances).values({
      skuId: row.id, warehouseId: wh.id, batchId: null, qty,
    });
    return row;
  };
  await mk("PD-SAMPLE-1", "sample", "10.0000");
  await mk("PD-SAMPLE-2", "sample", "5.0000");
  await mk("PD-RETAIL-1", "retail", "100.0000");
  await mk("PD-UNCL-1", "unclassified", "7.0000");
  return { db, actor, wh };
}

describe("盘点：盘点期与小样分组", () => {
  it("建单落盘点期；可按 YYYY-MM 取「7 月底盘点」这类期间", async () => {
    const { db, actor, wh } = await setup();
    await createCountTask(actor, { warehouseId: wh.id, mode: "full", bizDate: "2026-07-31" }, db);
    await createCountTask(actor, { warehouseId: wh.id, mode: "full", bizDate: "2026-08-03" }, db);

    const july = await listCountTasks("", { period: "2026-07", page: 1, pageSize: 50 }, db);
    expect(july.total).toBe(1);
    expect((july.rows as { bizDate: string }[])[0].bizDate).toBe("2026-07-31");

    const all = await listCountTasks("", { page: 1, pageSize: 50 }, db);
    expect(all.total).toBe(2);
  });

  it("不传盘点期时按今天归期，而不是留空", async () => {
    const { db, actor, wh } = await setup();
    const doc = await createCountTask(actor, { warehouseId: wh.id, mode: "full" }, db);
    const detail = await getCountTask(doc.id, db);
    expect(detail.bizDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("明细带业务用途，并给出小样/非小样分组小计", async () => {
    const { db, actor, wh } = await setup();
    const doc = await createCountTask(actor, { warehouseId: wh.id, mode: "full", bizDate: "2026-07-31" }, db);
    const detail = await getCountTask(doc.id, db);

    // 每行都要能看出是不是小样，否则导出的清单没法"单独标注"
    expect(detail.lines.every((l) => typeof l.commercialRole === "string")).toBe(true);

    const sample = detail.roleSummary.find((r) => r.group === "sample")!;
    const retail = detail.roleSummary.find((r) => r.group === "retail")!;
    expect(sample.lineCount).toBe(2);          // 两个小样
    expect(Number(sample.bookQty)).toBe(15);   // 10 + 5
    // 未分类保守计入正常销售——与全站口径一致，也正因如此存量必须先打标
    expect(retail.lineCount).toBe(2);          // retail + unclassified
    expect(Number(retail.bookQty)).toBe(107);  // 100 + 7
  });

  it("分组小计的差异 = 实盘 − 账面，用 decimal 累加不引入浮点误差", async () => {
    const { db, actor, wh } = await setup();
    const doc = await createCountTask(actor, { warehouseId: wh.id, mode: "full" }, db);
    const detail = await getCountTask(doc.id, db);
    // 刚建单时实盘=账面，差异必须是精确 0
    for (const g of detail.roleSummary) expect(Number(g.diffQty)).toBe(0);
  });
});

describe("盘点明细导出（交付给业务的那份清单）", () => {
  it("按盘点期导出，行带小样标注与差异", async () => {
    const { db, actor, wh } = await setup();
    await createCountTask(actor, { warehouseId: wh.id, mode: "full", bizDate: "2026-07-31" }, db);
    await createCountTask(actor, { warehouseId: wh.id, mode: "full", bizDate: "2026-08-03" }, db);

    const { listCountLinesForExport } = await import("@/server/modules/inventory/count");
    const july = await listCountLinesForExport({ period: "2026-07", limit: 5000 }, db);
    expect(july.total).toBe(4); // 只有 7 月那张单的 4 行
    const rows = july.rows as { bizDate: string; commercialRole: string; diffQty: string }[];
    expect(rows.every((r) => r.bizDate === "2026-07-31")).toBe(true);
    expect(rows.every((r) => typeof r.commercialRole === "string")).toBe(true);
    expect(rows.every((r) => Number(r.diffQty) === 0)).toBe(true); // 刚建单实盘=账面
  });

  it("可只导小样——这正是要交给孙明的那份", async () => {
    const { db, actor, wh } = await setup();
    await createCountTask(actor, { warehouseId: wh.id, mode: "full", bizDate: "2026-07-31" }, db);
    const { listCountLinesForExport } = await import("@/server/modules/inventory/count");
    const only = await listCountLinesForExport(
      { period: "2026-07", commercialRole: "sample", limit: 5000 }, db,
    );
    expect(only.total).toBe(2);
    const codes = (only.rows as { skuCode: string }[]).map((r) => r.skuCode).sort();
    expect(codes).toEqual(["PD-SAMPLE-1", "PD-SAMPLE-2"]);
  });

  it("total 与 rows 同口径——不能只裁当页却报全表", async () => {
    const { db, actor, wh } = await setup();
    await createCountTask(actor, { warehouseId: wh.id, mode: "full", bizDate: "2026-07-31" }, db);
    const { listCountLinesForExport } = await import("@/server/modules/inventory/count");
    const r = await listCountLinesForExport({ period: "2026-07", limit: 5000 }, db);
    expect(r.total).toBe((r.rows as unknown[]).length);
  });
});
