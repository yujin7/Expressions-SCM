/** Opt-in, isolated loopback scm_contract_* only. Synthetic cycles/audits are retained. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { createSopCycle, changeSopPlan, getSopCycleCreationResult } from "@/server/modules/replenish/sop-cycle";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env), fixture = randomUUID().slice(0, 8);
  const client = () => new pg.Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" });
  const a = client(), b = client(), control = client();
  try {
    await Promise.all([a.connect(), b.connect(), control.connect()]);
    const db = drizzle(a, { schema: s }), other = drizzle(b, { schema: s });
    const [person] = await db.insert(s.users).values({ name: `SOPCREATE-${fixture}`, roles: ["pmc"] }).returning();
    const actor = { id: person.id, name: person.name, roles: person.roles, isApprover: false, sessionVersion: person.sessionVersion };
    const plans = await db.insert(s.planningVersions).values(["a", "b"].map(d => ({ name: `SOPCREATE-${fixture}-${d}`, weekStart: "2026-09-01",
      engineVersion: "qa", parameters: {}, sourceMeta: {}, lineCount: 0, suggestedCount: 0, suppressedCount: 0,
      digest: d.repeat(64), idempotencyKey: randomUUID(), createdBy: actor.id }))).returning();
    let year = 3000 + parseInt(fixture, 16) % 5000;
    while ((await control.query("select 1 from sop_cycles where month like $1 limit 1", [`${year}-%`])).rowCount) year++;
    assert(year < 9999, "No free synthetic year");
    const input = (month: number) => ({ month: `${year}-${String(month).padStart(2, "0")}`, name: `合成创建-${fixture}`, planningVersionId: plans[0].id, idempotencyKey: randomUUID() });
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
    const firstInput = input(1);
    const same = await race(tx => createSopCycle(actor, firstInput, tx), () => createSopCycle(actor, { ...firstInput, idempotencyKey: firstInput.idempotencyKey.toUpperCase() }, other));
    assert(same.second.ok); assert.equal(same.first.id, same.second.value.id);
    console.log("PASS case-normalized concurrent same-key creation returns original");
    const changed = await race(tx => createSopCycle(actor, firstInput, tx), () => createSopCycle(actor, { ...firstInput, name: "不同请求" }, other));
    assert(!changed.second.ok); assert.equal(changed.second.error.status, 409);
    console.log("PASS changed original intent waits then conflicts");
    const secondInput = input(2);
    const lookup = await race(tx => createSopCycle(actor, secondInput, tx), () => getSopCycleCreationResult(actor, secondInput.idempotencyKey, other));
    assert(lookup.second.ok); assert.equal(lookup.second.value.cycle?.id, lookup.first.id);
    console.log("PASS read-only lookup waits for original commit");
    await changeSopPlan(actor, { cycleId: same.first.id, version: 1, planningVersionId: plans[1].id }, db);
    const replay = await createSopCycle(actor, firstInput, db);
    assert.equal(replay.planningVersionId, plans[1].id);
    assert.equal((await getSopCycleCreationResult(actor, firstInput.idempotencyKey, db)).originalIntent?.planningVersionId, plans[0].id);
    console.log("PASS legitimate plan change preserves original creation evidence");
    const revoked = await race(async tx => { await tx.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, actor.id)); }, () => createSopCycle(actor, firstInput, other));
    assert(!revoked.second.ok); assert.equal(revoked.second.error.status, 403);
    await assert.rejects(getSopCycleCreationResult(actor, firstInput.idempotencyKey, db), (error: { status?: number }) => error.status === 403);
    console.log("PASS replay waits for identity revocation; lookup also refuses");
    const cycles = (await control.query("select id,month,version,planning_version_id from sop_cycles where created_by=$1 order by id", [actor.id])).rows;
    assert.equal(cycles.length, 2);
    const audits = (await control.query("select action,count(*)::int n from audit_logs where entity='sop_cycle' and entity_id=any($1::int[]) group by action order by action", [cycles.map(c => c.id)])).rows;
    assert.deepEqual(audits, [{ action: "change_plan", n: 1 }, { action: "create", n: 2 }]);
    const ledgerAfter = (await control.query("select count(*)::int n from stock_ledger")).rows[0].n; assert.equal(ledgerAfter, ledgerBefore);
    console.log(JSON.stringify({ fixture, actorId: actor.id, cycles, audits, checks: 5, actualLockWaits: 4, ledgerBefore, ledgerAfter, retained: true }));
  } finally { await Promise.allSettled([a.end(), b.end(), control.end()]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
