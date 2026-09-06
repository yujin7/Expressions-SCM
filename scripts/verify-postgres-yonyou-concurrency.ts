/**
 * Opt-in PostgreSQL proof for the Yonyou observation service. Never contacts Yonyou.
 * Run a copied candidate from a temporary directory against a migrated, disposable
 * scm_contract_* database. No .env loading; all actors, responses and evidence are synthetic.
 * Existing Yonyou runs/checkpoints are refused. Retain the evidence, then dispose of
 * the entire owned database; this script never deletes audit or business facts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import pg from "pg";
import type { YonyouReadContractName } from "@/server/integrations/yonyou-contracts";
import type { YonyouSyncSummary } from "@/server/integrations/yonyou-sync";

const SCRIPT = "scripts/verify-postgres-yonyou-concurrency.ts";
const TEMP_ROOTS = ["/tmp", "/private/tmp", tmpdir()];

function isWithin(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function temporaryPath(value: string): string {
  const normalized = resolve(value);
  return process.platform === "darwin" && normalized.startsWith("/tmp/") ? `/private${normalized}` : normalized;
}

/** Pure admission: importing this file cannot load application state or connect to PG. */
export function yonyouContractAdmission(env: Record<string, string | undefined>, cwd: string): {
  connectionString: string;
  databaseName: string;
  candidateRoot: string;
  storageRoot: string;
} {
  if (env.SCM_ALLOW_MUTATING_PG_CONTRACT !== "1") {
    throw new Error("Refusing PostgreSQL proof without SCM_ALLOW_MUTATING_PG_CONTRACT=1");
  }
  if (env.NODE_ENV !== "test" || env.SCM_RUN_JOBS !== "0") {
    throw new Error("PostgreSQL proof requires NODE_ENV=test and SCM_RUN_JOBS=0");
  }
  const connectionString = env.DATABASE_URL?.trim() ?? "";
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new Error("A PostgreSQL contract DATABASE_URL is required"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.search || url.hash || !url.username || !url.password || !url.port
    || !/^\/scm_contract_[a-zA-Z0-9_]+$/.test(url.pathname)
    || ["0", "3000", "3100", "15432"].includes(url.port)) {
    throw new Error("PostgreSQL proof requires an explicit disposable loopback URL, not a production port or URL override");
  }
  const candidateRoot = temporaryPath(cwd);
  if (!isAbsolute(cwd) || !TEMP_ROOTS.some((root) => isWithin(resolve(root), candidateRoot))) {
    throw new Error("PostgreSQL proof requires a copied candidate below a temporary directory");
  }
  const configuredStorage = env.FILE_STORAGE_DIR?.trim();
  if (!configuredStorage || !isAbsolute(configuredStorage) || !isWithin(candidateRoot, temporaryPath(configuredStorage))) {
    throw new Error("FILE_STORAGE_DIR must explicitly name a directory inside the isolated candidate");
  }
  return { connectionString, databaseName: url.pathname.slice(1), candidateRoot, storageRoot: temporaryPath(configuredStorage) };
}

function assertIsolatedPaths(candidateRoot: string, storageRoot: string): void {
  const canonicalRoot = realpathSync(candidateRoot);
  assert.ok(TEMP_ROOTS.some((root) => existsSync(root) && isWithin(realpathSync(root), canonicalRoot)),
    "Candidate resolves outside temporary storage");
  for (const child of ["src", "drizzle", SCRIPT]) {
    assert.equal(realpathSync(resolve(candidateRoot, child)), resolve(canonicalRoot, child),
      "Candidate source or script is redirected outside the copied candidate");
  }
  // Check existing ancestors before mkdir: an intermediate symlink must not redirect evidence.
  let existing = storageRoot;
  while (!existsSync(existing)) existing = dirname(existing);
  assert.equal(realpathSync(existing), resolve(canonicalRoot, relative(candidateRoot, existing)),
    "Evidence ancestor is redirected outside the copied candidate");
  mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  assert.equal(realpathSync(storageRoot), resolve(canonicalRoot, relative(candidateRoot, storageRoot)),
    "Evidence directory is redirected outside the copied candidate");
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolvePromise = yes; });
  return { promise, resolve: resolvePromise };
}

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_yes, no) => { timer = setTimeout(() => no(new Error(`Timed out: ${label}`)), milliseconds); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function waitUntil(label: string, check: () => Promise<boolean>): Promise<void> {
  // The lease scenario changes Date only. A monotonic deadline must still expire normally.
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 40));
  }
  throw new Error(`Timed out: ${label}`);
}

