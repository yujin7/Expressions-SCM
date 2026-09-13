/** Opt-in isolated loopback scm_contract_* only. Requires an unused current month.
 * Retains synthetic documents and append-only evidence; never resets a business cycle.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import { shanghaiMonthOf } from "@/server/core/business-day";
import { changeSopPlan, createSopCycle, decideSopCycle, transitionSopCycle } from "@/server/modules/replenish/sop-cycle";
import { createReplenishDraft } from "@/server/modules/replenish/service";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env), key = randomUUID().slice(0, 8);
  const client = () => new pg.Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" });
  const a = client(), b = client(), control = client();
  try {
    await Promise.all([a.connect(), b.connect(), control.connect()]);
    const db = drizzle(a, { schema: s }), other = drizzle(b, { schema: s });
    const month = shanghaiMonthOf(new Date());
    assert.equal((await db.select().from(s.sopCycles).where(eq(s.sopCycles.month, month))).length, 0,
      "Current month already exists: use a fresh migrated isolated contract database; do not reset or delete it");
    const people = await db.insert(s.users).values([
      { name: `MODE-${key}-pmc`, roles: ["pmc"] }, { name: `MODE-${key}-ops`, roles: ["ops"] },
      { name: `MODE-${key}-finance`, roles: ["finance"] }, { name: `MODE-${key}-revoked`, roles: ["pmc"] },
    ]).returning();
    const [pmc, ops, finance, revoked] = people.map(p => ({ id: p.id, name: p.name, roles: p.roles, isApprover: false, sessionVersion: p.sessionVersion }));
    const [spu] = await db.insert(s.spus).values({ code: `MODE-${key}`, nameCn: "合成计划模式" }).returning();
    const [sku] = await db.insert(s.skus).values({ code: `MODE-${key}`, name: "合成精华", spuId: spu.id, skuType: "finished", baseUom: "瓶" }).returning();
    const [plan] = await db.insert(s.planningVersions).values({ name: `MODE-${key}`, weekStart: `${month}-01`, engineVersion: "qa", parameters: {}, sourceMeta: {}, lineCount: 0, suggestedCount: 0, suppressedCount: 0, digest: "c".repeat(64), idempotencyKey: randomUUID(), createdBy: pmc.id }).returning();
    const input = { month, name: `MODE-${key}`, planningVersionId: plan.id, idempotencyKey: randomUUID() };
    const cycle = await createSopCycle(pmc, input, db);
    for (const [actor, role] of [[pmc, "pmc"], [ops, "ops"], [finance, "finance"]] as const) {
      await decideSopCycle(actor, { cycleId: cycle.id, version: 1, role, decision: "agree" }, db);
    }
    const pid = (await b.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0].pid;
    type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
    const race = async <A, B>(first: (tx: Tx) => Promise<A>, second: () => Promise<B>) => {
      const ready = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
      const firstWrite = db.transaction(async tx => { const value = await first(tx); ready.resolve(); await gate.promise; return value; });
      await Promise.race([ready.promise, firstWrite.then(() => { throw Error("Commit barrier left early"); })]);
      const secondWrite = second().then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      let waited = false;
      try {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          if ((await control.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]?.wait_event_type === "Lock") { waited = true; break; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      } finally { gate.resolve(); }
      const result = { first: await firstWrite, second: await secondWrite };
      assert(waited, "Second connection must reach an actual PostgreSQL lock"); return result;
    };
    const ledgerBefore = (await control.query("select count(*)::int n from stock_ledger")).rows[0].n;
    const liveInput = { items: [{ skuId: sku.id, qty: "12.3456" }] };
    const freezeInput = { cycleId: cycle.id, version: 1, target: "frozen" };
    const rollback = new Error("deliberate outer transaction rollback after successful freeze");
    const liveFirst = await race(tx => createReplenishDraft(pmc, liveInput, tx), () => other.transaction(async tx => {
      await transitionSopCycle(pmc, freezeInput, tx);
      throw rollback;
    }));
    assert(!liveFirst.second.ok); assert.equal(liveFirst.second.error, rollback);
    assert.equal((await db.select().from(s.sopCycles).where(eq(s.sopCycles.id, cycle.id)))[0].status, "consensus");
    assert.equal((await control.query("select count(*)::int n from audit_logs where entity='sop_cycle' and entity_id=$1 and action='frozen'", [cycle.id])).rows[0].n, 0);
    console.log("PASS live BH wins; freeze really waits; aborted freeze rolls back its state and audit");

    const freezeFirst = await race(tx => transitionSopCycle(pmc, freezeInput, tx), () => createReplenishDraft(pmc, liveInput, other));
    assert(!freezeFirst.second.ok); assert.equal(freezeFirst.second.error.status, 409);
    console.log("PASS freeze commits first; waiting live request refuses without creating another BH");
    await transitionSopCycle(pmc, { ...freezeInput, target: "executing" }, db);
    const closeFirst = await race(tx => transitionSopCycle(pmc, { ...freezeInput, target: "closed" }, tx), () => createReplenishDraft(pmc, liveInput, other));
    assert(closeFirst.second.ok);
    console.log("PASS closure holds the mode until commit; waiting live request then creates exactly one BH");

    // A different month must not lock the current-month channel.
    const otherMonth = month === "2099-12" ? "2099-11" : "2099-12";
    await a.query("BEGIN");
    try {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('sop-month-mode'), hashtext(${otherMonth}))`);
      await createReplenishDraft(pmc, liveInput, other);
    } finally { await a.query("ROLLBACK"); }
    console.log("PASS a different month's held mode lock does not block current-month replenishment");

    const operations: Record<string, () => Promise<unknown>> = {
      create: () => createSopCycle(revoked, { ...input, month: otherMonth, idempotencyKey: randomUUID() }, other),
      replay: () => createSopCycle(pmc, input, other),
      change: () => changeSopPlan(revoked, { cycleId: cycle.id, version: 1, planningVersionId: plan.id }, other),
      decide: () => decideSopCycle(revoked, { cycleId: cycle.id, version: 1, role: "pmc", decision: "agree" }, other),
      transition: () => transitionSopCycle(revoked, freezeInput, other),
      live: () => createReplenishDraft(revoked, liveInput, other),
    };
    for (const [name, operation] of Object.entries(operations)) {
      const actor = name === "replay" ? pmc : revoked;
      const result = await race(async tx => { await tx.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, actor.id)); }, operation);
      assert(!result.second.ok); assert.equal(result.second.error.status, 403);
      console.log(`PASS ${name} waits for current identity and refuses after role revocation commits`);
    }
    const docs = await control.query("select id, status from bh_docs where created_by=$1", [pmc.id]);
    assert.equal(docs.rows.length, 3); assert(docs.rows.every(r => r.status === "draft"));
    assert.equal((await control.query("select count(*)::int n from bh_lines where bh_id=any($1::int[]) and qty=12.3456", [docs.rows.map(r => r.id)])).rows[0].n, 3);
    assert.equal((await control.query("select count(*)::int n from audit_logs where entity='bh' and action='create' and user_id=$1", [pmc.id])).rows[0].n, 3);
    assert.equal((await control.query("select count(*)::int n from audit_logs where entity='replenish' and action='draft_bh' and user_id=$1", [pmc.id])).rows[0].n, 3);
    assert.equal((await control.query("select count(*)::int n from stock_ledger")).rows[0].n, ledgerBefore);
    console.log(`PASS 10/10; fixture ${key}; cycle ${cycle.id}; three exact draft receipts; inventory ledger unchanged ${ledgerBefore}`);
  } finally { await Promise.allSettled([a.end(), b.end(), control.end()]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
