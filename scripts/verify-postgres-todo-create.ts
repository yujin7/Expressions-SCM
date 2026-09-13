/** Opt-in loopback contract only. Retain synthetic users/tasks/audits; never change stock or source state. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { createWorkItem, getWorkItemCreationResult } from "@/server/modules/todo/service";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env), fixture = randomUUID().slice(0, 8);
  const connection = () => new pg.Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" });
  const a = connection(), b = connection(), control = connection();
  try {
    await Promise.all([a.connect(), b.connect(), control.connect()]);
    const db = drizzle(a, { schema: s }), other = drizzle(b, { schema: s });
    const [person] = await db.insert(s.users).values({ name: `TODOCREATE-${fixture}`, roles: ["pmc"] }).returning();
    const actor = { id: person.id, name: person.name, roles: person.roles, isApprover: false, sessionVersion: person.sessionVersion };
    const input = { title: `TODOCREATE-${fixture} 合成创建`, detail: "原始创建依据，不改变来源或库存", assigneeId: actor.id, requestId: randomUUID() };
    const pid = (await b.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0].pid;
    type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
    let waits = 0;
    const race = async <A, B>(first: (tx: Tx) => Promise<A>, second: () => Promise<B>) => {
      const ready = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
      const firstWrite = db.transaction(async tx => { const result = await first(tx); ready.resolve(); await gate.promise; return result; });
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
      assert(waited, "Second connection must reach a real PostgreSQL lock"); waits++; return result;
    };
    const counts = async () => (await control.query("select (select count(*)::int from stock_ledger) ledger, (select count(*)::int from system_alerts) alerts, (select count(*)::int from notifications) notifications")).rows[0];
    const before = await counts();
    const replay = await race(tx => createWorkItem(input, actor, tx), () => createWorkItem(input, actor, other));
    assert(replay.second.ok); assert.equal(replay.first.created, true); assert.equal(replay.second.value.created, false);
    assert.equal(replay.second.value.item.id, replay.first.item.id);
    console.log("PASS two concurrent creates serialize to one original task and audit");
    const lookupInput = { ...input, requestId: randomUUID() };
    const lookup = await race(tx => createWorkItem(lookupInput, actor, tx), () => getWorkItemCreationResult(lookupInput.requestId, actor, other));
    assert(lookup.second.ok); assert.equal(lookup.second.value.itemId, lookup.first.item.id); assert.equal(lookup.second.value.originalIntent?.title, input.title);
    assert.notEqual(lookup.first.item.id, replay.first.item.id);
    console.log("PASS GET waits for creation commit; intentional equal-content/new-key task is distinct");
    const conflictInput = { ...input, requestId: randomUUID() };
    const conflict = await race(tx => createWorkItem(conflictInput, actor, tx), () => createWorkItem({ ...conflictInput, title: "不得覆盖原任务" }, actor, other));
    assert(!conflict.second.ok); assert.equal(conflict.second.error.status, 409);
    console.log("PASS concurrent changed intent cannot overwrite the original request");
    for (const operation of [() => getWorkItemCreationResult(input.requestId, actor, other), () => createWorkItem(input, actor, other)]) {
      await db.update(s.users).set({ active: true }).where(eq(s.users.id, actor.id));
      const denied = await race(async tx => { await tx.update(s.users).set({ active: false }).where(eq(s.users.id, actor.id)); }, operation);
      assert(!denied.second.ok); assert.equal(denied.second.error.status, 403);
    }
    await db.update(s.users).set({ active: true }).where(eq(s.users.id, actor.id));
    console.log("PASS current identity disable precedes replay and result lookup after actual lock waits");
    await assert.rejects(control.query(`insert into audit_logs(user_id, entity, entity_id, action, "after") values ($1,'work_item',$2,'create',$3::jsonb)`,
      [actor.id, replay.first.item.id, JSON.stringify({ requestId: input.requestId.toUpperCase() })]), (e: unknown) => e instanceof Error && "code" in e && e.code === "23505");
    const events = (await control.query("select id,entity_id,action from audit_logs where entity='work_item' and user_id=$1 order by id", [actor.id])).rows;
    assert.equal(events.length, 3); assert(events.every(e => e.action === "create"));
    assert.equal((await db.select().from(s.workItems).where(eq(s.workItems.createdBy, actor.id))).length, 3);
    assert.deepEqual(await counts(), before);
    console.log(JSON.stringify({ fixture, actorId: actor.id, checks: 6, actualLockWaits: waits, audits: events, counts: before, retained: true }));
  } finally { await Promise.allSettled([a.end(), b.end(), control.end()]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
