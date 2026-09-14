/**
 * W2-3 库存单据的撤回 / 作废 / 短关回归门。
 *
 * 修复前：`stock-doc.ts` 只有 create / submit / approve / reverse 四个写路径。
 * 后果是——草稿建错了就永远挂在那里（没有作废），交上去的单撤不回来（没有撤回），
 * 而 `/inventory/docs` 上那个「已关闭」页签**永远是空的**：系统里没有任何代码
 * 会把 stock_docs.status 写成 'closed'。
 *
 * 这三个函数在修复前根本不存在，因此以下每条断言都会失败。
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  auditLogs, skus, spus, stockDocLines, stockDocs, stockLedger, users, warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { nextStatus, TransitionError } from "@/server/docflow/state";
import {
  approveStockDoc, getStockDoc, shortCloseStockDoc, submitStockDoc, voidStockDoc, withdrawStockDoc,
} from "@/server/modules/inventory/stock-doc";
import { post } from "@/server/posting";
import { createTestDb, type TestDb } from "../helpers/db";

async function seed(db: TestDb) {
  const [author] = await db.insert(users).values({ name: "制单仓管", roles: ["warehouse"] }).returning();
  const [other] = await db.insert(users).values({ name: "另一仓管", roles: ["warehouse"] }).returning();
  const [adminRow] = await db.insert(users).values({ name: "管理员", roles: ["admin"] }).returning();
  const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
  const [sku] = await db
    .insert(skus)
    .values({ code: "CP00001", spuId: spu.id, baseUom: "个", skuType: "finished" })
    .returning();
  const [wh] = await db.insert(warehouses).values({ code: "WH-F", name: "成品仓", kind: "finished" }).returning();
  const user = (row: typeof author, roles: string[]): SessionUser =>
    ({ id: row.id, name: row.name, roles, isApprover: false });
  return {
    author: user(author, ["warehouse"]),
    other: user(other, ["warehouse"]),
    admin: user(adminRow, ["admin"]),
    skuId: sku.id,
    warehouseId: wh.id,
  };
}

async function makeDoc(
  db: TestDb,
  args: { docNo: string; createdBy: number; status?: string; skuId: number; warehouseId: number },
) {
  const [doc] = await db
    .insert(stockDocs)
    .values({
      docNo: args.docNo,
      subtype: "issue_out",
      createdBy: args.createdBy,
      ...(args.status ? { status: args.status as "draft" } : {}),
    })
    .returning();
  await db.insert(stockDocLines).values({
    stockDocId: doc.id, skuId: args.skuId, warehouseId: args.warehouseId, qty: "5",
  });
  return doc;
}

async function auditActions(db: TestDb, docId: number) {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entity, "stock_doc"), eq(auditLogs.entityId, docId)));
  return rows;
}

describe("W2-3 库存单据可以被撤回 / 作废 / 短关", () => {
  it("状态机允许这三条边（docflow/state 是权威，服务层只能沿着它走）", () => {
    expect(nextStatus("pending", "withdraw")).toBe("draft");
    expect(nextStatus("draft", "void")).toBe("void");
    expect(nextStatus("approved", "short_close")).toBe("closed");
    expect(nextStatus("in_progress", "short_close")).toBe("closed");
    // 已完成的单不能短关——纠错唯一路径仍是红字冲销
    expect(() => nextStatus("completed", "short_close")).toThrow(TransitionError);
  });

  it("撤回：待审批 → 草稿，仅制单人或管理员，写审计", async () => {
    const { db } = await createTestDb();
    const s = await seed(db);
    const doc = await makeDoc(db, { docNo: "CK-W1", createdBy: s.author.id, skuId: s.skuId, warehouseId: s.warehouseId });
    const submitted = await submitStockDoc(s.author, doc.id, doc.version, db);
    expect(submitted.status).toBe("pending");

    await expect(withdrawStockDoc(s.other, doc.id, { version: submitted.version }, db))
      .rejects.toThrow(/仅制单人或管理员/);

    const back = await withdrawStockDoc(s.author, doc.id, { version: submitted.version }, db);
    expect(back.status).toBe("draft");
    expect((await auditActions(db, doc.id)).map((a) => a.action)).toContain("withdraw");
  });

  it("撤回：草稿不可撤回（只有交上去的单才谈得上撤回）", async () => {
    const { db } = await createTestDb();
    const s = await seed(db);
    const doc = await makeDoc(db, { docNo: "CK-W2", createdBy: s.author.id, skuId: s.skuId, warehouseId: s.warehouseId });
    await expect(withdrawStockDoc(s.author, doc.id, { version: doc.version }, db))
      .rejects.toThrow(/仅待审批单据可撤回/);
  });

  it("作废：草稿 → 已作废，必须留原因，原因落 closed_reason 并写审计", async () => {
    const { db } = await createTestDb();
    const s = await seed(db);
    const doc = await makeDoc(db, { docNo: "CK-V1", createdBy: s.author.id, skuId: s.skuId, warehouseId: s.warehouseId });

    await expect(voidStockDoc(s.author, doc.id, { version: doc.version, reason: "" }, db)).rejects.toThrow();
    const voided = await voidStockDoc(s.author, doc.id, { version: doc.version, reason: "录错仓库，重开一张" }, db);
    expect(voided.status).toBe("void");
    expect(voided.closedReason).toBe("录错仓库，重开一张");

    const audit = (await auditActions(db, doc.id)).find((a) => a.action === "void")!;
    expect(audit.userId).toBe(s.author.id);
    expect(audit.after).toMatchObject({ status: "void", reason: "录错仓库，重开一张" });
    // 作废是终态：不能再提交
    await expect(submitStockDoc(s.author, doc.id, voided.version, db)).rejects.toThrow(/当前状态不可提交/);
  });

  it("作废：管理员可作废他人草稿；非制单人的普通仓管不可", async () => {
    const { db } = await createTestDb();
    const s = await seed(db);
    const doc = await makeDoc(db, { docNo: "CK-V2", createdBy: s.author.id, skuId: s.skuId, warehouseId: s.warehouseId });
    await expect(voidStockDoc(s.other, doc.id, { version: doc.version, reason: "手滑" }, db))
      .rejects.toThrow(/仅制单人或管理员/);
    expect((await voidStockDoc(s.admin, doc.id, { version: doc.version, reason: "管理员清理测试单" }, db)).status)
      .toBe("void");
  });

  it("短关：已审批 → 已关闭（「已关闭」页签因此才有数据），必须留原因，且**不触任何库存流水**", async () => {
    const { db } = await createTestDb();
    const s = await seed(db);
    const doc = await makeDoc(db, {
      docNo: "CK-S1", createdBy: s.author.id, status: "approved", skuId: s.skuId, warehouseId: s.warehouseId,
    });
    // 先制造一笔已过账的既成事实：短关绝不能把它冲掉
    await post(db, {
      sourceDocType: "opening",
      sourceDocId: 777,
      action: "post",
      lines: [{ sourceLineId: 1, skuId: s.skuId, warehouseId: s.warehouseId, qtyDelta: "5" }],
    });
    const ledgerBefore = await db.select().from(stockLedger);

    await expect(shortCloseStockDoc(s.author, doc.id, { version: doc.version, reason: "" }, db)).rejects.toThrow();
    const closed = await shortCloseStockDoc(
      s.author, doc.id, { version: doc.version, reason: "供应商停产，剩余不再执行" }, db,
    );
    expect(closed.status).toBe("closed");
    expect(closed.closedReason).toBe("供应商停产，剩余不再执行");

    // 库存零变化：短关只关剩余，不是反过账
    expect(await db.select().from(stockLedger)).toHaveLength(ledgerBefore.length);
    expect((await auditActions(db, doc.id)).map((a) => a.action)).toContain("short_close");

    // 列表按 status=closed 能查到它——修复前这个页签永远为空
    const closedDocs = await db.select().from(stockDocs).where(eq(stockDocs.status, "closed"));
    expect(closedDocs.map((d) => d.docNo)).toEqual(["CK-S1"]);
  });

  it("短关：仅仓管/管理员；草稿与已完成单不可短关", async () => {
    const { db } = await createTestDb();
    const s = await seed(db);
    const draft = await makeDoc(db, { docNo: "CK-S2", createdBy: s.author.id, skuId: s.skuId, warehouseId: s.warehouseId });
    await expect(shortCloseStockDoc(s.author, draft.id, { version: draft.version, reason: "不想做了" }, db))
      .rejects.toThrow(/仅已审批或执行中/);

    const done = await makeDoc(db, {
      docNo: "CK-S3", createdBy: s.author.id, status: "completed", skuId: s.skuId, warehouseId: s.warehouseId,
    });
    await expect(shortCloseStockDoc(s.author, done.id, { version: done.version, reason: "已完成也想关" }, db))
      .rejects.toThrow(/仅已审批或执行中/);

    const approved = await makeDoc(db, {
      docNo: "CK-S4", createdBy: s.author.id, status: "approved", skuId: s.skuId, warehouseId: s.warehouseId,
    });
    const finance: SessionUser = { id: s.other.id, name: "财务", roles: ["finance"], isApprover: false };
    // The database, not a forged in-memory SessionUser, is now the authority.
    await db.update(users).set({ roles: ["finance"] }).where(eq(users.id, finance.id));
    await expect(shortCloseStockDoc(finance, approved.id, { version: approved.version, reason: "财务来关" }, db))
      .rejects.toThrow(/仅仓管或管理员/);
  });

  it("乐观锁：版本过期的撤回/作废/短关一律 409，不会静默覆盖别人的流转", async () => {
    const { db } = await createTestDb();
    const s = await seed(db);
    const doc = await makeDoc(db, { docNo: "CK-L1", createdBy: s.author.id, skuId: s.skuId, warehouseId: s.warehouseId });
    await expect(voidStockDoc(s.author, doc.id, { version: doc.version + 5, reason: "版本不对" }, db))
      .rejects.toThrow(/版本冲突/);
  });
});

describe("库存退出不掩盖来源与既有流水", () => {
  it.each(["void", "withdraw", "shortClose"])("CA不能经%s脱离来源盘点独立流转", async action => {
    const { db, client } = await createTestDb();
    try {
      const s = await seed(db), doc = await makeDoc(db, { docNo: `CA-${action}`, createdBy: s.author.id, skuId: s.skuId, warehouseId: s.warehouseId,
        status: action === "void" ? "draft" : action === "withdraw" ? "pending" : "approved" });
      await db.update(stockDocs).set({ subtype: "count_adjust", sourceDocType: "pd", sourceDocId: 71 }).where(eq(stockDocs.id, doc.id));
      const before = await db.select().from(stockDocs);
      const run = action === "void" ? voidStockDoc : action === "withdraw" ? withdrawStockDoc : shortCloseStockDoc;
      await expect(run(s.admin, doc.id, { version: doc.version, reason: "来源异常核对" }, db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("来源盘点") });
      expect(await db.select().from(stockDocs)).toEqual(before); expect(await auditActions(db, doc.id)).toEqual([]);
    } finally { await client.close(); }
  });
  it.each(["submit", "void", "withdraw", "approve", "reject"])("%s拒绝有同身份流水的伪未生效单，且读取提示一致", async action => {
    const { db, client } = await createTestDb();
    try {
      const s = await seed(db), doc = await makeDoc(db, { docNo: `RK-${action}`, createdBy: s.author.id, skuId: s.skuId, warehouseId: s.warehouseId,
        status: ["submit", "void"].includes(action) ? "draft" : "pending" });
      await db.update(stockDocs).set({ subtype: "opening" }).where(eq(stockDocs.id, doc.id));
      await post(db, { sourceDocType: "opening", sourceDocId: doc.id, action: "post", lines: [{ sourceLineId: 1, skuId: s.skuId, warehouseId: s.warehouseId, qtyDelta: "0.1250" }] });
      const before = { docs: await db.select().from(stockDocs), ledger: await db.select().from(stockLedger) };
      const run = action === "submit" ? submitStockDoc(s.author, doc.id, doc.version, db)
        : action === "void" ? voidStockDoc(s.author, doc.id, { version: doc.version, reason: "错误来源" }, db)
        : action === "withdraw" ? withdrawStockDoc(s.author, doc.id, { version: doc.version }, db)
        : approveStockDoc(s.other, doc.id, { version: doc.version, action: action === "reject" ? "reject" : "approve" }, db);
      await expect(run).rejects.toMatchObject({ status: 409, message: expect.stringContaining("已有库存流水") });
      expect(await db.select().from(stockDocs)).toEqual(before.docs); expect(await db.select().from(stockLedger)).toEqual(before.ledger);
      expect(await auditActions(db, doc.id)).toEqual([]);
      expect((await getStockDoc(doc.id, db, s.author)).actions).toMatchObject({ submit: false, void: false, withdraw: false, approve: false, reason: expect.stringContaining("已有库存流水") });
    } finally { await client.close(); }
  });
  it("相同数字不同流水来源不误拦；作废原因和原明细仍可读取", async () => {
    const { db, client } = await createTestDb();
    try {
      const s = await seed(db), doc = await makeDoc(db, { docNo: "CK-IDENTITY", createdBy: s.author.id, skuId: s.skuId, warehouseId: s.warehouseId });
      await post(db, { sourceDocType: "opening", sourceDocId: doc.id, action: "post", lines: [{ sourceLineId: 1, skuId: s.skuId, warehouseId: s.warehouseId, qtyDelta: "5" }] });
      await db.update(warehouses).set({ active: false }).where(eq(warehouses.id, s.warehouseId));
      await voidStockDoc(s.author, doc.id, { version: doc.version, reason: "仓库选择错误" }, db);
      const result = await getStockDoc(doc.id, db, s.author);
      expect(result).toMatchObject({ status: "void", closedReason: "仓库选择错误", lines: [{ skuId: s.skuId, qty: "5.0000" }] });
    } finally { await client.close(); }
  });
  it("红字载体流水按本单stock_doc身份保护，不能因原单不同而作废", async () => {
    const { db, client } = await createTestDb();
    try {
      const s = await seed(db), doc = await makeDoc(db, { docNo: "CK-REVERSE", createdBy: s.author.id, skuId: s.skuId, warehouseId: s.warehouseId });
      await db.update(stockDocs).set({ subtype: "reversal", reversalOfId: 999 }).where(eq(stockDocs.id, doc.id));
      await post(db, { sourceDocType: "stock_doc", sourceDocId: doc.id, action: "reverse:issue_out#999", lines: [{ sourceLineId: 1, skuId: s.skuId, warehouseId: s.warehouseId, qtyDelta: "5" }] });
      await expect(voidStockDoc(s.author, doc.id, { version: doc.version, reason: "不能抹去冲销事实" }, db)).rejects.toMatchObject({ status: 409 });
    } finally { await client.close(); }
  });
});
