/** Opt-in loopback contract: retain synthetic evidence, never change source alerts or stock. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { cancelWorkItemMutation, createWorkItem, getWorkItemMutationResult, patchWorkItem } from "@/server/modules/todo/service";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env), fixture = randomUUID().slice(0, 8);
  const connection = () => new pg.Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" });
  const a = connection(), b = connection(), control = connection();
  try {
    await Promise.all([a.connect(), b.connect(), control.connect()]);
    const db = drizzle(a, { schema: s }), other = drizzle(b, { schema: s });
    const [person] = await db.insert(s.users).values({ name: `TODOMUTATE-${fixture}`, roles: ["pmc"] }).returning();
    const actor = { id: person.id, name: person.name, roles: person.roles, isApprover: false, sessionVersion: person.sessionVersion };
    const task = async () => (await createWorkItem({ title: `TODOMUTATE-${fixture} 合成操作`, assigneeId: actor.id }, actor, db)).item;
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
    const row = await task(), input = { requestId: randomUUID(), expectedVersion: row.version, status: "done" as const };
    const replay = await race(tx => patchWorkItem(row.id, input, actor, tx), () => patchWorkItem(row.id, input, actor, other));
    assert(replay.second.ok); assert.equal(replay.first.replayed, false); assert.equal(replay.second.value.replayed, true);
    assert.deepEqual(replay.second.value.mutationReceipt, replay.first.mutationReceipt);
    console.log("PASS concurrent same-key completion changes once and returns one immutable receipt");
    const reopened = await race(tx => patchWorkItem(row.id, { status: "open" }, actor, tx), () => patchWorkItem(row.id, input, actor, other));
    assert(reopened.second.ok); assert.equal(reopened.second.value.status, "open"); assert.equal(reopened.second.value.version, 3);
    assert.equal(reopened.second.value.mutationReceipt?.originalResult.status, "done");
    console.log("PASS old completion waits for reopen and never closes the current task again");
    const lookupRow = await task(), lookupInput = { ...input, requestId: randomUUID(), expectedVersion: lookupRow.version };
    const lookup = await race(tx => patchWorkItem(lookupRow.id, lookupInput, actor, tx), () => getWorkItemMutationResult(lookupRow.id, lookupInput.requestId, actor, other));
    assert(lookup.second.ok); assert.deepEqual(lookup.second.value.receipt, lookup.first.mutationReceipt);
    console.log("PASS read-only lookup waits for the actual write commit");
    const competing = await task();
    const conflict = await race(tx => patchWorkItem(competing.id, { ...input, requestId: randomUUID(), expectedVersion: 1 }, actor, tx),
      () => patchWorkItem(competing.id, { requestId: randomUUID(), expectedVersion: 1, status: "in_progress" }, actor, other));
    assert(!conflict.second.ok); assert.equal(conflict.second.error.status, 409);
    console.log("PASS two different intents against one observed version cannot both mutate");
    const cancellation = () => ({ mode: "cancel-mutation" as const, requestId: randomUUID(), expectedVersion: 1, status: "done" as const, assigneeId: null, note: null });
    const cancelRow = await task(), cancelInput = cancellation();
    const fenced = await race(tx => cancelWorkItemMutation(cancelRow.id, cancelInput, actor, tx),
      () => patchWorkItem(cancelRow.id, { requestId: cancelInput.requestId, expectedVersion: 1, status: "done" }, actor, other));
    assert.equal(fenced.first.receipt?.cancelled, true); assert(!fenced.second.ok); assert.equal(fenced.second.error.status, 409);
    assert.equal(fenced.first.current.version, 1); assert.equal(fenced.first.current.status, "open");
    console.log("PASS cancellation commits before delayed PATCH, which waits then refuses without task changes");
    const saveRow = await task(), saveInput = cancellation();
    const saveWins = await race(tx => patchWorkItem(saveRow.id, { requestId: saveInput.requestId, expectedVersion: 1, status: "done" }, actor, tx),
      () => cancelWorkItemMutation(saveRow.id, saveInput, actor, other));
    assert(saveWins.second.ok); assert.deepEqual(saveWins.second.value.receipt, saveWins.first.mutationReceipt);
    assert.equal(saveWins.second.value.receipt?.cancelled, undefined); assert.equal(saveWins.second.value.current.status, "done");
    console.log("PASS committed save wins cancellation race and is never reversed");
    const duplicateRow = await task(), duplicateInput = cancellation();
    const duplicate = await race(tx => cancelWorkItemMutation(duplicateRow.id, duplicateInput, actor, tx),
      () => cancelWorkItemMutation(duplicateRow.id, duplicateInput, actor, other));
    assert(duplicate.second.ok); assert.deepEqual(duplicate.second.value, duplicate.first);
    console.log("PASS concurrent cancellations create one durable receipt");
    for (const operation of [() => getWorkItemMutationResult(row.id, input.requestId, actor, other), () => patchWorkItem(row.id, input, actor, other),
      () => cancelWorkItemMutation(duplicateRow.id, duplicateInput, actor, other)]) {
      await db.update(s.users).set({ active: true }).where(eq(s.users.id, actor.id));
      const denied = await race(async tx => { await tx.update(s.users).set({ active: false }).where(eq(s.users.id, actor.id)); }, operation);
      assert(!denied.second.ok); assert.equal(denied.second.error.status, 403);
    }
    await db.update(s.users).set({ active: true }).where(eq(s.users.id, actor.id));
    console.log("PASS current actor disable precedes replay and lookup after real lock waits");
    await assert.rejects(control.query(`insert into audit_logs(user_id, entity, entity_id, action, "after") values ($1,'work_item',$2,'update',$3::jsonb)`,
      [actor.id, row.id, JSON.stringify({ mutationRequestId: input.requestId.toUpperCase() })]), (e: unknown) => e instanceof Error && "code" in e && e.code === "23505");
    const receipts = (await control.query(`select id,entity_id,action from audit_logs where entity='work_item' and user_id=$1 and "after"->>'mutationRequestId' is not null order by id`, [actor.id])).rows;
    assert.equal(receipts.length, 6); assert.deepEqual(await counts(), before);
    console.log(JSON.stringify({ fixture, actorId: actor.id, checks: 11, actualLockWaits: waits, receipts, counts: before, retained: true }));
  } finally { await Promise.allSettled([a.end(), b.end(), control.end()]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
