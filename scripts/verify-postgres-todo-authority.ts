/** Explicitly opted-in loopback contract DB only. Synthetic tasks/audits retained; no stock or source closure. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { createWorkItem, patchWorkItem } from "@/server/modules/todo/service";
import { appendWorkItemNote, listWorkItemHistory } from "@/server/modules/todo/history";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env), fixture = randomUUID().slice(0, 8);
  const connection = () => new pg.Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" });
  const a = connection(), b = connection(), control = connection();
  try {
    await Promise.all([a.connect(), b.connect(), control.connect()]);
    const db = drizzle(a, { schema: s }), other = drizzle(b, { schema: s });
    const [person] = await db.insert(s.users).values({ name: `TODOAUTH-${fixture}`, roles: ["admin"] }).returning();
    const actor = { id: person.id, name: person.name, roles: person.roles, isApprover: false, sessionVersion: person.sessionVersion };
    const { item } = await createWorkItem({ title: `TODOAUTH-${fixture} 合成待办`, assigneeId: actor.id }, actor, db);
    const input = { note: "合成核对实际交期与负责人，不改变来源或库存", requestId: randomUUID() };
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
    const operations: Array<() => Promise<unknown>> = [
      () => createWorkItem({ title: "不得创建的合成待办", assigneeId: actor.id }, actor, other),
      () => patchWorkItem(item.id, { status: "done" }, actor, other),
      () => appendWorkItemNote(item.id, input, actor, other),
      () => listWorkItemHistory(item.id, {}, actor, other),
    ];
    for (const [i, operation] of operations.entries()) {
      await db.update(s.users).set({ active: true }).where(eq(s.users.id, actor.id));
      const result = await race(async tx => { await tx.update(s.users).set({ active: false }).where(eq(s.users.id, actor.id)); }, operation);
      assert(!result.second.ok); assert.equal(result.second.error.status, 403);
      console.log(`PASS disabled identity first: operation ${i + 1} waits then refuses`);
    }
    await db.update(s.users).set({ active: true }).where(eq(s.users.id, actor.id));
    const changed = await race(tx => patchWorkItem(item.id, { status: "in_progress" }, actor, tx),
      () => other.update(s.users).set({ active: false }).where(eq(s.users.id, actor.id)));
    assert(changed.second.ok); assert.equal(changed.first.status, "in_progress");
    console.log("PASS status first: identity disable waits for atomic status/audit commit");
    await db.update(s.users).set({ active: true }).where(eq(s.users.id, actor.id));
    const note = await race(tx => appendWorkItemNote(item.id, input, actor, tx),
      () => other.update(s.users).set({ active: false }).where(eq(s.users.id, actor.id)));
    assert(note.second.ok); assert.equal(note.first.replayed, false);
    console.log("PASS note first: identity disable waits for audit commit");
    await db.update(s.users).set({ active: true }).where(eq(s.users.id, actor.id));
    const replay = await race(tx => appendWorkItemNote(item.id, input, actor, tx), () => appendWorkItemNote(item.id, input, actor, other));
    assert(replay.second.ok); assert.equal(replay.second.value.eventId, note.first.eventId); assert.equal(replay.first.eventId, note.first.eventId);
    const events = (await control.query("select id,action from audit_logs where entity='work_item' and entity_id=$1 order by id", [item.id])).rows;
    assert.deepEqual(events.map(e => e.action), ["create", "update", "follow_up"]);
    const [current] = await db.select().from(s.workItems).where(eq(s.workItems.id, item.id));
    assert.equal(current.status, "in_progress"); assert.equal(current.completedAt, null);
    assert.equal((await db.select().from(s.workItems).where(eq(s.workItems.createdBy, actor.id))).length, 1);
    assert.deepEqual(await counts(), before);
    console.log(JSON.stringify({ fixture, actorId: actor.id, itemId: item.id, eventId: note.first.eventId,
      checks: 7, actualLockWaits: waits, audits: events, counts: before, retained: true }));
  } finally { await Promise.allSettled([a.end(), b.end(), control.end()]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
