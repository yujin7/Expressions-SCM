/**
 * D65 周/月核对写路径（dq/reviews.ts）：
 * - 生成幂等（UNIQUE）+ 有操作人时审计；定时任务无操作人不写审计；
 * - 完成/豁免只允许 pending；豁免必填原因；同事务 writeAudit(entity=data_quality_review)；
 * - 角色守卫 403；节奏裁决：连续 4 周完成且达标 → 月核对。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import type { SessionUser } from "@/server/core/dto";
import { closeReview, generateReviewPack, generateReviewPackAs, listReviews, pendingReviewCount, periodMet, resolveCadence } from "@/server/modules/dq/reviews";
import { ApiError } from "@/server/modules/master/common";

const statusOf = async (p: Promise<unknown>): Promise<number | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.status : -1;
  }
};

async function seed() {
  const { db, client } = await createTestDb();
  const [pmc] = await db.insert(schema.users).values({ name: "计划", roles: ["pmc"] }).returning();
  const [ops] = await db.insert(schema.users).values({ name: "运营", roles: ["ops"] }).returning();
  const actor = (u: typeof pmc): SessionUser => ({ id: u.id, name: u.name, roles: u.roles as string[], isApprover: u.isApprover });
  return { db, client, pmc, ops, actor };
}

describe("generateReviewPack", () => {
  it("三类各一行、幂等；操作人触发写审计，任务触发不写", async () => {
    const { db, client, pmc, actor } = await seed();
    try {
      const first = await generateReviewPack(db, { periodKind: "week", periodKey: "2026-W35", actorId: null, today: "2026-09-03" });
      expect(first).toMatchObject({ created: 3, existing: 0 });
      expect(first.rows.map((r) => r.sourceClass).sort()).toEqual(["external_platform", "manual_po_chain", "rpa_warehouse"]);
      expect(first.rows.every((r) => r.status === "pending" && r.evidence?.generatedBy === "job")).toBe(true);
      expect(first.rows[0].evidence?.range).toEqual({ from: "2026-08-24", through: "2026-08-30" });
      expect(await db.select().from(schema.auditLogs)).toHaveLength(0);

      const again = await generateReviewPackAs(actor(pmc), { periodKind: "week", periodKey: "2026-W35" }, db);
      expect(again).toMatchObject({ created: 0, existing: 3 });
      expect(await pendingReviewCount(db)).toBe(3);

      const month = await generateReviewPackAs(actor(pmc), { periodKind: "month", periodKey: "2026-08" }, db);
      expect(month.created).toBe(3);
      const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "data_quality_review"));
      expect(audits).toHaveLength(3);
      expect(audits.every((a) => a.action === "create" && a.userId === pmc.id)).toBe(true);

      expect(await statusOf(generateReviewPackAs(actor(pmc), { periodKind: "week", periodKey: "2026-08" }, db))).toBe(400);
      expect(await statusOf(generateReviewPack(db, { periodKind: "week", periodKey: "2026-W35", sourceClasses: ["reference_file" as never] }))).toBe(400);
    } finally {
      await client.close();
    }
  });
});

describe("closeReview", () => {
  it("完成/豁免只对 pending；豁免必填原因；审计同事务；非法角色 403", async () => {
    const { db, client, pmc, ops, actor } = await seed();
    try {
      const pack = await generateReviewPack(db, { periodKind: "week", periodKey: "2026-W35", actorId: null, today: "2026-09-03" });
      const [a, b] = pack.rows;
      expect(await statusOf(closeReview(actor(ops), a.id, { status: "completed" }, db))).toBe(403);
      expect(await statusOf(closeReview(actor(pmc), 999999, { status: "completed" }, db))).toBe(404);
      expect(await statusOf(closeReview(actor(pmc), a.id, { status: "waived" }, db))).toBe(400);
      expect(await statusOf(closeReview(actor(pmc), a.id, { status: "bogus" }, db))).toBe(-1); // zod
      expect(await db.select().from(schema.auditLogs)).toHaveLength(0);

      const done = await closeReview(actor(pmc), a.id, { status: "completed", note: "已核对" }, db);
      expect(done).toMatchObject({ id: a.id, status: "completed", note: "已核对", reviewedBy: pmc.id, reviewedByName: "计划" });
      expect(done.reviewedAt).not.toBeNull();
      const waived = await closeReview(actor(pmc), b.id, { status: "waived", note: "本周无数据" }, db);
      expect(waived.status).toBe("waived");
      expect(await statusOf(closeReview(actor(pmc), a.id, { status: "completed" }, db))).toBe(409);

      const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "data_quality_review"));
      expect(audits.map((x) => x.action).sort()).toEqual(["complete", "waive"]);
      expect(audits.every((x) => x.entityId != null && x.userId === pmc.id)).toBe(true);

      const list = await listReviews(db, { status: "pending" });
      expect(list.total).toBe(1);
      const withName = await listReviews(db, { periodKey: "2026-W35" });
      expect(withName.data.find((r) => r.id === a.id)?.reviewedByName).toBe("计划");
    } finally {
      await client.close();
    }
  });
});

describe("resolveCadence", () => {
  it("连续 4 周（不含本周）全部完成且达标 → 月核对；豁免/未达标不算", async () => {
    const { db, client, pmc } = await seed();
    try {
      expect((await resolveCadence(db, "2026-09-03")).cadence).toBe("week");
      const weeks = ["2026-W35", "2026-W34", "2026-W33", "2026-W32"];
      const ev = (rate: number | null) => ({ accuracy: { rate, status: "ok" } });
      const rows = weeks.flatMap((k) => [
        { periodKind: "week", periodKey: k, sourceClass: "rpa_warehouse", status: "completed", evidence: ev(96), reviewedBy: pmc.id, reviewedAt: new Date() },
        { periodKind: "week", periodKey: k, sourceClass: "manual_po_chain", status: "completed", evidence: ev(92), reviewedBy: pmc.id, reviewedAt: new Date() },
        { periodKind: "week", periodKey: k, sourceClass: "external_platform", status: "completed", evidence: ev(91), reviewedBy: pmc.id, reviewedAt: new Date() },
      ]);
      await db.insert(schema.dataQualityReviews).values(rows);
      const r = await resolveCadence(db, "2026-09-03");
      expect(r).toMatchObject({ cadence: "month", streak: 4, periodKey: "2026-08" });

      // 最近一周有一类豁免 → 回到周核对
      await db.update(schema.dataQualityReviews).set({ status: "waived", note: "x" })
        .where(eq(schema.dataQualityReviews.periodKey, "2026-W35"));
      expect((await resolveCadence(db, "2026-09-03")).cadence).toBe("week");
      expect(periodMet([{ sourceClass: "rpa_warehouse", status: "completed", evidence: ev(80) }])).toBe(false);
    } finally {
      await client.close();
    }
  });
});
