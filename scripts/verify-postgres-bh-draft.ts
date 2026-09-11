/** Opt-in synthetic BH concurrency proof. Only a migrated, disposable loopback scm_contract_* DB. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { createBh, submitBh, updateBh } from "@/server/modules/outsource/bh";

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(process.env.SCM_ALLOW_MUTATING_PG_CONTRACT, "1", "Explicit opt-in required");
  assert(["postgres:", "postgresql:"].includes(url.protocol));
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert(/^\/scm_contract_[a-zA-Z0-9_]+$/.test(url.pathname) && !url.search && !url.hash, "Disposable contract DB only");
  const key = randomUUID().replace(/-/g, "").slice(0, 16);
  const client = (role: string) => new pg.Client({ connectionString: url.toString(), application_name: `bh-edit-${role}-${key}`,
    connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000 -c search_path=public" });
  const control = client("control"), a = client("a"), b = client("b");
  const dbA = drizzle(a, { schema: s }), dbB = drizzle(b, { schema: s });
  const fn = `bh_edit_fault_${key}`, trigger = `bh_edit_gate_${key}`;
  let installed = false;
  try {
    await Promise.all([control.connect(), a.connect(), b.connect()]);
    const [{ id: makerId }] = (await control.query<{ id: number }>("insert into users(name,roles) values($1,array['ops']) returning id", [`BH QA ${key}`])).rows;
    const maker = { id: makerId, name: "BH QA", roles: ["ops"], isApprover: false };
    const [{ id: spuId }] = (await control.query<{ id: number }>("insert into spus(code,name_cn) values($1,$1) returning id", [`BHQA-${key}`])).rows;
    const [{ id: skuId }] = (await control.query<{ id: number }>("insert into skus(code,name,spu_id,sku_type,base_uom) values($1,$1,$2,'finished','盒') returning id", [`BHQA-${key}`, spuId])).rows;
    const input = { version: 1, reason: "PostgreSQL并发契约", lines: [{ skuId, qty: "2.1250" }] };
    const draft = () => createBh(maker, { lines: [{ skuId, qty: "1.2500" }] }, dbA);
    const [{ pid: bPid }] = (await b.query<{ pid: number }>("select pg_backend_pid() pid")).rows;
    const blocked = async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const r = await control.query("select wait_event_type from pg_stat_activity where pid=$1", [bPid]);
        if (r.rows[0]?.wait_event_type === "Lock") return;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error("The competing write did not reach the real row lock");
    };
    for (const first of ["edit", "submit"] as const) {
      const doc = await draft();
      let ready!: () => void, release!: () => void;
      const arrived = new Promise<void>(r => { ready = r; });
      const gate = new Promise<void>(r => { release = r; });
      const firstWrite = dbA.transaction(async tx => {
        if (first === "edit") await updateBh(maker, doc.id, input, tx);
        else await submitBh(maker, doc.id, 1, tx);
        ready(); await gate;
      });
      // A is held after its document+audit mutation, but before COMMIT.
      await Promise.race([arrived, firstWrite.then(() => { throw new Error("First write exited before barrier"); })]);
      const secondWrite = (first === "edit" ? submitBh(maker, doc.id, 1, dbB) : updateBh(maker, doc.id, input, dbB))
        .then(() => ({ passed: true }), error => ({ passed: false, error }));
      try { await blocked(); } finally { release(); }
      await firstWrite;
      const second = await secondWrite;
      assert.equal(second.passed, false, "Competing stale write must not overwrite");
      if ("error" in second) assert.equal(second.error.status, 409);
      const [stored] = await dbA.select().from(s.bhDocs).where(eq(s.bhDocs.id, doc.id));
      const [line] = await dbA.select().from(s.bhLines).where(eq(s.bhLines.bhId, doc.id));
      assert.equal(stored.version, 2);
      assert.equal(stored.status, first === "edit" ? "draft" : "pending");
      assert.equal(line.qty, first === "edit" ? "2.1250" : "1.2500");
      const events = await dbA.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "bh"), eq(s.auditLogs.entityId, doc.id)));
      assert.deepEqual(events.map(e => e.action).sort(), ["create", first === "edit" ? "update_draft" : "submit"].sort());
      console.log(`PASS ${first} wins; competing write waits on row lock then rejects; identity/lines/audit stay coherent`);
    }
    // An actual PostgreSQL audit trigger failure must roll back both header and draft lines.
    const faultDoc = await draft();
    await control.query(`create function ${fn}() returns trigger language plpgsql as $$ begin
      if NEW.user_id = ${makerId} and NEW.entity = 'bh' and NEW.action in ('update_draft','submit') then
        raise exception 'BH deliberate audit failure'; end if; return NEW; end $$`);
    await control.query(`create trigger ${trigger} before insert on audit_logs for each row execute function ${fn}()`); installed = true;
    for (const action of ["edit", "submit"] as const) {
      await assert.rejects(action === "edit" ? updateBh(maker, faultDoc.id, input, dbA) : submitBh(maker, faultDoc.id, 1, dbA));
      const [doc] = await dbA.select().from(s.bhDocs).where(eq(s.bhDocs.id, faultDoc.id));
      const [line] = await dbA.select().from(s.bhLines).where(eq(s.bhLines.bhId, faultDoc.id));
      assert.equal(doc.status, "draft"); assert.equal(doc.version, 1); assert.equal(line.qty, "1.2500");
      console.log(`PASS ${action} audit failure rolls back in real PostgreSQL`);
    }
    console.log(JSON.stringify({ passed: true, cases: 4, fixture: key, database: url.pathname.slice(1) }));
  } finally {
    if (installed) await control.query(`drop trigger ${trigger} on audit_logs`);
    await control.query(`drop function if exists ${fn}()`);
    await Promise.all([control.end(), a.end(), b.end()]);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
