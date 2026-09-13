/** Isolated loopback scm_contract_* only; retain synthetic receipts and documents. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { createBhRequest, getBhCreateResult } from "@/server/modules/outsource/bh-create-request";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env), key = randomUUID().slice(0, 8);
  const client = () => new pg.Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" });
  const a = client(), b = client(), control = client();
  try {
    await Promise.all([a.connect(), b.connect(), control.connect()]);
    const db = drizzle(a, { schema: s }), other = drizzle(b, { schema: s });
    const [person] = await db.insert(s.users).values({ name: `BHREC-${key}`, roles: ["ops", "pmc"] }).returning();
    const actor = { id: person.id, name: person.name, roles: person.roles, isApprover: false, sessionVersion: person.sessionVersion };
    const [spu] = await db.insert(s.spus).values({ code: `BHREC-${key}`, nameCn: "合成备货恢复" }).returning();
    const [sku] = await db.insert(s.skus).values({ code: `BHREC-${key}`, name: "合成恢复精华", spuId: spu.id, skuType: "finished", baseUom: "瓶" }).returning();
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
    const input = () => ({ requestKey: randomUUID(), lines: [{ skuId: sku.id, qty: "12.3456" }] });
    for (const source of ["manual", "replenish"] as const) {
      const v = input();
      const same = await race(tx => createBhRequest(actor, v, source, tx), () => createBhRequest(actor, v, source, other));
      assert(same.second.ok); assert.deepEqual(same.second.value, same.first);
      console.log(`PASS ${source} same-key concurrent creation returns one original`);
      const changed = await race(tx => createBhRequest(actor, v, source, tx), () => createBhRequest(actor, { ...v, lines: [{ skuId: sku.id, qty: "99" }] }, source, other));
      assert(!changed.second.ok); assert.equal(changed.second.error.status, 409);
      console.log(`PASS ${source} changed intent waits and conflicts`);
      const fresh = input();
      const lookup = await race(tx => createBhRequest(actor, fresh, source, tx), () => getBhCreateResult(actor, fresh.requestKey, other));
      assert(lookup.second.ok); assert.deepEqual(lookup.second.value, lookup.first);
      console.log(`PASS ${source} lookup waits for commit, then finds original`);
    }
    const v = input(); await createBhRequest(actor, v, "manual", db);
    const revoked = await race(async tx => { await tx.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, actor.id)); }, () => createBhRequest(actor, v, "manual", other));
    assert(!revoked.second.ok); assert.equal(revoked.second.error.status, 403);
    await assert.rejects(getBhCreateResult(actor, v.requestKey, db), (error: { status?: number }) => error.status === 403);
    console.log("PASS replay waits for identity revocation; read also refuses stale roles");
    const docs = (await control.query("select d.id,d.doc_no,r.source,l.qty from bh_create_requests r join bh_docs d on d.id=r.bh_id join bh_lines l on l.bh_id=d.id where r.requested_by=$1 order by d.id", [actor.id])).rows;
    assert.equal(docs.length, 5); assert(docs.every(d => d.qty === "12.3456"));
    const audits = (await control.query("select action,count(*)::int n from audit_logs where entity='bh' and entity_id=any($1::int[]) group by action", [docs.map(d => d.id)])).rows;
    assert.deepEqual(audits, [{ action: "create", n: 5 }]);
    const sourceAudits = (await control.query("select count(*)::int n from audit_logs where entity='replenish' and entity_id=any($1::int[]) and action='draft_bh'", [docs.map(d => d.id)])).rows[0].n;
    assert.equal(sourceAudits, 2);
    const ledgerAfter = (await control.query("select count(*)::int n from stock_ledger")).rows[0].n; assert.equal(ledgerAfter, ledgerBefore);
    console.log(JSON.stringify({ fixture: key, actorId: actor.id, skuId: sku.id, docs, ledgerBefore, ledgerAfter, checks: 7, actualLockWaits: 7, retained: true }));
  } finally { await Promise.allSettled([a.end(), b.end(), control.end()]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
