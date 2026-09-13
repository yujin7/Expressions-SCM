import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { shanghaiMonthOf } from "@/server/core/business-day";
import type { SessionUser } from "@/server/core/dto";
import { createReplenishDraft } from "@/server/modules/replenish/service";
import { changeSopPlan, createSopCycle, decideSopCycle, transitionSopCycle } from "@/server/modules/replenish/sop-cycle";
import { createTestDb, type TestDb } from "../helpers/db";

async function fixture(db: TestDb) {
  const people = await db.insert(s.users).values([
    { name: "计划", roles: ["pmc"] }, { name: "运营", roles: ["ops"] }, { name: "财务", roles: ["finance"] },
  ]).returning();
  const [pmc, ops, finance]: SessionUser[] = people.map(p => ({
    id: p.id, name: p.name, roles: p.roles, isApprover: false, sessionVersion: p.sessionVersion,
  }));
  const [spu] = await db.insert(s.spus).values({ code: "MODE", nameCn: "测试" }).returning();
  const [sku] = await db.insert(s.skus).values({ code: "MODE", name: "测试", spuId: spu.id, skuType: "finished", baseUom: "瓶" }).returning();
  const plans = await db.insert(s.planningVersions).values(["a", "b"].map(d => ({
    name: `计划${d}`, weekStart: "2026-09-01", engineVersion: "test", parameters: {}, sourceMeta: {},
    lineCount: 0, suggestedCount: 0, suppressedCount: 0, digest: d.repeat(64), idempotencyKey: crypto.randomUUID(), createdBy: pmc.id,
  }))).returning();
  const input = { month: shanghaiMonthOf(new Date()), name: "当月计划", planningVersionId: plans[0].id, idempotencyKey: crypto.randomUUID() };
  const cycle = await createSopCycle(pmc, input, db);
  return { pmc, ops, finance, cycle, input, nextPlan: plans[1].id, skuId: sku.id };
}

describe("S&OP governance uses current authority inside the owning write transaction", () => {
  for (const mutation of ["create", "replay", "change", "decide", "freeze", "replenish"] as const) {
    for (const loss of ["role", "inactive", "session"] as const) {
      it(`${mutation} refuses ${loss} loss with no business/audit side effects`, async () => {
        const { db, client } = await createTestDb();
        try {
          const f = await fixture(db);
          await db.update(s.users).set(loss === "role" ? { roles: ["warehouse"] }
            : loss === "inactive" ? { active: false } : { sessionVersion: (f.pmc.sessionVersion ?? 0) + 1 })
            .where(eq(s.users.id, f.pmc.id));
          const before = await db.select().from(s.auditLogs);
          const operations = {
            create: () => createSopCycle(f.pmc, { ...f.input, month: "2099-01", idempotencyKey: crypto.randomUUID() }, db),
            replay: () => createSopCycle(f.pmc, f.input, db),
            change: () => changeSopPlan(f.pmc, { cycleId: f.cycle.id, version: 1, planningVersionId: f.nextPlan }, db),
            decide: () => decideSopCycle(f.pmc, { cycleId: f.cycle.id, version: 1, role: "pmc", decision: "agree" }, db),
            freeze: () => transitionSopCycle(f.pmc, { cycleId: f.cycle.id, version: 1, target: "frozen" }, db),
            replenish: () => createReplenishDraft(f.pmc, { items: [{ skuId: f.skuId, qty: "12.3456" }] }, db),
          };
          await expect(operations[mutation]()).rejects.toMatchObject({ status: loss === "session" ? 401 : 403 });
          expect(await db.select().from(s.auditLogs)).toEqual(before);
          expect(await db.select().from(s.sopDecisions)).toHaveLength(0);
          expect(await db.select().from(s.bhDocs)).toHaveLength(0);
          expect(await db.select().from(s.sopCycles)).toHaveLength(1);
          expect((await db.select().from(s.sopCycles))[0]).toMatchObject({ status: "consensus", version: 1, planningVersionId: f.input.planningVersionId });
        } finally { await client.close(); }
      });
    }
  }

  it("uses newly granted current roles, not stale caller roles, and never lets admin proxy a signature", async () => {
    const { db, client } = await createTestDb();
    try {
      const f = await fixture(db), stale = { ...f.pmc, roles: ["warehouse"] };
      await decideSopCycle(stale, { cycleId: f.cycle.id, version: 1, role: "pmc", decision: "agree" }, db);
      await db.update(s.users).set({ roles: ["admin"] }).where(eq(s.users.id, f.ops.id));
      await expect(decideSopCycle(f.ops, { cycleId: f.cycle.id, version: 1, role: "ops", decision: "agree" }, db)).rejects.toMatchObject({ status: 403 });
      expect(await db.select().from(s.sopDecisions)).toHaveLength(1);
      await changeSopPlan(stale, { cycleId: f.cycle.id, version: 1, planningVersionId: f.nextPlan }, db);
      expect((await db.select().from(s.sopCycles))[0].version).toBe(2);
    } finally { await client.close(); }
  });

  it("a live draft is atomic, blocked while frozen/executing, then permitted after closure", async () => {
    const { db, client } = await createTestDb();
    try {
      const f = await fixture(db), input = { items: [{ skuId: f.skuId, qty: "12.3456" }] };
      await createReplenishDraft(f.pmc, input, db);
      for (const [actor, role] of [[f.pmc, "pmc"], [f.ops, "ops"], [f.finance, "finance"]] as const) {
        await decideSopCycle(actor, { cycleId: f.cycle.id, version: 1, role, decision: "agree" }, db);
      }
      for (const target of ["frozen", "executing"] as const) {
        await transitionSopCycle(f.pmc, { cycleId: f.cycle.id, version: 1, target }, db);
        const before = await db.select().from(s.auditLogs);
        await expect(createReplenishDraft(f.pmc, input, db)).rejects.toThrow(/冻结版本开单/);
        expect(await db.select().from(s.auditLogs)).toEqual(before);
        expect(await db.select().from(s.bhDocs)).toHaveLength(1);
      }
      // Closure is a write too: a revoked planner must not reopen the live channel.
      await db.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, f.pmc.id));
      await expect(transitionSopCycle(f.pmc, { cycleId: f.cycle.id, version: 1, target: "closed" }, db)).rejects.toMatchObject({ status: 403 });
      await db.update(s.users).set({ roles: ["pmc"] }).where(eq(s.users.id, f.pmc.id));
      await transitionSopCycle(f.pmc, { cycleId: f.cycle.id, version: 1, target: "closed" }, db);
      await createReplenishDraft(f.pmc, input, db);
      expect((await db.select().from(s.bhLines)).map(l => l.qty)).toEqual(["12.3456", "12.3456"]);
      expect(await db.select().from(s.stockLedger)).toHaveLength(0);
    } finally { await client.close(); }
  });
});
