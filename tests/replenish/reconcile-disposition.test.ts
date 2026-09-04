/**
 * W2-#7 运营提报核对必须有下一步。
 *
 * 事故形状：`replenish/reconcile.ts` 把提报与系统基线并排、标出「需核对」，然后**什么也不发生**——
 * 没有接受/驳回、没有责任人、对下游没有任何影响。标红的行可以标红一整年。
 *
 * 修复口径（D55 不变，仍不自动驱动建议量）：
 *  - accept 把运营那个数记为该期**已达成一致的需求**，成为计划员看得见、可据以行动的输入；
 *  - reject 必须写原因；
 *  - 未处置的标红行投影成 review_items（责任角色 pmc）→ 待办，于是它们会走到某个人面前。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  disposeOpsDemand,
  getReconcile,
  OPS_DEMAND_REVIEW_CATEGORY,
  projectReconcileReviewItems,
  submitOpsDemand,
} from "@/server/modules/replenish/reconcile";
import { reviewOwnerRole } from "@/server/rules/task-triggers";
import { DEFAULT_REVIEW_PREFIXES } from "@/server/modules/todo/triggers";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb } from "../helpers/db";

async function seed(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const [pmc] = await db.insert(schema.users).values({ name: "计划员", roles: ["pmc"] }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "测试" }).returning();
  const [sku] = await db.insert(schema.skus).values({ code: "CP00001", name: "面霜", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
  const [ch] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
  // 近 6 月各 100 → Holt 月量基线 ≈ 100；提报 900 → 差异 +800%，必然标红
  for (const ym of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
    await db.insert(schema.salesMonthly).values({ skuId: sku.id, channelId: ch.id, yearMonth: ym, qty: "100" });
  }
  const user: SessionUser = { id: pmc.id, name: pmc.name, roles: ["pmc"] } as SessionUser;
  await submitOpsDemand(user, { rows: [{ skuId: sku.id, channelId: ch.id, period: "2026-10", qty: "900", basis: "双11" }] }, db);
  return { user, sku, ch };
}

describe("运营提报处置（W2-#7）", () => {
  it("标红行有接受/驳回；接受记为一致需求但不驱动数量，驳回必须写原因", async () => {
    const { db, client } = await createTestDb();
    try {
      const { user } = await seed(db);
      const before = await getReconcile({ roles: ["pmc"] }, {}, db);
      const row = before.rows[0];
      expect(row.flagged).toBe(true);
      expect(row.disposition, "此前标红之后什么也没有").toBeNull();
      expect(row.needsDisposition).toBe(true);
      expect(before.summary.needsDisposition).toBe(1);

      // 驳回必须写原因（≥5 字）
      await expect(disposeOpsDemand(user, { submissionId: row.submissionId, decision: "rejected", reason: "算了" }, db))
        .rejects.toMatchObject({ status: 400 });

      const accepted = await disposeOpsDemand(user, { submissionId: row.submissionId, decision: "accepted" }, db);
      expect(accepted.agreedQty).toBe("900.0000");

      const after = await getReconcile({ roles: ["pmc"] }, {}, db);
      const done = after.rows[0];
      expect(done.disposition).toMatchObject({ decision: "accepted", agreedQty: "900.0000", by: "计划员" });
      expect(done.needsDisposition).toBe(false);
      expect(done.flagged, "接受不等于差异消失——差异仍如实标出，只是已经有人拍板").toBe(true);
      expect(after.summary).toMatchObject({ needsDisposition: 0, accepted: 1, rejected: 0, agreedQty: "900.0000" });

      // 改判为驳回（同一条提报只保留一条处置）
      await disposeOpsDemand(user, { submissionId: row.submissionId, decision: "rejected", reason: "活动已取消，按 8 月实际动销执行" }, db);
      const rows = await db.select().from(schema.opsDemandDispositions);
      expect(rows).toHaveLength(1);
      const reversed = await getReconcile({ roles: ["pmc"] }, {}, db);
      expect(reversed.rows[0].disposition).toMatchObject({ decision: "rejected", agreedQty: null });
      expect(reversed.summary.agreedQty).toBe("0.0000");

      const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "ops_demand_disposition"));
      expect(audits.map((a) => a.action).sort()).toEqual(["accepted", "rejected"]);
    } finally {
      await client.close();
    }
  });

  it("已被修正（supersede）的旧行不能再处置：待办对象是链尾那一行", async () => {
    const { db, client } = await createTestDb();
    try {
      const { user, sku, ch } = await seed(db);
      const first = (await getReconcile({ roles: ["pmc"] }, {}, db)).rows[0].submissionId;
      await submitOpsDemand(user, { rows: [{ skuId: sku.id, channelId: ch.id, period: "2026-10", qty: "700", basis: "修正" }] }, db);
      await expect(disposeOpsDemand(user, { submissionId: first, decision: "accepted" }, db)).rejects.toMatchObject({ status: 409 });
      const head = (await getReconcile({ roles: ["pmc"] }, {}, db)).rows[0];
      expect(head.submissionId).not.toBe(first);
      await expect(disposeOpsDemand(user, { submissionId: head.submissionId, decision: "accepted" }, db)).resolves.toMatchObject({ decision: "accepted" });
    } finally {
      await client.close();
    }
  });

  it("未处置的标红行投影成有责任角色的复核项；处置后自动关闭（幂等，不重复开）", async () => {
    const { db, client } = await createTestDb();
    try {
      const { user } = await seed(db);
      const first = await projectReconcileReviewItems(null, db);
      expect(first).toMatchObject({ opened: 1, closed: 0, period: "2026-10" });
      const again = await projectReconcileReviewItems(null, db);
      expect(again.opened, "同一行不得重复开复核项").toBe(0);

      const items = await db.select().from(schema.reviewItems).where(eq(schema.reviewItems.category, OPS_DEMAND_REVIEW_CATEGORY));
      expect(items).toHaveLength(1);
      expect(items[0].refType).toBe("ops_demand_submission");
      expect(items[0].status).toBe("open");
      // 责任角色由 rules/task-triggers 唯一给出——不在这里另写一份
      expect(reviewOwnerRole(OPS_DEMAND_REVIEW_CATEGORY)).toBe("pmc");
      expect(DEFAULT_REVIEW_PREFIXES, "必须进入待办投影白名单，否则复核项到不了待办板").toContain("ops_demand");

      const row = (await getReconcile({ roles: ["pmc"] }, {}, db)).rows[0];
      await disposeOpsDemand(user, { submissionId: row.submissionId, decision: "accepted" }, db);
      const closed = await db.select().from(schema.reviewItems).where(eq(schema.reviewItems.category, OPS_DEMAND_REVIEW_CATEGORY));
      expect(closed[0].status, "事情办完，待办必须跟着关").toBe("done");

      const reproject = await projectReconcileReviewItems(null, db);
      expect(reproject).toMatchObject({ opened: 0, closed: 0 });
    } finally {
      await client.close();
    }
  });
});
