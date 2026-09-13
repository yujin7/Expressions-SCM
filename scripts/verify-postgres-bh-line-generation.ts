/** Opt-in loopback scm_contract_* only. Synthetic source/receipt evidence is retained. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { generateWoFromBhLine } from "@/server/modules/outsource/auto-chain";
import { createWo } from "@/server/modules/outsource/wo";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function main() {
  const connectionString = reviewContractConnectionString(process.env), key = randomUUID().slice(0, 8);
  const client = () => new pg.Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" });
  const a = client(), b = client(), control = client();
  try {
    await Promise.all([a.connect(), b.connect(), control.connect()]);
    const db = drizzle(a, { schema: s }), otherDb = drizzle(b, { schema: s });
    const [u, v] = await db.insert(s.users).values([{ name: `BHLINE-${key}-A`, roles: ["pmc"] }, { name: `BHLINE-${key}-B`, roles: ["pmc"] }]).returning();
    const actor = { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion }, peer = { id: v.id, name: v.name, roles: v.roles, isApprover: v.isApprover, sessionVersion: v.sessionVersion };
    const [spu] = await db.insert(s.spus).values({ code: `BHLINE-${key}`, nameCn: "合成明细生成" }).returning();
    const [sku] = await db.insert(s.skus).values({ code: `BHLINE-${key}`, name: "合成成品", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
    const [supplier] = await db.insert(s.suppliers).values({ code: `BHLINE-${key}`, name: "合成加工厂" }).returning();
    await db.insert(s.boms).values({ productSkuId: sku.id, versionNo: "1", status: "active" });
    await db.insert(s.transitRefs).values({ kind: "oem_map", skuCode: sku.code, supplierId: supplier.id, sourceJobId: 1 });
    await db.insert(s.processingFeeRefs).values({ skuId: sku.id, supplierId: supplier.id, feeRate: "1.23", effectiveDate: "2020-01-01", source: "manual" });
    let seq = 0;
    const setup = async () => {
      const [bh] = await db.insert(s.bhDocs).values({ docNo: `BH-LINE-${key}-${++seq}`, createdBy: actor.id, status: "approved" }).returning();
      const lines = await db.insert(s.bhLines).values(["12.3456", "23.4567"].map(qty => ({ bhId: bh.id, skuId: sku.id, qty, expectDate: "2026-10-12" }))).returning();
      return { bh, input: { bhId: bh.id, bhLineId: lines[0].id, skuId: sku.id }, second: { bhId: bh.id, bhLineId: lines[1].id, skuId: sku.id } };
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
    const ledgerBefore = (await control.query("select count(*)::int n from stock_ledger")).rows[0].n;
    const same = await setup();
    const result = await race(tx => generateWoFromBhLine(actor, same.input, tx), () => generateWoFromBhLine(peer, same.input, otherDb));
    assert(result.second.ok); assert.equal(result.second.value.id, result.first.id); assert.equal(result.second.value.idempotent, true);
    assert.equal((await db.select().from(s.bhWoGenerations).where(eq(s.bhWoGenerations.bhLineId, same.input.bhLineId))).length, 1);
    assert.equal((await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "wo"), eq(s.auditLogs.entityId, result.first.id), eq(s.auditLogs.action, "create")))).length, 1);
    console.log("PASS same line / two actors waits and returns one WO + one receipt + one audit");
    const different = await setup();
    const split = await race(tx => generateWoFromBhLine(actor, different.input, tx), () => generateWoFromBhLine(peer, different.second, otherDb));
    assert(split.second.ok); assert.notEqual(split.first.id, split.second.value.id);
    const docs = await db.select().from(s.woDocs).where(eq(s.woDocs.bhId, different.bh.id)).orderBy(s.woDocs.id);
    assert.deepEqual(docs.map(d => d.qty), ["12.3456", "23.4567"]); assert(docs.every(d => d.status === "draft" && d.dueDate === "2026-10-12"));
    console.log("PASS different same-SKU source lines wait without merging or losing demand");
    const closed = await setup();
    const close = await race(async tx => { await tx.update(s.bhDocs).set({ status: "closed" }).where(eq(s.bhDocs.id, closed.bh.id)); }, () => generateWoFromBhLine(peer, closed.input, otherDb));
    assert(!close.second.ok); assert.equal(close.second.error.status, 409);
    assert.equal((await db.select().from(s.woDocs).where(eq(s.woDocs.bhId, closed.bh.id))).length, 0);
    console.log("PASS source closure commits first; waiting generation refuses without draft");
    const manual = await setup();
    const conflict = await race(tx => createWo(actor, { bhId: manual.bh.id, productSkuId: sku.id, supplierId: supplier.id, qty: "12.3456", feeRatePlan: "1.23" }, tx),
      () => generateWoFromBhLine(peer, manual.input, otherDb));
    assert(!conflict.second.ok); assert.equal(conflict.second.error.status, 409);
    assert.equal((await db.select().from(s.woDocs).where(eq(s.woDocs.bhId, manual.bh.id))).length, 1);
    console.log("PASS manual WO commits first; automatic generation refuses unallocated legacy source");
    const revoked = await setup();
    const revoke = await race(async tx => { await tx.update(s.users).set({ active: false }).where(eq(s.users.id, peer.id)); }, () => generateWoFromBhLine(peer, revoked.input, otherDb));
    assert(!revoke.second.ok); assert.equal(revoke.second.error.status, 403);
    assert.equal((await db.select().from(s.woDocs).where(eq(s.woDocs.bhId, revoked.bh.id))).length, 0);
    console.log("PASS actor revocation is rechecked after real lock wait");
    assert.equal((await control.query("select count(*)::int n from stock_ledger")).rows[0].n, ledgerBefore);
    console.log(`PASS 5/5; fixture ${key}; inventory ledger unchanged ${ledgerBefore}`);
  } finally { await Promise.allSettled([a.end(), b.end(), control.end()]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
