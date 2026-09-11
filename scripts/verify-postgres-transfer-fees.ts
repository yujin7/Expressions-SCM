/** Real lock proof. Only an explicitly opted-in, disposable loopback contract database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { addTransferFee, reverseTransferFee } from "@/server/modules/inventory/transfer-fees";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env);
  const key = randomUUID().slice(0, 8);
  const client = () => new pg.Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" });
  const a = client(), b = client(), control = client();
  try {
    await Promise.all([a.connect(), b.connect(), control.connect()]);
    const dbA = drizzle(a, { schema: s }), dbB = drizzle(b, { schema: s });
    const [u] = await dbA.insert(s.users).values({ name: `TF-QA-${key}`, roles: ["finance"] }).returning();
    const user = { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover };
    const [doc] = await dbA.insert(s.stockDocs).values({ docNo: `TF-QA-${key}`, subtype: "transfer", status: "approved", createdBy: u.id }).returning();
    const [{ pid }] = (await b.query<{ pid: number }>("select pg_backend_pid() pid")).rows;
    const waitForLock = async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if ((await control.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]?.wait_event_type === "Lock") return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error("Competing request never reached an actual PostgreSQL lock");
    };
    type Tx = Parameters<Parameters<typeof dbA.transaction>[0]>[0];
    const race = async <A, B>(first: (tx: Tx) => Promise<A>, second: () => Promise<B>) => {
      const ready = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
      const firstWrite = dbA.transaction(async tx => { const value = await first(tx); ready.resolve(); await gate.promise; return value; });
      await Promise.race([ready.promise, firstWrite.then(() => { throw Error("Commit barrier left early"); })]);
      const secondWrite = second().then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      try { await waitForLock(); } finally { gate.resolve(); }
      return { first: await firstWrite, second: await secondWrite };
    };
    const input = { stockDocId: doc.id, feeType: "freight", amount: "12.50", bizDate: "2026-09-11" };
    const closed = await race(tx => tx.update(s.stockDocs).set({ status: "closed" }).where(eq(s.stockDocs.id, doc.id)),
      () => addTransferFee(user, input, dbB));
    assert(!closed.second.ok); assert.equal(closed.second.error.status, 409);
    assert.equal((await dbA.select().from(s.transferFees).where(eq(s.transferFees.stockDocId, doc.id))).length, 0);
    console.log("PASS fee waits for concurrent close, then rejects with no fee");
    await dbA.update(s.stockDocs).set({ status: "approved" }).where(eq(s.stockDocs.id, doc.id));
    const fee = await race(tx => addTransferFee(user, input, tx),
      () => dbB.update(s.stockDocs).set({ status: "closed" }).where(eq(s.stockDocs.id, doc.id)));
    assert(fee.second.ok);
    console.log("PASS close waits for fee commit; no check-then-act window");
    const reversal = await race(tx => reverseTransferFee(user, { reversalOfId: fee.first.fee.id, reason: "契约测试" }, tx),
      () => reverseTransferFee(user, { reversalOfId: fee.first.fee.id, reason: "并发重试" }, dbB));
    assert(!reversal.second.ok); assert.equal(reversal.second.error.status, 409);
    assert.equal((await dbA.select().from(s.transferFees).where(eq(s.transferFees.reversalOfId, fee.first.fee.id))).length, 1);
    console.log("PASS concurrent reversal produces one red entry and a controlled 409, not a 500");
    console.log(JSON.stringify({ passed: true, cases: 3, fixture: key, database: new URL(connectionString).pathname.slice(1) }));
  } finally { await Promise.allSettled([a.end(), b.end(), control.end()]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