function contractClock() {
  const OriginalDate = globalThis.Date;
  let current = OriginalDate.now();
  // Preserve Date parsing, multi-argument constructors and instanceof for the real PG driver.
  globalThis.Date = new Proxy(OriginalDate, {
    construct(target, argumentsList, newTarget) {
      return Reflect.construct(target, argumentsList.length ? argumentsList : [current], newTarget);
    },
    apply() { return new OriginalDate(current).toString(); },
    get(target, property, receiver) {
      return property === "now" ? () => current : Reflect.get(target, property, receiver);
    },
  });
  return {
    advance: (milliseconds: number) => { current += milliseconds; },
    restore: () => { globalThis.Date = OriginalDate; },
  };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type Envelope = { code: string; message?: string; data?: Record<string, unknown> };
interface RunRow {
  id: number;
  status: string;
  started_at: Date;
  source_rows: number;
  staged_rows: number;
  import_job_id: number | null;
  error: string | null;
}

/** Mutates only a guarded disposable database and its explicitly isolated evidence directory. */
export async function verifyPostgresYonyouConcurrency(): Promise<void> {
  const admission = yonyouContractAdmission(process.env, process.cwd());
  assertIsolatedPaths(admission.candidateRoot, admission.storageRoot);
  assert.equal((globalThis as { __scmDb?: unknown }).__scmDb, undefined, "Application DB was initialized before admission");
  const originalFetch = globalThis.fetch;
  let rejectedExternalFetches = 0;
  globalThis.fetch = async () => { rejectedExternalFetches++; throw new Error("External fetch disabled in PostgreSQL proof"); };
  const suffix = randomUUID().replace(/-/g, "").slice(0, 16);
  const marker = `pg-yy-${suffix}`;
  const client = (role: string) => new pg.Client({
    connectionString: admission.connectionString,
    application_name: `${marker}-${role}`,
    ssl: false,
    connectionTimeoutMillis: 5_000,
    query_timeout: 20_000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000 -c search_path=public",
  });
  const controller = client("control");
  const connectionA = client("a");
  const connectionB = client("b");
  const pending: Promise<Outcome<YonyouSyncSummary>>[] = [];
  const releaseResponses: (() => void)[] = [];
  let controllerOpen = false;
  let restoreClock: (() => void) | undefined;
  let stage = "database admission";
  const failures: unknown[] = [];
  const observe = (promise: Promise<YonyouSyncSummary>) => {
    const outcome: Promise<Outcome<YonyouSyncSummary>> = promise.then(
      (value) => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }),
    );
    pending.push(outcome); // Observe rejections immediately while the controller polls.
    return outcome;
  };
  const successful = async (outcome: Promise<Outcome<YonyouSyncSummary>>) => {
    const result = await bounded(outcome, stage);
    if (!result.ok) throw result.error;
    return result.value;
  };
  try {
    await Promise.all([controller.connect(), connectionA.connect(), connectionB.connect()]);
    const identity = await controller.query<{ database: string; version: number }>(
      "select current_database() as database, current_setting('server_version_num')::int as version",
    );
    assert.equal(identity.rows[0]?.database, admission.databaseName, "Connected database differs from admitted target");
    assert.equal(Math.floor(identity.rows[0]?.version / 10_000), 16, "This catalog/locking proof targets PostgreSQL 16");
    const existing = await controller.query<{ runs: number; checkpoints: number }>(
      `select (select count(*)::int from integration_runs where connector in ('yy', 'yonyou')) as runs,
              (select count(*)::int from integration_checkpoints where connector in ('yy', 'yonyou')) as checkpoints`,
    );
    assert.deepEqual(existing.rows[0], { runs: 0, checkpoints: 0 }, "Use a fresh disposable database; existing Yonyou evidence is never deleted");

    const [{ drizzle }, schema, { syncYonyouContract }, { YonyouClient }, contracts] = await Promise.all([
      import("drizzle-orm/node-postgres"), import("@/db/schema"),
      import("@/server/integrations/yonyou-sync"), import("@/server/integrations/yonyou-client"),
      import("@/server/integrations/yonyou-contracts"),
    ]);
    const dbA = drizzle(connectionA, { schema });
    const dbB = drizzle(connectionB, { schema });
    const streamOf = (contract: YonyouReadContractName) => {
      const definition = contracts.yonyouReadContractByName(contract);
      assert.ok(definition, "Synthetic contract must use the real allowlist");
      return contracts.yonyouContractStreamKey(definition.path);
    };
    const makeClient = (contract: YonyouReadContractName, response: () => Envelope | Promise<Envelope>) => {
      let calls = 0;
      const definition = contracts.yonyouReadContractByName(contract);
      assert.ok(definition);
      const fetchImpl: typeof fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        assert.equal(url.origin, "https://c4.yonyoucloud.com", "Unexpected synthetic origin");
        let envelope: Envelope;
        if (url.pathname === "/iuap-api-gateway/open-auth/selfAppAuth/getAccessToken") {
          envelope = { code: "00000", data: { access_token: "synthetic-token", expire: 7200 } };
        } else {
          assert.equal(url.pathname, `/iuap-api-gateway${definition.path}`, "Unexpected synthetic contract path");
          calls++;
          envelope = await bounded(Promise.resolve().then(response), "synthetic response", 10_000);
        }
        return new Response(JSON.stringify(envelope), { status: 200, headers: { "Content-Type": "application/json" } });
      };
      return {
        calls: () => calls,
        client: new YonyouClient({
          appKey: "synthetic-key", appSecret: "synthetic-secret", tenantId: "synthetic-tenant", orgId: "synthetic-org",
          productProfile: "c4", approvedApiContracts: [contract], allowedHosts: ["c4.yonyoucloud.com"],
          baseUrl: "https://c4.yonyoucloud.com/iuap-api-gateway",
          tokenUrl: "https://c4.yonyoucloud.com/iuap-api-gateway/open-auth/selfAppAuth/getAccessToken",
        }, { fetchImpl, retries: 0, timeoutMs: 12_000, dnsLookup: async () => [{ address: "121.199.0.1", family: 4 }] }),
      };
    };
    const ok = (code: string): Envelope => ({ code: "00000", data: { rows: [{ code }] } });
    const denied = (): Envelope => ({ code: "310037", message: "Synthetic authorization waiting" });
    const rowsFor = async (id: number) => {
      const result = await controller.query<RunRow>(
        "select id, status, started_at, source_rows, staged_rows, import_job_id, error from integration_runs where id = $1", [id],
      );
      assert.equal(result.rows.length, 1);
      return result.rows[0];
    };
    const checkpoint = async (contract: YonyouReadContractName) => (await controller.query<{
      last_run_id: number; version: number; cursor: string;
    }>("select last_run_id, version, cursor from integration_checkpoints where connector = 'yy' and stream = $1", [streamOf(contract)])).rows;
    const assertCounts = async (contract: YonyouReadContractName, scope: string, jobs: number, rows: number) => {
      const result = await controller.query<{ jobs: number; rows: number }>(
        `select (select count(*)::int from import_jobs where idempotency_key = $1) as jobs,
                (select count(*)::int from staging_rows s join import_jobs j on j.id = s.import_job_id
                  where j.idempotency_key = $1) as rows`, [`yy:${streamOf(contract)}:${scope}`],
      );
      assert.deepEqual(result.rows[0], { jobs, rows }, "Scope must not produce duplicate jobs or staging");
    };
    const actor = await controller.query<{ id: number }>(
      "insert into users(username, name, roles) values ($1, $2, array['admin']::text[]) returning id", [marker, `Synthetic ${marker}`],
    );
    const actorId = actor.rows[0].id;

    stage = "authorization waiting, retry, recovery and replay";
    const retryContract = "存货成本查询";
    const retryScope = `${marker}-retry`;
    const waitingClient = makeClient(retryContract, denied);
    const waitingOptions = { client: waitingClient.client, contract: retryContract, actorId, scopeKey: retryScope } as const;
    const waiting = await syncYonyouContract(dbA, waitingOptions);
    const waitingAgain = await syncYonyouContract(dbB, waitingOptions);
    for (const result of [waiting, waitingAgain]) {
      assert.equal(result.blockedByConsoleGrant, true);
      assert.equal(result.replayed, false);
      assert.equal(result.importJobId, null);
      assert.equal(result.sourceRows, 0);
      assert.equal(result.stagedRows, 0);
    }
    assert.equal(waitingAgain.runId, waiting.runId);
    assert.equal(waitingClient.calls(), 2, "Waiting must be checked again, not replayed as success");
    assert.deepEqual(await checkpoint(retryContract), []);
    await assertCounts(retryContract, retryScope, 0, 0);
    const recoveredClient = makeClient(retryContract, () => ok("QA-RECOVERED"));
    const recoveredOptions = { ...waitingOptions, client: recoveredClient.client };
    const recovered = await syncYonyouContract(dbA, recoveredOptions);
    const replay = await syncYonyouContract(dbB, recoveredOptions);
    assert.equal(recovered.runId, waiting.runId);
    assert.equal(recovered.blockedByConsoleGrant, false);
    assert.equal(recovered.replayed, false);
    assert.ok(recovered.importJobId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.importJobId, recovered.importJobId);
    assert.equal(recoveredClient.calls(), 1);
    await assertCounts(retryContract, retryScope, 1, 1);
    assert.deepEqual(await checkpoint(retryContract), [{ last_run_id: recovered.runId, version: 1, cursor: retryScope }]);

    stage = "true zero-row observation replays without another call";
    const emptyContract = "供应商档案列表查询";
    const emptyScope = `${marker}-empty`;
    const emptyClient = makeClient(emptyContract, () => ({ code: "00000", data: { rows: [] } }));
    const emptyOptions = { client: emptyClient.client, contract: emptyContract, actorId, scopeKey: emptyScope } as const;
    const empty = await syncYonyouContract(dbA, emptyOptions);
    const emptyReplay = await syncYonyouContract(dbB, emptyOptions);
    assert.ok(empty.importJobId, "A true empty observation has a job");
    assert.equal(empty.blockedByConsoleGrant, false);
    assert.equal(empty.sourceRows, 0);
    assert.equal(empty.stagedRows, 0);
    assert.equal(emptyReplay.replayed, true);
    assert.equal(emptyReplay.importJobId, empty.importJobId);
    assert.equal(emptyClient.calls(), 1);
    await assertCounts(emptyContract, emptyScope, 1, 0);

    stage = "same-scope active lease prevents a second business request";
    const concurrentContract = "采购订单列表查询";
    const concurrentScope = `${marker}-concurrent`;
    const prior = makeClient(concurrentContract, denied);
    await syncYonyouContract(dbA, { client: prior.client, contract: concurrentContract, actorId, scopeKey: concurrentScope });
    const sameStarted = deferred<void>();
    const sameResponse = deferred<Envelope>();
    releaseResponses.push(() => sameResponse.resolve(denied()));
    const concurrent = makeClient(concurrentContract, () => { sameStarted.resolve(); return sameResponse.promise; });
    const concurrentOptions = { client: concurrent.client, contract: concurrentContract, actorId, scopeKey: concurrentScope } as const;
    const sameWinner = observe(syncYonyouContract(dbA, concurrentOptions));
    await bounded(sameStarted.promise, "same-scope claim reached synthetic transport");
    await assert.rejects(syncYonyouContract(dbB, concurrentOptions), /同步已被其他运行占用/);
    assert.equal(concurrent.calls(), 1);
    sameResponse.resolve(ok("QA-SINGLE-WINNER"));
    await successful(sameWinner);
    await assertCounts(concurrentContract, concurrentScope, 1, 1);

    stage = "different scopes really wait on PostgreSQL advisory lock";
    const lockContract = "现存量查询 V2";
    const olderScope = `${marker}-lock-older`;
    const newerScope = `${marker}-lock-newer`;
    const pidA = (await connectionA.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
    const pidB = (await connectionB.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
    await controller.query("begin");
    controllerOpen = true;
    await controller.query("select pg_advisory_xact_lock(hashtext($1))", [`yy:${streamOf(lockContract)}`]);
    const olderStarted = deferred<void>();
    const olderResponse = deferred<Envelope>();
    releaseResponses.push(() => olderResponse.resolve(denied()));
    const older = observe(syncYonyouContract(dbA, {
      client: makeClient(lockContract, () => { olderStarted.resolve(); return olderResponse.promise; }).client,
      contract: lockContract, actorId, scopeKey: olderScope,
    }));
    await bounded(olderStarted.promise, "older run claimed before newer run");
    const newer = observe(syncYonyouContract(dbB, {
      client: makeClient(lockContract, () => ok("QA-NEWER")).client, contract: lockContract, actorId, scopeKey: newerScope,
    }));
    // B has the newer run ID, but deliberately queues first. A must not later overwrite B.
    await waitUntil("newer PostgreSQL session queues before the older response", async () => {
      await controller.query("select pg_stat_clear_snapshot()");
      return (await controller.query(
        "select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock' and wait_event = 'advisory'", [pidB],
      )).rows.length === 1;
    });
    olderResponse.resolve(ok("QA-OLDER"));
    await waitUntil("both independent PostgreSQL sessions waiting on advisory lock", async () => {
      await controller.query("select pg_stat_clear_snapshot()");
      const result = await controller.query<{ count: number }>(
        `select count(*)::int as count from pg_stat_activity
          where pid = any($1::int[]) and wait_event_type = 'Lock' and wait_event = 'advisory'`, [[pidA, pidB]],
      );
      return result.rows[0].count === 2;
    });
    assert.deepEqual(await checkpoint(lockContract), [], "Uncommitted observations must not advance the checkpoint");
    await controller.query("commit");
    controllerOpen = false;
    const newerResult = await successful(newer);
    const olderResult = await bounded(older, "older advisory-lock attempt");
    assert.equal(olderResult.ok, false, "Older attempt must reject after the newer queued observation commits");
    if (!olderResult.ok) assert.match(String(olderResult.error), /已有更新成功运行/);
    const lockCheckpoint = await checkpoint(lockContract);
    assert.deepEqual(lockCheckpoint, [{ last_run_id: newerResult.runId, version: 1, cursor: newerScope }]);
    await assertCounts(lockContract, newerScope, 1, 1);
    await assertCounts(lockContract, olderScope, 0, 0);

    for (const [lateKind, lateContract] of [["authorization", "采购入库列表查询"], ["success", "凭证列表查询"]] as const) {
      stage = `same-millisecond lease fencing and late ${lateKind} rollback`;
      const clock = contractClock();
      restoreClock = clock.restore;
      const scopeKey = `${marker}-late-${lateKind}`;
      const initial = await syncYonyouContract(dbA, { client: makeClient(lateContract, denied).client, contract: lateContract, actorId, scopeKey });
      const before = await rowsFor(initial.runId);
      const started = deferred<void>();
      const response = deferred<Envelope>();
      releaseResponses.push(() => response.resolve(denied()));
      const lateClient = makeClient(lateContract, () => { started.resolve(); return response.promise; });
      const late = observe(syncYonyouContract(dbA, { client: lateClient.client, contract: lateContract, actorId, scopeKey }));
      await bounded(started.promise, "late attempt acquired lease");
      const running = await rowsFor(initial.runId);
      assert.equal(running.status, "running");
      assert.ok(running.started_at.getTime() > before.started_at.getTime(), "Same millisecond retry must change the lease token");
      // Simulate elapsed lease time in this process only; do not rewrite stored lease facts.
      clock.advance(3 * 60 * 60 * 1000);
      const winner = await syncYonyouContract(dbB, { client: makeClient(lateContract, () => ok("QA-TAKEOVER")).client, contract: lateContract, actorId, scopeKey });
      assert.equal(winner.runId, initial.runId);
      response.resolve(lateKind === "authorization" ? denied() : ok("QA-LATE-MUST-ROLL-BACK"));
      const lateResult = await bounded(late, "late attempt finishes without changing winner");
      assert.equal(lateResult.ok, false, "A fenced attempt must not return success");
      if (!lateResult.ok) assert.match(String(lateResult.error), /租约已被其他重试接管/);
      const final = await rowsFor(initial.runId);
      assert.equal(final.status, "succeeded");
      assert.equal(final.error, null);
      assert.equal(final.import_job_id, winner.importJobId);
      assert.equal(final.source_rows, 1);
      assert.equal(final.staged_rows, 1);
      await assertCounts(lateContract, scopeKey, 1, 1);
      const staged = await controller.query<{ status: string; code: string; job_status: string }>(
        `select s.status, s.payload -> 'raw' ->> 'code' as code, j.status as job_status
           from staging_rows s join import_jobs j on j.id = s.import_job_id where j.id = $1`, [winner.importJobId],
      );
      assert.deepEqual(staged.rows, [{ status: "pending", code: "QA-TAKEOVER", job_status: "done" }],
        "Late success transaction must roll back its job and any superseding of the winner");
      assert.deepEqual(await checkpoint(lateContract), [{ last_run_id: winner.runId, version: 1, cursor: scopeKey }]);
      clock.restore();
      restoreClock = undefined;
    }
    stage = "final retained synthetic evidence";
    assert.equal(rejectedExternalFetches, 0, "No fallback external fetch may be attempted");
    const running = await controller.query<{ count: number }>(
      "select count(*)::int as count from integration_runs where connector in ('yy', 'yonyou') and status = 'running'",
    );
    assert.equal(running.rows[0].count, 0, "Every synthetic attempt must leave a terminal run");
    console.log(JSON.stringify({ syntheticOnly: true, fixture: marker, actorId, scenarios: 6,
      proved: ["waiting-retry-recovery-replay", "zero-row-replay", "same-scope-lease", "real-pg-advisory-wait", "late-authorization-fenced", "late-success-rollback"],
      externalAuthorizationVerified: false, productionDataUsed: false, evidenceRetained: true }));
  } catch (error) {
    failures.push(error);
    // No raw SQL, response, credentials, URL or error detail is printed.
    console.error(JSON.stringify({ failureAt: stage, errorType: error instanceof Error ? error.name : "unknown" }));
  } finally {
    if (controllerOpen) await controller.query("rollback").catch((error: unknown) => failures.push(error));
    for (const release of releaseResponses) release();
    await bounded(Promise.allSettled(pending), "pending synthetic attempts during cleanup", 20_000).catch((error: unknown) => failures.push(error));
    restoreClock?.();
    globalThis.fetch = originalFetch;
    const closing = await Promise.allSettled([controller, connectionA, connectionB].map((connection) => bounded(connection.end(), "PostgreSQL close", 5_000)));
    for (const result of closing) if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length) throw new AggregateError(failures, "Yonyou PostgreSQL synthetic contract failed");
  console.log("Yonyou PostgreSQL contract: OK; synthetic service/transaction evidence only, not vendor authorization or UAT");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(process.cwd(), SCRIPT)) {
  // An opt-in CLI must remain bounded even if an unexpected driver handle survives cleanup.
  const hardStop = setTimeout(() => { console.error("Yonyou PostgreSQL proof exceeded its hard deadline"); process.exit(1); }, 90_000);
  hardStop.unref();
  verifyPostgresYonyouConcurrency().then(() => clearTimeout(hardStop)).catch(() => {
    console.error("Yonyou PostgreSQL proof failed; no success claim made");
    process.exitCode = 1;
  });
}
