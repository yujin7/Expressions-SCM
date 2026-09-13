/** Opt-in loopback scm_contract_* only; synthetic evidence is retained, no orders or posting. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { getCapacityCheck } from "@/server/modules/outsource/capacity-check";
import { attachCapacityCheck, getCapacityHandoffResult } from "@/server/modules/outsource/capacity-handoff";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env), fixture = randomUUID().slice(0, 8);
  const connection = () => new pg.Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" });
  const a = connection(), b = connection(), control = connection();
  try {
    await Promise.all([a.connect(), b.connect(), control.connect()]);
    const db = drizzle(a, { schema: s }), other = drizzle(b, { schema: s });
    const [person] = await db.insert(s.users).values({ name: `CAPAUTH-${fixture}`, roles: ["pmc"] }).returning();
    const actor = { id: person.id, name: person.name, roles: person.roles, isApprover: false, sessionVersion: person.sessionVersion };
    const [factory] = await db.insert(s.suppliers).values({ code: `CAPAUTH-${fixture}`, name: "合成产能厂", kinds: ["processor"], status: "qualified" }).returning();
    const [spu] = await db.insert(s.spus).values({ code: `CAPAUTH-${fixture}`, nameCn: "合成产能产品" }).returning();
    const [sku] = await db.insert(s.skus).values({ code: `CAPAUTH-${fixture}`, name: "合成产能精华", skuType: "finished", baseUom: "支", spuId: spu.id }).returning();
    const [alert] = await db.insert(s.systemAlerts).values({ category: "inventory_cover", title: "合成产能核对", status: "open", dedupeKey: `inventory_cover:${sku.id}` }).returning();
    const [item] = await db.insert(s.workItems).values({ title: "合成产能承接", assigneeId: actor.id, assignerId: actor.id, createdBy: actor.id,
      status: "open", sourceKind: "alert", sourceRef: String(alert.id) }).returning();
    const query = { skuId: sku.id, alertId: alert.id, supplierId: factory.id, dueDate: "2090-09-20", candidateQty: "1.0001" };
    const check = await getCapacityCheck(actor, query, db);
    const input = { ...query, workItemId: item.id, assigneeId: actor.id, evidenceKey: check.evidenceKey!, requestId: randomUUID(), note: "请核对实际可用产能，不是下单" };
    const pid = (await b.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0].pid;
    type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
    let waits = 0;
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
      assert(waited, "Second connection must reach a real PostgreSQL lock"); waits++; return result;
    };
    const ledgerBefore = (await control.query("select count(*)::int n from stock_ledger")).rows[0].n;
    const revoked = await race(async tx => { await tx.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, actor.id)); },
      () => attachCapacityCheck(input, actor, other));
    assert(!revoked.second.ok); assert.equal(revoked.second.error.status, 403);
    console.log("PASS revocation first: pending save waits then refuses");
    await db.update(s.users).set({ roles: ["pmc"] }).where(eq(s.users.id, actor.id));
    const saved = await race(tx => attachCapacityCheck(input, actor, tx),
      () => other.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, actor.id)));
    assert(saved.second.ok); assert.equal(saved.first.replayed, false);
    await assert.rejects(attachCapacityCheck(input, actor, db), (e: { status?: number }) => e.status === 403);
    console.log("PASS save first: holds identity through audit commit; subsequent replay refuses revoked role");
    await db.update(s.users).set({ roles: ["pmc"] }).where(eq(s.users.id, actor.id));
    const same = await race(tx => attachCapacityCheck(input, actor, tx), () => attachCapacityCheck(input, actor, other));
    assert(same.second.ok); assert.equal(same.second.value.eventId, saved.first.eventId); assert.equal(same.first.eventId, saved.first.eventId);
    console.log("PASS same request returns the original audit receipt once");
    const session = await race(async tx => { await tx.update(s.users).set({ sessionVersion: actor.sessionVersion + 1 }).where(eq(s.users.id, actor.id)); },
      () => attachCapacityCheck(input, actor, other));
    assert(!session.second.ok); assert.equal(session.second.error.status, 401);
    console.log("PASS session invalidation first: replay waits then requires login");
    await db.update(s.users).set({ sessionVersion: actor.sessionVersion }).where(eq(s.users.id, actor.id));
    const queryReceipt = { workItemId: item.id, requestId: input.requestId };
    const lookup = await race(tx => attachCapacityCheck(input, actor, tx), () => getCapacityHandoffResult(queryReceipt, actor, other));
    assert(lookup.second.ok); assert.equal(lookup.second.value.eventId, saved.first.eventId);
    console.log("PASS read-only recovery waits for the writer and finds the same receipt");
    const revokedLookup = await race(async tx => { await tx.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, actor.id)); },
      () => getCapacityHandoffResult(queryReceipt, actor, other));
    assert(!revokedLookup.second.ok); assert.equal(revokedLookup.second.error.status, 403);
    console.log("PASS recovery waits for current identity revocation and refuses");
    const audits = (await control.query("select id from audit_logs where entity='work_item' and entity_id=$1 and action='capacity_check'", [item.id])).rows;
    assert.equal(audits.length, 1); assert.equal(audits[0].id, saved.first.eventId);
    assert.deepEqual((await db.select().from(s.workItems).where(eq(s.workItems.id, item.id)))[0], item);
    assert.deepEqual((await db.select().from(s.systemAlerts).where(eq(s.systemAlerts.id, alert.id)))[0], alert);
    const ledgerAfter = (await control.query("select count(*)::int n from stock_ledger")).rows[0].n; assert.equal(ledgerAfter, ledgerBefore);
    console.log(JSON.stringify({ fixture, actorId: actor.id, itemId: item.id, alertId: alert.id, skuId: sku.id, eventId: saved.first.eventId,
      checks: 6, actualLockWaits: waits, audits: audits.length, ledgerBefore, ledgerAfter, retained: true }));
  } finally { await Promise.allSettled([a.end(), b.end(), control.end()]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
