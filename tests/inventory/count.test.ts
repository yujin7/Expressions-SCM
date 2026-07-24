import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  approvalConfigs, approvals, pdDocs, pdLines, skus, spus, stockDocLines, stockDocs, stockLedger, users, warehouses,
} from "@/db/schema";
import { dCmp } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { getBalance } from "@/server/posting/post";
import { approveStockDoc, createStockDoc, submitStockDoc } from "@/server/modules/inventory/stock-doc";
import {
  approveCountTask, createCountTask, getCountTask, listCountTasks, submitCountTask, updateCounts,
} from "@/server/modules/inventory/count";
import { createTestDb, type TestDb } from "../helpers/db";

describe("盘点任务 PD：抽盘（循环抽点）/全盘 → 财务审批 → 盘盈亏调整过账", () => {
  let db: TestDb;
  let creator: SessionUser; // 仓库制单（也是审批人标志——验证 SoD）
  let whApprover: SessionUser; // 仓库审批人（可审 stock_doc，不可审 count）
  let finApprover: SessionUser; // 财务审批人（count 审批域）
  let admin: SessionUser;
  let wh1: number; // 实时仓
  let whSnap: number; // 快照仓
  let spuId: number;

  const mkUser = async (name: string, roles: string[], isApprover: boolean): Promise<SessionUser> => {
    const [u] = await db.insert(users).values({ name, roles, isApprover }).returning();
    return { id: u.id, name: u.name, roles, isApprover };
  };

  beforeAll(async () => {
    ({ db } = await createTestDb());
    creator = await mkUser("仓库制单员", ["warehouse"], true);
    whApprover = await mkUser("仓库审批人", ["warehouse"], true);
    finApprover = await mkUser("财务审批人", ["finance"], true);
    admin = await mkUser("管理员", ["admin"], false);
    // 生产语义（seed）：期初/盘点=财务审批域；库存单=仓管
    await db.insert(approvalConfigs).values([
      { docType: "stock_doc", approverRole: "warehouse" },
      { docType: "opening", approverRole: "finance" },
      { docType: "count", approverRole: "finance" },
    ]);
    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "盘点测试品" }).returning();
    spuId = spu.id;
    const [w1] = await db.insert(warehouses).values({ code: "WH-PD-1", name: "盘点一仓", kind: "raw" }).returning();
    const [w2] = await db
      .insert(warehouses)
      .values({ code: "WH-PD-SNAP", name: "盘点快照仓", kind: "snapshot", accountingMode: "snapshot" })
      .returning();
    wh1 = w1.id;
    whSnap = w2.id;
  });

  let skuSeq = 0;
  async function makeSku(): Promise<number> {
    skuSeq += 1;
    const [s] = await db
      .insert(skus)
      .values({ code: `PD${String(skuSeq).padStart(5, "0")}`, name: `盘点物料${skuSeq}`, spuId, baseUom: "个", skuType: "raw" })
      .returning();
    return s.id;
  }

  /** 期初建账铺底库存（opening=财务审批域） */
  async function seedBalance(skuId: number, qty: string): Promise<void> {
    const doc = await createStockDoc(creator, { subtype: "opening", warehouseId: wh1, lines: [{ skuId, qty }] }, db);
    const pending = await submitStockDoc(creator, doc.id, doc.version, db);
    const r = await approveStockDoc(finApprover, pending.id, { action: "approve", version: pending.version }, db);
    expect(r.status).toBe("completed");
  }

  it("1) 全流程：抽盘创建（账面快照+预填）→ 录实盘（盈/亏/平）→ 提交 → 财务审批 → 余额精确调整", async () => {
    const skuA = await makeSku(); // 盘盈 +2
    const skuB = await makeSku(); // 盘亏 −1.5
    const skuC = await makeSku(); // 账实相符
    await seedBalance(skuA, "10");
    await seedBalance(skuB, "5");
    await seedBalance(skuC, "7");

    // 抽盘：按 skuIds 圈定三行
    const task = await createCountTask(
      creator,
      { warehouseId: wh1, mode: "partial", filters: { skuIds: [skuA, skuB, skuC] }, remark: "循环抽点" },
      db,
    );
    expect(task.status).toBe("draft");
    expect(task.docNo.startsWith("PD-")).toBe(true);
    expect(task.mode).toBe("partial");

    let detail = await getCountTask(task.id, db);
    expect(detail.lines).toHaveLength(3);
    for (const l of detail.lines) {
      expect(dCmp(l.countedQty, l.bookQty)).toBe(0); // 预填=账面
      expect(dCmp(l.diffQty, "0")).toBe(0);
    }
    const lineOf = (skuId: number) => detail.lines.find((l) => l.skuId === skuId)!;
    expect(dCmp(lineOf(skuA).bookQty, "10")).toBe(0);

    // 录实盘：A 12（盈+2）、B 3.5（亏−1.5）、C 不动
    const upd = await updateCounts(
      creator,
      task.id,
      {
        version: task.version,
        lines: [
          { lineId: lineOf(skuA).id, countedQty: "12" },
          { lineId: lineOf(skuB).id, countedQty: "3.5" },
        ],
      },
      db,
    );

    const pending = await submitCountTask(creator, task.id, upd.version, db);
    expect(pending.status).toBe("pending");

    // 角色域：制单人（仓库）与仓库审批人均无权审 count（=财务域）；SoD 专项见案例 6
    await expect(
      approveCountTask(creator, task.id, { action: "approve", version: pending.version }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 403, message: expect.stringContaining("财务") });
    await expect(
      approveCountTask(whApprover, task.id, { action: "approve", version: pending.version }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 403 });

    // 财务审批通过 → 调整过账
    const r = await approveCountTask(finApprover, task.id, { action: "approve", version: pending.version }, db);
    expect(r).toMatchObject({ status: "completed", idempotent: false });
    expect(r.adjustDocId).toBeTruthy();

    // 余额精确反映实盘
    expect(dCmp(await getBalance(db, skuA, wh1), "12")).toBe(0);
    expect(dCmp(await getBalance(db, skuB, wh1), "3.5")).toBe(0);
    expect(dCmp(await getBalance(db, skuC, wh1), "7")).toBe(0);

    // 调整单：一张 CA 单、subtype=count_adjust、completed、来源=本 PD；行 qty 带符号
    const [adj] = await db.select().from(stockDocs).where(eq(stockDocs.id, r.adjustDocId!));
    expect(adj).toMatchObject({ subtype: "count_adjust", status: "completed", sourceDocType: "pd", sourceDocId: task.id });
    expect(adj.docNo.startsWith("CA-")).toBe(true);
    const adjLines = await db.select().from(stockDocLines).where(eq(stockDocLines.stockDocId, adj.id)).orderBy(stockDocLines.id);
    expect(adjLines).toHaveLength(2); // 仅差异行；相符行不进调整单
    const adjOf = (skuId: number) => adjLines.find((l) => l.skuId === skuId)!;
    expect(dCmp(adjOf(skuA).qty, "2")).toBe(0);
    expect(dCmp(adjOf(skuB).qty, "-1.5")).toBe(0);

    // 流水：sourceDocType=count_adjust，两条带符号 qtyDelta
    const ledger = await db
      .select()
      .from(stockLedger)
      .where(and(eq(stockLedger.sourceDocType, "count_adjust"), eq(stockLedger.sourceDocId, adj.id)));
    expect(ledger).toHaveLength(2);
    expect(ledger.map((l) => l.action)).toEqual(["post", "post"]);

    // pd_lines.adjustDocId：差异行回填、相符行为空
    detail = await getCountTask(task.id, db);
    expect(detail.status).toBe("completed");
    expect(lineOf(skuA).adjustDocId).toBe(adj.id);
    expect(lineOf(skuB).adjustDocId).toBe(adj.id);
    expect(lineOf(skuC).adjustDocId).toBeNull();
    expect(dCmp(lineOf(skuB).diffQty, "-1.5")).toBe(0);
    expect(detail.adjustDocs).toEqual([{ id: adj.id, docNo: adj.docNo }]);
    expect(detail.approvals).toHaveLength(1);
    expect(detail.approvals[0]).toMatchObject({ approverName: "财务审批人", action: "approve" });

    // 审批幂等：同版本重试短路，不重复过账
    const retry = await approveCountTask(finApprover, task.id, { action: "approve", version: pending.version }, db);
    expect(retry.idempotent).toBe(true);
    expect(dCmp(await getBalance(db, skuA, wh1), "12")).toBe(0);

    // 列表聚合：差异行数=2，盈亏合计=+0.5
    const list = await listCountTasks("", { page: 1, pageSize: 10 }, db);
    const row = (list.rows as Record<string, unknown>[]).find((x) => x.id === task.id)!;
    expect(row).toMatchObject({ lineCount: 3, diffCount: 2, warehouseName: "盘点一仓", mode: "partial" });
    expect(dCmp(String(row.diffTotal), "0.5")).toBe(0);
  });

  it("2) 驳回：退回草稿，不生成调整单、余额不变；可修改后重提", async () => {
    const sku = await makeSku();
    await seedBalance(sku, "6");
    const task = await createCountTask(creator, { warehouseId: wh1, mode: "partial", filters: { skuIds: [sku] } }, db);
    const detail = await getCountTask(task.id, db);
    await updateCounts(creator, task.id, { version: task.version, lines: [{ lineId: detail.lines[0].id, countedQty: "4" }] }, db);
    const [afterUpd] = await db.select().from(pdDocs).where(eq(pdDocs.id, task.id));
    const pending = await submitCountTask(creator, task.id, afterUpd.version, db);

    const r = await approveCountTask(finApprover, task.id, { action: "reject", comment: "差异过大，复盘", version: pending.version }, db);
    expect(r.status).toBe("draft");
    expect(dCmp(await getBalance(db, sku, wh1), "6")).toBe(0);
    const adjRows = await db.select().from(stockDocs).where(and(eq(stockDocs.sourceDocType, "pd"), eq(stockDocs.sourceDocId, task.id)));
    expect(adjRows).toHaveLength(0);

    // 复盘改回相符 → 重提 → 通过：无差异不生成调整单，直接完成
    const [d2] = await db.select().from(pdDocs).where(eq(pdDocs.id, task.id));
    await updateCounts(creator, task.id, { version: d2.version, lines: [{ lineId: detail.lines[0].id, countedQty: "6" }] }, db);
    const [d3] = await db.select().from(pdDocs).where(eq(pdDocs.id, task.id));
    const pending2 = await submitCountTask(creator, task.id, d3.version, db);
    const r2 = await approveCountTask(finApprover, task.id, { action: "approve", version: pending2.version }, db);
    expect(r2).toMatchObject({ status: "completed", adjustDocId: null });
    expect(dCmp(await getBalance(db, sku, wh1), "6")).toBe(0);
    const ledger = await db.select().from(stockLedger).where(eq(stockLedger.sourceDocType, "count_adjust"));
    expect(ledger.filter((l) => l.skuId === sku)).toHaveLength(0);
  });

  it("3) 创建守卫：快照仓拒绝；筛选无命中拒绝；全盘带筛选拒绝；空仓全盘拒绝", async () => {
    await expect(
      createCountTask(creator, { warehouseId: whSnap, mode: "full" }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 400, message: expect.stringContaining("实时记账仓") });

    await expect(
      createCountTask(creator, { warehouseId: wh1, mode: "partial", filters: { q: "不存在的物料XYZ" } }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 400, message: expect.stringContaining("未命中") });

    await expect(
      createCountTask(creator, { warehouseId: wh1, mode: "full", filters: { q: "x" } }, db),
    ).rejects.toMatchObject({ name: "ZodError" });

    const [emptyWh] = await db.insert(warehouses).values({ code: "WH-PD-EMPTY", name: "空仓", kind: "raw" }).returning();
    await expect(
      createCountTask(creator, { warehouseId: emptyWh.id, mode: "full" }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 400 });
  });

  it("4) 全盘：命中该仓全部非零行；实盘负数被拒；非草稿不可再录", async () => {
    const task = await createCountTask(creator, { warehouseId: wh1, mode: "full" }, db);
    const detail = await getCountTask(task.id, db);
    expect(detail.lines.length).toBeGreaterThanOrEqual(4); // 前案例铺底的非零行全量入盘
    expect(detail.mode).toBe("full");

    await expect(
      updateCounts(creator, task.id, { version: task.version, lines: [{ lineId: detail.lines[0].id, countedQty: "-1" }] }, db),
    ).rejects.toMatchObject({ name: "ZodError" });

    // 不属于本单的行 → 400
    await expect(
      updateCounts(creator, task.id, { version: task.version, lines: [{ lineId: 999999, countedQty: "1" }] }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 400 });

    const pending = await submitCountTask(creator, task.id, task.version, db);
    await expect(
      updateCounts(creator, task.id, { version: pending.version, lines: [{ lineId: detail.lines[0].id, countedQty: "1" }] }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 409 });

    // 版本冲突：过期版本审批 → 409
    await expect(
      approveCountTask(finApprover, task.id, { action: "approve", version: pending.version + 99 }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 409, message: expect.stringContaining("已被他人更新") });

    // 管理员兜底可审（无差异→完成）
    const r = await approveCountTask(admin, task.id, { action: "approve", version: pending.version }, db);
    expect(r.status).toBe("completed");
  });

  it("5) 提交/录入权限：非制单人（非仓库/管理员）不可操作；财务不可录实盘", async () => {
    const sku = await makeSku();
    await seedBalance(sku, "3");
    const task = await createCountTask(creator, { warehouseId: wh1, mode: "partial", filters: { skuIds: [sku] } }, db);
    const detail = await getCountTask(task.id, db);

    // 财务（非制单人、非仓库）不可录实盘
    await expect(
      updateCounts(finApprover, task.id, { version: task.version, lines: [{ lineId: detail.lines[0].id, countedQty: "2" }] }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 403 });
    // 仓库同事可代录
    const upd = await updateCounts(whApprover, task.id, { version: task.version, lines: [{ lineId: detail.lines[0].id, countedQty: "2" }] }, db);

    // 非制单人不可提交（管理员可）
    await expect(submitCountTask(whApprover, task.id, upd.version, db)).rejects.toMatchObject({ name: "ApiError", status: 403 });
    const pending = await submitCountTask(admin, task.id, upd.version, db);
    expect(pending.status).toBe("pending");

    // 审批留痕在 count 域
    const r = await approveCountTask(finApprover, task.id, { action: "approve", version: pending.version }, db);
    expect(r.status).toBe("completed");
    const rows = await db.select().from(approvals).where(and(eq(approvals.docType, "count"), eq(approvals.docId, task.id)));
    expect(rows).toHaveLength(1);

    // 盘亏 1 落账
    expect(dCmp(await getBalance(db, sku, wh1), "2")).toBe(0);
    const [line] = await db.select().from(pdLines).where(and(eq(pdLines.pdId, task.id), eq(pdLines.skuId, sku)));
    expect(line.adjustDocId).not.toBeNull();
  });

  it("6) 职责分离：具财务角色的制单人自审 → SELF_APPROVAL（管理员亦不豁免制单人身份）", async () => {
    const finCreator = await mkUser("财务兼仓管", ["warehouse", "finance"], true);
    const sku = await makeSku();
    await seedBalance(sku, "9");
    const task = await createCountTask(finCreator, { warehouseId: wh1, mode: "partial", filters: { skuIds: [sku] } }, db);
    const pending = await submitCountTask(finCreator, task.id, task.version, db);
    await expect(
      approveCountTask(finCreator, task.id, { action: "approve", version: pending.version }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 403, message: expect.stringContaining("职责分离") });
    // 单据保持 pending，其他财务审批人可正常通过
    const [still] = await db.select().from(pdDocs).where(eq(pdDocs.id, task.id));
    expect(still.status).toBe("pending");
    const r = await approveCountTask(finApprover, task.id, { action: "approve", version: pending.version }, db);
    expect(r.status).toBe("completed");
  });
});
