/**
 * Real-PostgreSQL proof for Jiandaoyun stream serialization.
 *
 * This check is intentionally opt-in and mutating. CI runs it only against the disposable
 * PostgreSQL service after migrations; ordinary tests remain Docker-independent and PGlite-fast.
 */
import assert from "node:assert/strict";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import { JiandaoyunClient } from "@/server/integrations/jiandaoyun";
import type { JiandaoyunFormContract } from "@/server/integrations/jiandaoyun-contracts";
import { syncJiandaoyunForm } from "@/server/integrations/jiandaoyun-sync";

const APP_ID = "a".repeat(24);
const ENTRY_ID = "b".repeat(24);
const RECORD_ID = "c".repeat(24);

async function waitUntil(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function clientFor(note: string, updatedAt: string): JiandaoyunClient {
  return new JiandaoyunClient({
    apiKey: "ci-only-placeholder",
    baseUrl: "https://example.invalid/api/v5",
  }, {
    retries: 0,
    fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/app/entry/widget/list")) {
        return response({
          widgets: [{ name: "_widget_note", label: "备注", type: "text" }],
        });
      }
      if (path.endsWith("/app/entry/data/list")) {
        return response({
          data: [{
            _id: RECORD_ID,
            appId: APP_ID,
            entryId: ENTRY_ID,
            updateTime: updatedAt,
            _widget_note: { value: note },
          }],
        });
      }
      throw new Error(`Unexpected Jiandaoyun test path: ${path}`);
    },
  });
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url?.startsWith("postgres")) {
    throw new Error("check:postgres:jdy-concurrency requires DATABASE_URL=postgres://...");
  }
  if (process.env.SCM_ALLOW_MUTATING_PG_CONTRACT !== "1") {
    throw new Error("Refusing mutating PostgreSQL proof without SCM_ALLOW_MUTATING_PG_CONTRACT=1");
  }

  const suffix = `${Date.now()}-${process.pid}`;
  const stream = `pg-jdy-concurrency-${suffix}`;
  const targetTable = `jdy_pg_concurrency_${suffix}`;
  const appA = `scm-jdy-pg-a-${suffix}`;
  const appB = `scm-jdy-pg-b-${suffix}`;
  const controller = new pg.Client({ connectionString: url, application_name: `scm-jdy-pg-control-${suffix}` });
  const connectionA = new pg.Client({ connectionString: url, application_name: appA });
  const connectionB = new pg.Client({ connectionString: url, application_name: appB });
  const dbA = drizzle(connectionA, { schema });
  const dbB = drizzle(connectionB, { schema });
  let actorId: number | null = null;
  let promiseA: Promise<unknown> | null = null;
  let promiseB: Promise<unknown> | null = null;
  let controllerTransactionOpen = false;

  const contract: JiandaoyunFormContract = {
    key: stream,
    label: "PostgreSQL advisory-lock contract",
    appId: APP_ID,
    entryId: ENTRY_ID,
    targetTable,
    fields: [{ source: "_widget_note", target: "note" }],
  };
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);

  await Promise.all([controller.connect(), connectionA.connect(), connectionB.connect()]);
  try {
    const actor = await controller.query<{ id: number }>(
      "insert into users(name) values ($1) returning id",
      [`Jiandaoyun PostgreSQL contract ${suffix}`],
    );
    actorId = actor.rows[0]?.id ?? null;
    assert.ok(actorId, "contract actor was not created");

    await controller.query("begin");
    controllerTransactionOpen = true;
    await controller.query("select pg_advisory_xact_lock(hashtext($1))", [`jdy:${stream}`]);

    promiseA = syncJiandaoyunForm(dbA, {
      client: clientFor("older", "2026-08-02T01:00:00.000Z"),
      actorId,
      contract,
      writeEvidence: async (_connector, _stream, envelope) => ({
        relativePath: `integration-evidence/jdy/${stream}/${hashA}.json`,
        hash: hashA,
        bytes: `${JSON.stringify(envelope)}\n`,
      }),
    });
    await waitUntil("first running integration claim", async () => {
      const result = await controller.query<{ count: number }>(
        "select count(*)::int as count from integration_runs where connector = 'jdy' and stream = $1 and status = 'running'",
        [stream],
      );
      return result.rows[0]?.count === 1;
    });

    promiseB = syncJiandaoyunForm(dbB, {
      client: clientFor("newer", "2026-08-02T02:00:00.000Z"),
      actorId,
      contract,
      writeEvidence: async (_connector, _stream, envelope) => ({
        relativePath: `integration-evidence/jdy/${stream}/${hashB}.json`,
        hash: hashB,
        bytes: `${JSON.stringify(envelope)}\n`,
      }),
    });
    await waitUntil("both PostgreSQL sessions waiting on the advisory lock", async () => {
      const result = await controller.query<{ count: number }>(
        `select count(*)::int as count
           from pg_stat_activity
          where application_name = any($1::text[])
            and wait_event_type = 'Lock'
            and wait_event = 'advisory'`,
        [[appA, appB]],
      );
      return result.rows[0]?.count === 2;
    });
    const beforeRelease = await controller.query<{ count: number }>(
      "select count(*)::int as count from integration_runs where connector = 'jdy' and stream = $1 and status = 'running'",
      [stream],
    );
    assert.equal(beforeRelease.rows[0]?.count, 2, "both claims must remain running behind the lock");

    await controller.query("commit");
    controllerTransactionOpen = false;
    const [resultA, resultB] = await Promise.allSettled([promiseA, promiseB]);
    assert.equal(resultB.status, "fulfilled", "the newer source envelope must commit");
    assert.ok(
      resultA.status === "fulfilled" || resultA.status === "rejected",
      "the older attempt must terminate deterministically",
    );

    const runs = await controller.query<{
      id: number;
      status: string;
      evidence_hash: string;
      import_job_id: number | null;
    }>(
      `select id, status, evidence_hash, import_job_id
         from integration_runs
        where connector = 'jdy' and stream = $1
        order by id`,
      [stream],
    );
    assert.equal(runs.rows.length, 2);
    const newestRun = runs.rows.at(-1);
    assert.equal(newestRun?.evidence_hash, hashB);
    assert.equal(newestRun?.status, "succeeded");
    assert.ok(runs.rows.every((row) => row.status !== "running"));

    const checkpoint = await controller.query<{
      cursor: string;
      last_run_id: number;
      version: number;
    }>(
      "select cursor, last_run_id, version from integration_checkpoints where connector = 'jdy' and stream = $1",
      [stream],
    );
    assert.equal(checkpoint.rows.length, 1);
    assert.equal(checkpoint.rows[0]?.cursor, hashB);
    assert.equal(checkpoint.rows[0]?.last_run_id, newestRun?.id);
    assert.ok((checkpoint.rows[0]?.version ?? 0) >= 1);

    const active = await controller.query<{ id: number; note: string; pending_rows: number }>(
      `select j.id,
              s.payload #>> '{data,note}' as note,
              count(*) filter (where s.status = 'pending')::int as pending_rows
         from import_jobs j
         join staging_rows s on s.import_job_id = j.id
        where j.template = $1 and j.status = 'done'
        group by j.id, s.payload #>> '{data,note}'`,
      [targetTable],
    );
    assert.deepEqual(active.rows, [{
      id: newestRun?.import_job_id,
      note: "newer",
      pending_rows: 1,
    }]);
  } finally {
    if (controllerTransactionOpen) {
      await controller.query("rollback").catch(() => undefined);
      controllerTransactionOpen = false;
    }
    await Promise.allSettled([promiseA, promiseB].filter((value): value is Promise<unknown> => value !== null));
    await controller.query(
      "delete from integration_checkpoints where connector = 'jdy' and stream = $1",
      [stream],
    ).catch(() => undefined);
    await controller.query(
      "delete from integration_runs where connector = 'jdy' and stream = $1",
      [stream],
    ).catch(() => undefined);
    const jobIds = await controller.query<{ id: number }>(
      "select id from import_jobs where template = $1",
      [targetTable],
    ).catch(() => ({ rows: [] as { id: number }[] }));
    if (jobIds.rows.length > 0) {
      const ids = jobIds.rows.map((row) => row.id);
      await controller.query("delete from staging_rows where import_job_id = any($1::int[])", [ids])
        .catch(() => undefined);
      await controller.query("delete from import_jobs where id = any($1::int[])", [ids])
        .catch(() => undefined);
    }
    if (actorId !== null) {
      await controller.query("delete from users where id = $1", [actorId]).catch(() => undefined);
    }
    await Promise.allSettled([controller.end(), connectionA.end(), connectionB.end()]);
  }

  process.stdout.write("Jiandaoyun PostgreSQL advisory-lock contract passed\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
