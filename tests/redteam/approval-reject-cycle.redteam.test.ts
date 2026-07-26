/**
 * RED TEAM — 审批引擎 uq_approval_idem(docType,docId,node,action) 的幂等键碰撞。
 * 攻击场景：驳回 → 重新提交 → 第二次驳回。
 * 幂等检查按 (docType,docId,node=1,action) 查询——第二次驳回命中第一次的驳回记录，
 * 被误判为"幂等重试"直接短路返回，单据永远卡在 pending，从此无法再被驳回。
 * 约定：断言【正确】行为；用例失败 = 漏洞证实。
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { approvalConfigs, approvals, skus, spus, stockDocs, users, warehouses } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  approveStockDoc, createStockDoc, submitStockDoc,
} from "@/server/modules/inventory/stock-doc";
import { createTestDb, type TestDb } from "../helpers/db";

describe("redteam/approval reject→resubmit→reject 循环", () => {
  let db: TestDb;
  let creator: SessionUser;
  let approver: SessionUser;
  let wh1: number;
  let skuId: number;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mkUser = async (name: string, roles: string[], isApprover: boolean): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover }).returning();
      return { id: u.id, name: u.name, roles, isApprover };
    };
    creator = await mkUser("制单员", ["warehouse"], true);
    approver = await mkUser("审批人", ["warehouse"], true);
    await db.insert(approvalConfigs).values([
      { docType: "stock_doc", approverRole: "warehouse" },
      { docType: "opening", approverRole: "warehouse" }, // 机制测试；生产 seed 为 finance（见专项测试）
      { docType: "count", approverRole: "warehouse" },
    ]);
    const [spu] = await db.insert(spus).values({ code: "P90001", nameCn: "红队产品" }).returning();
    const [w] = await db.insert(warehouses).values({ code: "WH-RT-1", name: "红队仓", kind: "raw" }).returning();
    wh1 = w.id;
    const [s] = await db.insert(skus).values({ code: "RT00001", name: "红队物料", spuId: spu.id, baseUom: "个", skuType: "raw" }).returning();
    skuId = s.id;
  });

  it("[BUG?] 第二次驳回必须真正生效：单据应回到 draft，而非 idempotent 短路卡死在 pending", async () => {
    const doc = await createStockDoc(creator, { subtype: "opening", warehouseId: wh1, lines: [{ skuId, qty: "1" }] }, db);
    const pending1 = await submitStockDoc(creator, doc.id, doc.version, db);

    // 第一次驳回 → draft
    const r1 = await approveStockDoc(approver, pending1.id, { action: "reject", comment: "第一次驳回", version: pending1.version }, db);
    expect(r1).toMatchObject({ status: "draft", idempotent: false });

    // 重新提交 → pending
    const [afterReject] = await db.select().from(stockDocs).where(eq(stockDocs.id, doc.id));
    const pending2 = await submitStockDoc(creator, doc.id, afterReject.version, db);
    expect(pending2.status).toBe("pending");

    // 第二次驳回：正确行为 = 再次回到 draft
    const r2 = await approveStockDoc(approver, pending2.id, { action: "reject", comment: "第二次驳回", version: pending2.version }, db);
    const [finalDoc] = await db.select().from(stockDocs).where(eq(stockDocs.id, doc.id));

    // 断言正确行为（漏洞存在时：r2.idempotent===true 且 finalDoc.status==='pending'）
    expect(finalDoc.status).toBe("draft");
    expect(r2.idempotent).toBe(false);
    expect(r2.status).toBe("draft");
  });

  it("[BUG?] 卡死后果验证：若第二次驳回被短路，单据只剩 approve 一条出路（无 withdraw API）", async () => {
    const doc = await createStockDoc(creator, { subtype: "opening", warehouseId: wh1, lines: [{ skuId, qty: "2" }] }, db);
    const p1 = await submitStockDoc(creator, doc.id, doc.version, db);
    await approveStockDoc(approver, p1.id, { action: "reject", version: p1.version }, db);
    const [d1] = await db.select().from(stockDocs).where(eq(stockDocs.id, doc.id));
    const p2 = await submitStockDoc(creator, doc.id, d1.version, db);

    // 疯狂重试第二次驳回 3 次——正确行为：第一次就应生效
    for (let k = 0; k < 3; k++) {
      const [cur] = await db.select().from(stockDocs).where(eq(stockDocs.id, doc.id));
      if (cur.status !== "pending") break;
      await approveStockDoc(approver, p2.id, { action: "reject", version: cur.version }, db);
    }
    const [finalDoc] = await db.select().from(stockDocs).where(eq(stockDocs.id, doc.id));
    expect(finalDoc.status).toBe("draft"); // 漏洞存在时：恒为 pending

    // 审批留痕检查：第二次驳回意见完全丢失（只有 1 条 reject 记录）
    const rows = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.docType, "opening"), eq(approvals.docId, doc.id), eq(approvals.action, "reject"))); // 体检#2 后期初审批落 docType=opening
    expect(rows.length).toBeGreaterThanOrEqual(2); // 正确行为：每次驳回各留一条
  });

  it("对照：approve 的幂等短路对重试是正确的（已完成单重复 approve → idempotent）", async () => {
    const doc = await createStockDoc(creator, { subtype: "opening", warehouseId: wh1, lines: [{ skuId, qty: "3" }] }, db);
    const p = await submitStockDoc(creator, doc.id, doc.version, db);
    const r1 = await approveStockDoc(approver, p.id, { action: "approve", version: p.version }, db);
    expect(r1).toMatchObject({ status: "completed", idempotent: false });
    const r2 = await approveStockDoc(approver, p.id, { action: "approve", version: p.version }, db);
    expect(r2.idempotent).toBe(true);
  });
});
