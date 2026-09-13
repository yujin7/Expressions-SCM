/** Opt-in proof on a migrated, disposable loopback scm_contract_* database.
 * Synthetic master records, drafts and append-only audit evidence are retained.
 * No production environment loading, ledger writes, DDL or business-data cleanup.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import type { AnyDb } from "@/server/core/svc";
import type { SessionUser } from "@/server/core/dto";
import { createStockDoc } from "@/server/modules/inventory/stock-doc";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

async function waitUntil(label: string, check: () => Promise<boolean>) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error(`Timed out: ${label}`);
}

async function main() {
  const connectionString = reviewContractConnectionString(process.env);
  const key = `stock-ref-${randomUUID().slice(0, 8)}`;
  const client = (role: string) => new pg.Client({ connectionString, application_name: `${key}-${role}`,
    connectionTimeoutMillis: 5_000, query_timeout: 20_000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000" });
  const control = client("control"), creator = client("creator"), editor = client("editor");
  const pending: Promise<unknown>[] = [];
  const evidence: string[] = [];
  try {
    await Promise.all([control.connect(), creator.connect(), editor.connect()]);
    const db = drizzle(creator, { schema });
    const ids = await Promise.all([creator, editor, control].map(async c => (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid));
    const blocked = async (waiter: number, blocker: number) => {
      await control.query("select pg_stat_clear_snapshot()");
      return (await control.query<{ blocked: boolean }>("select $1::int = any(pg_blocking_pids($2::int)) as blocked", [blocker, waiter])).rows[0].blocked;
    };
    const [u] = await db.insert(schema.users).values({ name: key, roles: ["warehouse"] }).returning();
    const actor: SessionUser = { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion };
    const [spu] = await db.insert(schema.spus).values({ code: key, nameCn: key }).returning();
    const snapshot = async () => (await control.query(`select
      (select count(*)::int from stock_docs where created_by=$1) as docs,
      (select count(*)::int from stock_doc_lines where stock_doc_id in (select id from stock_docs where created_by=$1)) as lines,
      (select count(*)::int from audit_logs where user_id=$1) as audits,
      (select count(*)::int from stock_ledger where sku_id in (select id from skus where spu_id=$2)) as ledger,
      (select coalesce(jsonb_agg(to_jsonb(c) order by prefix, biz_date), '[]'::jsonb) from doc_counters c) as counters`, [actor.id, spu.id])).rows[0];
    let seq = 0;
    for (const reason of ["source-disabled", "source-snapshot", "target-disabled", "target-snapshot", "sku-disabled", "disposal-closed"]) {
      for (const order of ["edit-first", "create-first"]) {
        const fixtureKey = `${key}-${++seq}`;
        const [sku] = await db.insert(schema.skus).values({ code: fixtureKey, name: fixtureKey, spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning();
        const wh = await db.insert(schema.warehouses).values(["a", "b"].map(suffix => ({ code: `${fixtureKey}-${suffix}`, name: fixtureKey,
          kind: "raw" as const, accountingMode: "realtime" as const }))).returning();
        const isTarget = reason.startsWith("target");
        const input: Record<string, unknown> = { subtype: isTarget ? "transfer" : "opening", warehouseId: wh[0].id,
          ...(isTarget ? { toWarehouseId: wh[1].id, transferType: "inter_warehouse" } : {}), lines: [{ skuId: sku.id, qty: "0.0001" }] };
        let editSql = reason === "sku-disabled" ? "update skus set active=false where id=$1"
          : reason.endsWith("snapshot") ? "update warehouses set accounting_mode='snapshot', kind='snapshot' where id=$1"
            : "update warehouses set active=false where id=$1";
        let editId = reason === "sku-disabled" ? sku.id : wh[isTarget ? 1 : 0].id;
        if (reason === "disposal-closed") {
          const [review] = await db.insert(schema.reviewItems).values({ category: "risk_disposal", refKey: sku.code,
            title: `处置决定：报废评审 ${sku.code}` }).returning();
          Object.assign(input, { subtype: "issue_out", riskDisposalId: review.id });
          editSql = "update review_items set status='done' where id=$1";
          editId = review.id;
        }
        const before = await snapshot();
        if (order === "edit-first") {
          await editor.query("begin");
          await editor.query(editSql, [editId]);
          const create = createStockDoc(actor, input, db);
          pending.push(create); void create.catch(() => undefined);
          await waitUntil(`${reason}: creator waits for editor`, () => blocked(ids[0], ids[1]));
          assert.deepEqual(await snapshot(), before, "waiting must not expose a partial document");
          await editor.query("commit");
          await assert.rejects(create, (error: unknown) => (error as { status?: number }).status === (reason === "disposal-closed" ? 409 : 400));
          assert.deepEqual(await snapshot(), before, "rejection must not consume a document number or write facts");
        } else {
          // Hold the real service transaction after its audit write, before COMMIT.
          // No service result or SQL response is mocked.
          await control.query("begin");
          await control.query("select pg_advisory_xact_lock(hashtext($1))", [fixtureKey]);
          const heldDb = new Proxy(db, { get(target, property, receiver) {
            if (property === "transaction") return (callback: (tx: AnyDb) => Promise<unknown>) => target.transaction(async tx => {
              const result = await callback(tx);
              await creator.query("select pg_advisory_xact_lock(hashtext($1))", [fixtureKey]);
              return result;
            });
            return Reflect.get(target, property, receiver);
          } });
          const create = createStockDoc(actor, input, heldDb);
          pending.push(create); void create.catch(() => undefined);
          await waitUntil(`${reason}: creator reached pre-commit gate`, () => blocked(ids[0], ids[2]));
          const edit = editor.query(editSql, [editId]);
          pending.push(edit); void edit.catch(() => undefined);
          await waitUntil(`${reason}: editor waits for creation`, () => blocked(ids[1], ids[0]));
          assert.deepEqual(await snapshot(), before);
          await control.query("commit");
          const [doc] = await Promise.all([create, edit]);
          assert.equal(doc.status, "draft");
          const after = await snapshot();
          assert.equal(after.docs, before.docs + 1);
          assert.equal(after.lines, before.lines + 1);
          assert.equal(after.audits, before.audits + 1);
          assert.equal(after.ledger, before.ledger, "draft creation must never post inventory");
        }
        evidence.push(`${reason}/${order}: PASS`);
      }
    }
    console.log(JSON.stringify({ fixture: key, actorId: actor.id, evidence, final: await snapshot() }, null, 2));
  } finally {
    await Promise.allSettled([control.query("rollback"), editor.query("rollback")]);
    await Promise.allSettled(pending);
    await Promise.allSettled([creator.end(), editor.end(), control.end()]);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
