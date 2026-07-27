import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  auditLogs,
  planningVersions,
  sopCycles,
  sopDecisions,
  users,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  assertLiveSuggestionsWritable,
  changeSopPlan,
  createSopCycle,
  decideSopCycle,
  getSopWorkspace,
  transitionSopCycle,
} from "@/server/modules/replenish/sop-cycle";
import { createTestDb, type TestDb } from "../helpers/db";

describe("C125 lean S&OP consensus, freeze, execute cycle", () => {
  let db: TestDb;
  let pmc: SessionUser;
  let ops: SessionUser;
  let finance: SessionUser;
  let admin: SessionUser;
  let plan1 = 0;
  let plan2 = 0;
  let cycleId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const people = await db.insert(users).values([
      { name: "SOP-PMC", roles: ["pmc"] },
      { name: "SOP-运营", roles: ["ops"] },
      { name: "SOP-财务", roles: ["finance"] },
      { name: "SOP-管理员", roles: ["admin"] },
    ]).returning();
    pmc = { id: people[0].id, name: people[0].name, roles: ["pmc"], isApprover: false };
    ops = { id: people[1].id, name: people[1].name, roles: ["ops"], isApprover: false };
    finance = { id: people[2].id, name: people[2].name, roles: ["finance"], isApprover: false };
    admin = { id: people[3].id, name: people[3].name, roles: ["admin"], isApprover: false };
    const plans = await db.insert(planningVersions).values([
      {
        name: "7月基线",
        weekStart: "2026-07-20",
        engineVersion: "test",
        parameters: {},
        sourceMeta: {},
        lineCount: 12,
        suggestedCount: 4,
        suppressedCount: 1,
        digest: "a".repeat(64),
        idempotencyKey: "sop-plan-1",
        createdBy: pmc.id,
      },
      {
        name: "7月修订",
        weekStart: "2026-07-27",
        engineVersion: "test",
        parameters: {},
        sourceMeta: {},
        lineCount: 13,
        suggestedCount: 5,
        suppressedCount: 1,
        digest: "b".repeat(64),
        idempotencyKey: "sop-plan-2",
        createdBy: pmc.id,
      },
    ]).returning();
    plan1 = plans[0].id;
    plan2 = plans[1].id;
  });

  it("creates one monthly cycle idempotently from an immutable plan", async () => {
    const input = {
      month: "2026-07",
      name: "2026年7月 数量计划",
      planningVersionId: plan1,
      idempotencyKey: "8e0e5084-26ee-47ee-940b-7ad4fd8a1513",
    };
    const first = await createSopCycle(pmc, input, db);
    const replay = await createSopCycle(pmc, input, db);
    cycleId = first.id;
    expect(replay.id).toBe(first.id);
    expect(first).toMatchObject({
      status: "consensus",
      planDigest: "a".repeat(64),
      version: 1,
      consensusReady: false,
    });
    await expect(createSopCycle(pmc, {
      ...input,
      idempotencyKey: "2b53fe60-6418-4fbc-9052-9802bd89b218",
    }, db)).rejects.toMatchObject({ status: 409 });
  });

  it("requires actual role holders and keeps decisions append-only", async () => {
    await expect(decideSopCycle(admin, {
      cycleId,
      version: 1,
      role: "finance",
      decision: "agree",
    }, db)).rejects.toMatchObject({ status: 403 });
    await expect(decideSopCycle(finance, {
      cycleId,
      version: 1,
      role: "finance",
      decision: "reject",
      note: "太短",
    }, db)).rejects.toMatchObject({ status: 400 });
    await decideSopCycle(ops, { cycleId, version: 1, role: "ops", decision: "agree" }, db);
    await decideSopCycle(pmc, { cycleId, version: 1, role: "pmc", decision: "agree" }, db);
    await decideSopCycle(finance, {
      cycleId,
      version: 1,
      role: "finance",
      decision: "reject",
      note: "财务确认尚缺资金口径",
    }, db);
    await decideSopCycle(finance, {
      cycleId,
      version: 1,
      role: "finance",
      decision: "agree",
      note: "数量计划可先执行",
    }, db);
    const workspace = await getSopWorkspace(finance, db);
    expect(workspace.cycles[0].consensusReady).toBe(true);
    expect(workspace.cycles[0].decisions.filter((item) => item.role === "finance")).toHaveLength(2);

    const [row] = await db.select().from(sopDecisions).limit(1);
    await expect(db.update(sopDecisions).set({ note: "篡改" }).where(eq(sopDecisions.id, row.id))).rejects.toMatchObject({
      cause: { code: "55000", message: expect.stringContaining("append-only") },
    });
    await expect(db.delete(sopDecisions).where(eq(sopDecisions.id, row.id))).rejects.toMatchObject({
      cause: { code: "55000", message: expect.stringContaining("append-only") },
    });
  });

  it("changing the source plan opens a new consensus round and invalidates old sign-offs", async () => {
    await changeSopPlan(pmc, { cycleId, version: 1, planningVersionId: plan2 }, db);
    const workspace = await getSopWorkspace(pmc, db);
    expect(workspace.cycles[0]).toMatchObject({
      version: 2,
      planningVersionId: plan2,
      planDigest: "b".repeat(64),
      consensusReady: false,
    });
    expect(workspace.cycles[0].decisions.every((item) => !item.current)).toBe(true);
    await expect(transitionSopCycle(pmc, {
      cycleId,
      version: 2,
      target: "frozen",
    }, db)).rejects.toMatchObject({ status: 409 });
  });

  it("freezes only after current three-party agreement, then executes and closes in order", async () => {
    await decideSopCycle(ops, { cycleId, version: 2, role: "ops", decision: "agree" }, db);
    await decideSopCycle(pmc, { cycleId, version: 2, role: "pmc", decision: "agree" }, db);
    await decideSopCycle(finance, { cycleId, version: 2, role: "finance", decision: "agree" }, db);
    await transitionSopCycle(pmc, { cycleId, version: 2, target: "frozen" }, db);
    await expect(assertLiveSuggestionsWritable(db, new Date("2026-07-27T04:00:00Z")))
      .rejects.toMatchObject({ status: 409 });
    await expect(transitionSopCycle(pmc, { cycleId, version: 2, target: "closed" }, db))
      .rejects.toMatchObject({ status: 409 });
    await transitionSopCycle(pmc, { cycleId, version: 2, target: "executing" }, db);
    await transitionSopCycle(pmc, { cycleId, version: 2, target: "closed" }, db);
    await expect(assertLiveSuggestionsWritable(db, new Date("2026-07-27T04:00:00Z"))).resolves.toBeUndefined();

    const [cycle] = await db.select().from(sopCycles).where(eq(sopCycles.id, cycleId));
    expect(cycle).toMatchObject({
      status: "closed",
      frozenBy: pmc.id,
      executingBy: pmc.id,
      closedBy: pmc.id,
    });
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "sop_cycle"));
    expect(audits.map((row) => row.action)).toEqual([
      "create",
      "change_plan",
      "frozen",
      "executing",
      "closed",
    ]);
  });

  it("enforces lifecycle, role, decision and reject-note invariants in the database", async () => {
    await expect(db.insert(sopCycles).values({
      month: "2026-13",
      name: "非法月份",
      planningVersionId: plan1,
      planDigest: "a".repeat(64),
      idempotencyKey: "bad-month",
      createdBy: pmc.id,
    })).rejects.toThrow();
    await expect(db.insert(sopDecisions).values({
      cycleId,
      cycleVersion: 2,
      role: "warehouse",
      decision: "agree",
      planDigest: "b".repeat(64),
      decidedBy: pmc.id,
    })).rejects.toThrow();
    await expect(db.insert(sopDecisions).values({
      cycleId,
      cycleVersion: 2,
      role: "pmc",
      decision: "reject",
      note: "短",
      planDigest: "b".repeat(64),
      decidedBy: pmc.id,
    })).rejects.toThrow();
  });

  it("replays concurrent creation with the same idempotency key", async () => {
    const input = {
      month: "2026-08",
      name: "2026年8月 数量计划",
      planningVersionId: plan2,
      idempotencyKey: "865b2330-3887-41ef-b4f8-8d8de1201a4e",
    };
    const [left, right] = await Promise.all([
      createSopCycle(pmc, input, db),
      createSopCycle(pmc, input, db),
    ]);
    expect(left.id).toBe(right.id);
    const rows = await db.select().from(sopCycles).where(eq(sopCycles.month, "2026-08"));
    expect(rows).toHaveLength(1);
  });
});
