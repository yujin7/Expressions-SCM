/** Synthetic NPD write/replay proof. Never run against a business database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { createNpdFirstOrder, getNpdProject, updateNpdProject, updateNpdTask } from "@/server/modules/npd/service";

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(process.env.SCM_ALLOW_MUTATING_PG_CONTRACT, "1", "Explicit opt-in required");
  assert(["postgres:", "postgresql:"].includes(url.protocol));
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert(/^\/scm_contract_[a-zA-Z0-9_]+$/.test(url.pathname) && !url.search && !url.hash, "Disposable contract DB only");
  const key = randomUUID().replace(/-/g, "").slice(0, 16);
  const client = (role: string) => new pg.Client({ connectionString: url.href, application_name: `npd-${role}-${key}`,
    connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000 -c search_path=public" });
  const control = client("control"), a = client("a"), b = client("b");
  const dbA = drizzle(a, { schema: s }), dbB = drizzle(b, { schema: s });
  const fn = `npd_fault_${key}`, trigger = `npd_gate_${key}`;
  let functionInstalled = false, triggerInstalled = false;
  let cases = 0;
  const pass = (message: string) => { cases++; console.log(`PASS ${message}`); };
  try {
    await Promise.all([control.connect(), a.connect(), b.connect()]);
    const [person] = await dbA.insert(s.users).values({ name: `NPD QA ${key}`, roles: ["pmc"] }).returning();
    const actor = { id: person.id, name: person.name, roles: ["pmc"], isApprover: false };
    const [spu] = await dbA.insert(s.spus).values({ code: `NPDQA-${key}`, nameCn: "NPD契约" }).returning();
    const [sku] = await dbA.insert(s.skus).values({ code: `NPDQA-${key}`, spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
    const project = async () => {
      const [p] = await dbA.insert(s.npdProjects).values({ name: `QA-${key}`, skuCode: sku.code, startDate: "2026-09-01", createdBy: actor.id }).returning();
      const [task] = await dbA.insert(s.npdTasks).values({ projectId: p.id, seq: 1, name: "QA节点", days: 2, planStart: "2026-09-01", planEnd: "2026-09-03" }).returning();
      return { ...p, taskId: task.id };
    };
    const request = (projectId: number, requestKey = randomUUID()) => ({ projectId, version: 1, qty: "12.5000", requestKey });
    const [{ pid }] = (await b.query<{ pid: number }>("select pg_backend_pid() pid")).rows;
    const waitForLock = async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if ((await control.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]?.wait_event_type === "Lock") return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error("Competing request did not reach an actual PostgreSQL lock");
    };
    type Tx = Parameters<Parameters<typeof dbA.transaction>[0]>[0];
    const race = async <A, B>(first: (tx: Tx) => Promise<A>, second: () => Promise<B>) => {
      let ready!: () => void, release!: () => void;
      const arrived = new Promise<void>(r => { ready = r; });
      const gate = new Promise<void>(r => { release = r; });
      const firstWrite = dbA.transaction(async tx => { const result = await first(tx); ready(); await gate; return result; });
      await Promise.race([arrived, firstWrite.then(() => { throw Error("First write left its commit barrier early"); })]);
      const secondWrite = second().then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      try { await waitForLock(); } finally { release(); }
      return { first: await firstWrite, second: await secondWrite };
    };

    const same = await project(), sameInput = request(same.id);
    const replay = await race(tx => createNpdFirstOrder(actor, sameInput, tx), () => createNpdFirstOrder(actor, sameInput, dbB));
    assert(replay.second.ok); assert.equal(replay.second.value.id, replay.first.id); assert.equal(replay.second.value.replayed, true);
    assert.equal((await getNpdProject(same.id, dbA, actor)).firstOrders.length, 1);
    pass("same request waits, then returns one committed BH receipt");

    const distinct = await project();
    const conflict = await race(tx => createNpdFirstOrder(actor, request(distinct.id), tx), () => createNpdFirstOrder(actor, request(distinct.id), dbB));
    assert(!conflict.second.ok); assert.equal(conflict.second.error.status, 409);
    assert.equal((await getNpdProject(distinct.id, dbA, actor)).firstOrders.length, 1);
    pass("different requests at the same project version cannot both create drafts");

    const edited = await project();
    const close = await race(tx => updateNpdTask(actor, { taskId: edited.taskId, version: 1, status: "doing" }, tx),
      () => updateNpdProject(actor, { projectId: edited.id, version: 1, status: "cancelled" }, dbB));
    assert(!close.second.ok); assert.equal(close.second.error.status, 409);
    const afterEdit = await getNpdProject(edited.id, dbA, actor);
    assert.equal(afterEdit.project.status, "active"); assert.equal(afterEdit.project.version, 2); assert.equal(afterEdit.tasks[0].status, "doing");
    pass("a concurrent node update prevents stale project closure");

    const closed = await project();
    const order = await race(tx => updateNpdProject(actor, { projectId: closed.id, version: 1, status: "done" }, tx),
      () => createNpdFirstOrder(actor, request(closed.id), dbB));
    assert(!order.second.ok); assert.equal(order.second.error.status, 409);
    assert.equal((await getNpdProject(closed.id, dbA, actor)).firstOrders.length, 0);
    pass("a concurrent closure prevents a stale first order");

    const left = await project(), right = await project(), shared = randomUUID();
    const collision = await race(tx => createNpdFirstOrder(actor, request(left.id, shared), tx), () => createNpdFirstOrder(actor, request(right.id, shared), dbB));
    assert(!collision.second.ok); assert.equal(collision.second.error.status, 409);
    const rightState = await getNpdProject(right.id, dbA, actor);
    assert.equal(rightState.project.version, 1); assert.equal(rightState.firstOrders.length, 0);
    const docsBeforeFault = await dbA.select().from(s.bhDocs).where(eq(s.bhDocs.createdBy, actor.id));
    assert.equal(docsBeforeFault.length, 3, "A losing unique request must not leave an orphan BH");
    pass("same key on different projects rolls back the losing BH, receipt and version");

    await control.query(`create function ${fn}() returns trigger language plpgsql as $$ begin
      if NEW.user_id = ${actor.id} and NEW.entity = 'npd_project' and NEW.action = 'first_order_draft' then
        raise exception 'NPD deliberate audit failure'; end if; return NEW; end $$`); functionInstalled = true;
    await control.query(`create trigger ${trigger} before insert on audit_logs for each row execute function ${fn}()`); triggerInstalled = true;
    const fault = await project();
    await assert.rejects(createNpdFirstOrder(actor, request(fault.id), dbA));
    assert.equal((await getNpdProject(fault.id, dbA, actor)).project.version, 1);
    assert.equal((await dbA.select().from(s.bhDocs).where(eq(s.bhDocs.createdBy, actor.id))).length, 3);
    assert.equal((await dbA.select().from(s.npdFirstOrders).where(eq(s.npdFirstOrders.requestedBy, actor.id))).length, 3);
    pass("audit failure rolls back the complete first-order transaction");

    const [receipt] = await dbA.select().from(s.npdFirstOrders).where(eq(s.npdFirstOrders.projectId, same.id));
    for (const statement of ["update npd_first_orders set qty=1 where id=$1", "delete from npd_first_orders where id=$1", "truncate npd_first_orders"]) {
      await assert.rejects(control.query(statement, statement.includes("$1") ? [receipt.id] : []), { code: "55000" });
      pass(`immutable receipt rejects ${statement.split(" ")[0]}`);
    }
    console.log(JSON.stringify({ passed: true, cases, fixture: key, database: url.pathname.slice(1) }));
  } finally {
    try {
      if (triggerInstalled) await control.query(`drop trigger ${trigger} on audit_logs`);
      if (functionInstalled) await control.query(`drop function ${fn}()`);
    } finally { await Promise.allSettled([control.end(), a.end(), b.end()]); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
