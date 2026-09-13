/** Opt-in loopback scm_contract_* only; retain synthetic evidence, never mutate production. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { approveBh, createBh, submitBh, updateBh, withdrawBH } from "@/server/modules/outsource/bh";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env), key = randomUUID().slice(0, 8);
  const client = () => new pg.Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" });
  const a = client(), b = client(), control = client();
  try {
    await Promise.all([a.connect(), b.connect(), control.connect()]);
    const db = drizzle(a, { schema: s }), otherDb = drizzle(b, { schema: s });
    const people = await db.insert(s.users).values([
      { name: `BHWRITE-${key}-maker`, roles: ["ops"] },
      { name: `BHWRITE-${key}-checker`, roles: ["pmc"], isApprover: true },
      { name: `BHWRITE-${key}-peer`, roles: ["pmc"], isApprover: true },
    ]).returning();
    const [maker, checker, peer] = people.map(p => ({ id: p.id, name: p.name, roles: p.roles, isApprover: p.isApprover, sessionVersion: p.sessionVersion }));
    const [spu] = await db.insert(s.spus).values({ code: `BHWRITE-${key}`, nameCn: "合成备货资格" }).returning();
    const [sku] = await db.insert(s.skus).values({ code: `BHWRITE-${key}`, name: "合成精华", spuId: spu.id, skuType: "finished", baseUom: "瓶" }).returning();
    const payload = { lines: [{ skuId: sku.id, qty: "12.3456", expectDate: "2026-10-12" }] };
    const setup = async (pending = false) => {
      const doc = await createBh(maker, payload, db);
      if (pending) await submitBh(maker, doc.id, 1, db);
      return doc;
    };
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
    const stored = async (id: number) => (await db.select().from(s.bhDocs).where(eq(s.bhDocs.id, id)))[0];
    const ledgerBefore = (await control.query("select count(*)::int n from stock_ledger")).rows[0].n;
    const editing = await setup();
    const edit = await race(tx => updateBh(maker, editing.id, { ...payload, version: 1, reason: "核对数量", lines: [{ skuId: sku.id, qty: "23.4567" }] }, tx),
      () => submitBh(maker, editing.id, 1, otherDb));
    assert(!edit.second.ok); assert.equal(edit.second.error.status, 409);
    assert.equal((await stored(editing.id)).status, "draft"); assert.equal((await stored(editing.id)).version, 2);
    assert.equal((await db.select().from(s.bhLines).where(eq(s.bhLines.bhId, editing.id)))[0].qty, "23.4567");
    console.log("PASS edit commits first; stale submit waits then refuses without losing edited lines");
    const withdrawing = await setup(true);
    const approval = await race(tx => approveBh(checker, withdrawing.id, { version: 2, action: "approve" }, tx),
      () => withdrawBH(maker, withdrawing.id, { version: 2 }, otherDb));
    assert(!approval.second.ok); assert.equal(approval.second.error.status, 409);
    assert.equal((await stored(withdrawing.id)).status, "approved");
    console.log("PASS approval commits first; withdrawal waits then refuses without reopening source");
    const replaying = await setup(true);
    const replay = await race(tx => approveBh(checker, replaying.id, { version: 2, action: "approve" }, tx),
      () => approveBh(peer, replaying.id, { version: 2, action: "approve" }, otherDb));
    assert(replay.second.ok); assert.equal(replay.second.value.idempotent, true);
    assert.equal((await db.select().from(s.approvals).where(and(eq(s.approvals.docType, "bh"), eq(s.approvals.docId, replaying.id)))).length, 1);
    assert.equal((await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "bh"), eq(s.auditLogs.entityId, replaying.id), eq(s.auditLogs.action, "approve")))).length, 1);
    console.log("PASS two qualified approvers serialize and preserve one approval and audit");
    const revoking = await setup(true);
    const revoked = await race(async tx => { await tx.update(s.users).set({ isApprover: false }).where(eq(s.users.id, peer.id)); },
      () => approveBh(peer, revoking.id, { version: 2, action: "approve" }, otherDb));
    assert(!revoked.second.ok); assert.equal(revoked.second.error.status, 403);
    assert.equal((await stored(revoking.id)).status, "pending");
    console.log("PASS approval authority revoked first; waiter uses current role flag and rejects");
    const countBefore = (await db.select().from(s.bhDocs).where(eq(s.bhDocs.createdBy, maker.id))).length;
    const disabledSku = await race(async tx => { await tx.update(s.skus).set({ active: false }).where(eq(s.skus.id, sku.id)); },
      () => createBh(maker, payload, otherDb));
    assert(!disabledSku.second.ok); assert.equal(disabledSku.second.error.status, 400);
    assert.equal((await db.select().from(s.bhDocs).where(eq(s.bhDocs.createdBy, maker.id))).length, countBefore);
    console.log("PASS SKU disabled first; creation waits then rejects without draft");
    assert.equal((await control.query("select count(*)::int n from stock_ledger")).rows[0].n, ledgerBefore);
    console.log(`PASS 5/5; fixture ${key}; inventory ledger unchanged ${ledgerBefore}`);
  } finally { await Promise.allSettled([a.end(), b.end(), control.end()]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
