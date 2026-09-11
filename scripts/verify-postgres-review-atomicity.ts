/**
 * Opt-in, mutating PostgreSQL contract for review decision/audit atomicity and row locks.
 * Run only against a migrated disposable scm_contract_* database on loopback. No .env loading.
 * Synthetic users, review rows and append-only audit evidence are deliberately retained;
 * only this invocation's uniquely named fault-injection trigger/function are removed.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";

export function reviewContractConnectionString(env: Record<string, string | undefined>): string {
  if (env.SCM_ALLOW_MUTATING_PG_CONTRACT !== "1") {
    throw new Error("Refusing mutating PostgreSQL proof without SCM_ALLOW_MUTATING_PG_CONTRACT=1");
  }
  const value = env.DATABASE_URL?.trim();
  let url: URL;
  try { url = new URL(value ?? ""); } catch { throw new Error("A PostgreSQL contract DATABASE_URL is required"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.search || url.hash) {
    throw new Error("Review PostgreSQL proof requires loopback PostgreSQL without URL overrides");
  }
  if (!/^\/scm_contract_[a-zA-Z0-9_]+$/.test(url.pathname)) {
    throw new Error("Review PostgreSQL proof requires a disposable scm_contract_* database");
  }
  return value!;
}

async function waitUntil(label: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const FAULT_MESSAGE = "review contract audit deliberately rejected";
function isAuditFault(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
    if (cause.message.includes(FAULT_MESSAGE)) return true;
    cause = cause.cause;
  }
  return false;
}

interface AuditRow {
  id: number;
  user_id: number;
  entity_id: number | null;
  action: string;
  before: { status: string; note: string | null } | null;
  after: { status: string; note: string | null; ids?: number[] };
}

export async function verifyPostgresReviewAtomicity(): Promise<void> {
  // Gate before loading the application or creating any client. Never load local environment files.
  const connectionString = reviewContractConnectionString(process.env);
  const [{ drizzle }, schema, { decideReviewItem, bulkDecideReviewItems }] = await Promise.all([
    import("drizzle-orm/node-postgres"),
    import("@/db/schema"),
    import("@/server/modules/review/checklist"),
  ]);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 16);
  const trigger = `scm_review_audit_gate_${suffix}`;
  const fn = `scm_review_audit_fault_${suffix}`;
  const gate = `review-contract-${suffix}`;
  const client = (role: string) => new pg.Client({
    connectionString,
    application_name: `scm-review-${role}-${suffix}`,
    connectionTimeoutMillis: 5_000,
    query_timeout: 20_000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000 -c search_path=public",
  });
  const controller = client("control");
  const connectionA = client("a");
  const connectionB = client("b");
  const dbA = drizzle(connectionA, { schema });
  const dbB = drizzle(connectionB, { schema });
  let controllerOpen = false;
  let functionCreated = false;
  let triggerCreated = false;
  let guardBefore: { oid: number; name: string; enabled: string; definition: string; function_name: string }[] | undefined;
  const pending: Promise<unknown>[] = [];
  const failures: unknown[] = [];
  const guards = () => controller.query<NonNullable<typeof guardBefore>[number]>(
    `select t.oid, t.tgname as name, t.tgenabled as enabled,
            pg_get_triggerdef(t.oid) as definition, p.proname as function_name
       from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where t.tgrelid = 'public.audit_logs'::regclass and not t.tgisinternal
      order by t.tgname`,
  );
  const rows = (ids: number[]) => controller.query(
    `select id, status, note, decided_by, decided_at from public.review_items
      where id = any($1::int[]) order by id`, [ids],
  );

  try {
    await Promise.all([controller.connect(), connectionA.connect(), connectionB.connect()]);
    guardBefore = (await guards()).rows;
    assert.ok(guardBefore.some((guard) => guard.function_name === "reject_immutable_fact_mutation"
      && ["O", "A"].includes(guard.enabled)), "Migrated audit append-only protection must be enabled");

    const actors = await controller.query<{ id: number; name: string }>(
      `insert into public.users(username, name, roles)
       values ($1, $2, array['pmc']::text[]), ($3, $4, array['pmc']::text[]), ($5, $6, array['pmc']::text[])
       returning id, name`,
      ["a", "b", "fault"].flatMap((role) => [`pg-review-${role}-${suffix}`, `PG review ${role} ${suffix}`]),
    );
    const [actorA, actorB, faultActor] = actors.rows.map((row) => ({ ...row, roles: ["pmc"] }));
    assert.ok(actorA && actorB && faultActor);
    const fixture = await controller.query<{ id: number }>(
      `insert into public.review_items(category, ref_type, ref_key, title, note)
       select 'other', 'pg_contract', $1, $1 || ' fixture ' || n, 'original-' || n
         from generate_series(1, 7) as n order by n returning id`, [gate],
    );
    const ids = fixture.rows.map((row) => row.id).sort((a, b) => a - b);
    assert.equal(ids.length, 7);
    const auditRows = () => controller.query<AuditRow>(
      `select id, user_id, entity_id, action, "before", "after" from public.audit_logs
        where entity = 'review_item' and user_id = any($1::int[]) order by id`,
      [[actorA.id, actorB.id, faultActor.id]],
    );

    const decided = await decideReviewItem(actorA, ids[0], { status: "done", note: "single-success" }, dbA);
    assert.equal(decided.status, "done");
    const single = (await rows([ids[0]])).rows[0];
    assert.equal(single.status, "done");
    assert.equal(single.note, "single-success");
    assert.equal(single.decided_by, actorA.id);
    assert.ok(single.decided_at instanceof Date);
    let audits = (await auditRows()).rows;
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, "review_done");
    assert.equal(audits[0].entity_id, ids[0]);
    assert.deepEqual(audits[0].before, { status: "open", note: "original-1" });
    assert.deepEqual(audits[0].after, { status: "done", note: "single-success" });

    const bulkIds = ids.slice(1, 3);
    assert.deepEqual(await bulkDecideReviewItems(actorA, {
      ids: bulkIds, status: "overruled", note: "bulk-success",
    }, dbA), { updated: 2 });
    for (const row of (await rows(bulkIds)).rows) {
      assert.equal(row.status, "overruled");
      assert.equal(row.note, "bulk-success");
      assert.equal(row.decided_by, actorA.id);
      assert.ok(row.decided_at instanceof Date);
    }
    audits = (await auditRows()).rows;
    assert.equal(audits.length, 2, "one bulk audit must commit with both rows");
    assert.equal(audits[1].action, "review_bulk");
    assert.equal(audits[1].entity_id, null);
    assert.equal(audits[1].after.status, "overruled");
    assert.equal(audits[1].after.note, "bulk-success");
    assert.deepEqual([...audits[1].after.ids!].sort((a, b) => a - b), bulkIds);

    // Identifiers/gate are generated solely from random hex; actor/row IDs come from RETURNING.
    // The failure and waiting branches apply only to this invocation's synthetic identities.
    await controller.query(`CREATE FUNCTION public."${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.entity = 'review_item' AND NEW.user_id = ${faultActor.id} THEN
          RAISE EXCEPTION '${FAULT_MESSAGE}';
        END IF;
        IF NEW.entity = 'review_item' AND NEW.user_id = ${actorA.id}
           AND NEW.entity_id = ${ids[6]} AND NEW.action = 'review_done' THEN
          PERFORM pg_advisory_xact_lock(hashtext('${gate}'));
        END IF;
        RETURN NEW;
      END; $$`);
    functionCreated = true;
    await controller.query(`CREATE TRIGGER "${trigger}" BEFORE INSERT ON public.audit_logs
      FOR EACH ROW EXECUTE FUNCTION public."${fn}"()`);
    triggerCreated = true;

    const failureIds = ids.slice(3, 6);
    const beforeFailure = (await rows(failureIds)).rows;
    await assert.rejects(decideReviewItem(faultActor, failureIds[0], {
      status: "done", note: "must-roll-back-single",
    }, dbA), isAuditFault);
    assert.deepEqual((await rows(failureIds)).rows, beforeFailure, "single audit failure must roll back every changed field");
    await assert.rejects(bulkDecideReviewItems(faultActor, {
      ids: failureIds.slice(1), status: "overruled", note: "must-roll-back-bulk",
    }, dbA), isAuditFault);
    assert.deepEqual((await rows(failureIds)).rows, beforeFailure, "bulk audit failure must roll back the entire batch");
    assert.equal((await auditRows()).rows.length, 2, "failed decisions must not persist audit facts");

    const pidA = (await connectionA.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
    const pidB = (await connectionB.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
    await controller.query("begin");
    controllerOpen = true;
    await controller.query("select pg_advisory_xact_lock(hashtext($1))", [gate]);
    const promiseA = decideReviewItem(actorA, ids[6], { status: "done", note: "first-committed-note" }, dbA);
    pending.push(promiseA);
    void promiseA.catch(() => undefined); // Observe failures immediately while the controller polls.
    await waitUntil("A holding the review row and waiting at audit insertion", async () => {
      await controller.query("select pg_stat_clear_snapshot()");
      const state = await controller.query(
        "select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock' and wait_event = 'advisory'", [pidA],
      );
      return state.rows.length === 1;
    });
    const promiseB = decideReviewItem(actorB, ids[6], { status: "overruled" }, dbB);
    pending.push(promiseB);
    void promiseB.catch(() => undefined);
    await waitUntil("B blocked by A's review row lock", async () => {
      await controller.query("select pg_stat_clear_snapshot()");
      const state = await controller.query<{ blocked: boolean }>(
        "select $1::int = any(pg_blocking_pids($2::int)) as blocked", [pidA, pidB],
      );
      return state.rows[0]?.blocked === true;
    });
    assert.equal((await rows([ids[6]])).rows[0].status, "open", "A must not be visible before its audit commits");
    await controller.query("commit");
    controllerOpen = false;
    const results = await Promise.allSettled([promiseA, promiseB]);
    assert.ok(results.every((result) => result.status === "fulfilled"), "both serialized decisions must commit");
    const final = (await rows([ids[6]])).rows[0];
    assert.equal(final.status, "overruled");
    assert.equal(final.note, "first-committed-note", "B must inherit A's committed note, not a stale pre-lock snapshot");
    assert.equal(final.decided_by, actorB.id);
    audits = (await auditRows()).rows;
    assert.equal(audits.length, 4);
    const chain = audits.filter((row) => row.entity_id === ids[6]);
    assert.equal(chain.length, 2);
    assert.equal(chain[0].user_id, actorA.id);
    assert.deepEqual(chain[0].before, { status: "open", note: "original-7" });
    assert.equal(chain[1].user_id, actorB.id);
    assert.deepEqual(chain[1].before, chain[0].after, "B's audit before must equal A's committed after");
    assert.deepEqual(chain[1].after, { status: "overruled", note: "first-committed-note" });
    console.log(`Review contract evidence retained: fixture=${gate}; users=${actors.rows.map((row) => row.id).join(",")}; reviewItems=${ids.join(",")}`);
  } catch (error) {
    failures.push(error);
  } finally {
    if (controllerOpen) await controller.query("rollback").catch((error: unknown) => failures.push(error));
    // Release the controller first, then await bounded pending statements before dropping hooks.
    await Promise.allSettled(pending);
    if (triggerCreated) await controller.query(`DROP TRIGGER "${trigger}" ON public.audit_logs`).catch((error: unknown) => failures.push(error));
    if (functionCreated) await controller.query(`DROP FUNCTION public."${fn}"()`).catch((error: unknown) => failures.push(error));
    if (guardBefore) {
      try { assert.deepEqual((await guards()).rows, guardBefore, "existing audit protections must remain exactly unchanged"); }
      catch (error) { failures.push(error); }
    }
    await Promise.allSettled([controller.end(), connectionA.end(), connectionB.end()]);
  }
  if (failures.length) throw new AggregateError(failures, "PostgreSQL review atomicity contract failed");
  console.log("PostgreSQL review atomicity contract: OK (single + bulk commit/rollback; row-lock audit chain; append-only guards intact)");
}

// Match the repository's PostgreSQL CLI convention; importing admission helpers never opens PG.
if (process.argv[1] && resolve(process.argv[1]) === resolve(process.cwd(), "scripts/verify-postgres-review-atomicity.ts")) {
  verifyPostgresReviewAtomicity().catch((error: unknown) => {
    // No URL/configuration is printed. Nested failures contain only contract SQL/fixture values.
    console.error(error);
    process.exitCode = 1;
  });
}
