/**
 * Real-PostgreSQL proof for GTIN/GTIN, barcode/barcode and barcode/GTIN ownership serialization.
 *
 * Two sessions attempt to claim one GTIN for different SKUs while a controller holds the same
 * advisory lock. After release, exactly one claim may commit and the other must fail with the
 * governed ownership conflict. Only opt-in, loopback scm_contract_* disposable databases are
 * admitted; synthetic fixtures and immutable audits are retained, never deleted by this script.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import pg from "pg";
import { reviewContractConnectionString } from "./verify-postgres-review-atomicity";

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

export async function verifySkuIdentityConcurrency(mode: "gtin/gtin" | "fill/fill" | "fill/gtin"): Promise<void> {
  // Reuse the strict disposable-target gate; never load local .env or business data.
  const url = reviewContractConnectionString(process.env);
  const [{ drizzle }, schema, { createSkuIdentifier }, { fillSkuBarcodesBulk }, { ApiError }] = await Promise.all([
    import("drizzle-orm/node-postgres"), import("@/db/schema"),
    import("@/server/modules/master/sku-identifier"), import("@/server/modules/master/sku-barcode-fill"),
    import("@/server/modules/master/common"),
  ]);
  const body = String(Date.now()).slice(-12);
  const sum = [...body].reverse().reduce((n, d, i) => n + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  const GTIN = body + String((10 - sum % 10) % 10);

  const suffix = `${Date.now()}-${process.pid}`;
  const appA = `scm-sku-identity-a-${suffix}`;
  const appB = `scm-sku-identity-b-${suffix}`;
  const timeouts = { connectionTimeoutMillis: 5_000, query_timeout: 20_000,
    options: "-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000 -c search_path=public" };
  const controller = new pg.Client({ ...timeouts,
    connectionString: url,
    application_name: `scm-sku-identity-control-${suffix}`,
  });
  // One physical connection per competitor; pools safely queue parallel read-model refresh queries.
  const connectionA = new pg.Pool({ ...timeouts, max: 1, connectionString: url, application_name: appA });
  const connectionB = new pg.Pool({ ...timeouts, max: 1, connectionString: url, application_name: appB });
  const dbA = drizzle(connectionA, { schema });
  const dbB = drizzle(connectionB, { schema });
  let controllerTransactionOpen = false;
  let spuId: number | null = null;
  let skuIds: number[] = [];
  let userIds: number[] = [];
  const pending: Promise<unknown>[] = [];

  try {
    await Promise.all([controller.connect(), connectionA.query("select 1"), connectionB.query("select 1")]);
    const guards = await controller.query<{ name: string }>(
      `select p.proname as name from pg_trigger t join pg_proc p on p.oid=t.tgfoid
       where t.tgrelid='public.audit_logs'::regclass and not t.tgisinternal and t.tgenabled in ('O','A')`,
    );
    assert.ok(guards.rows.some(row => row.name === "reject_immutable_fact_mutation"));
    const users = await controller.query<{ id: number; name: string }>(
      `insert into users(username, name, roles)
       values ($1, $2, array['admin']::text[]), ($3, $4, array['admin']::text[])
       returning id, name`,
      [
        `sku-identity-a-${suffix}`,
        `SKU identity A ${suffix}`,
        `sku-identity-b-${suffix}`,
        `SKU identity B ${suffix}`,
      ],
    );
    userIds = users.rows.map((row) => row.id);
    assert.equal(userIds.length, 2);

    const spu = await controller.query<{ id: number }>(
      "insert into spus(code, name_cn) values ($1, $2) returning id",
      [`QA-${suffix}`, `SKU identity concurrency ${suffix}`],
    );
    spuId = spu.rows[0]?.id ?? null;
    assert.ok(spuId);
    const skus = await controller.query<{ id: number }>(
      `insert into skus(code, name, spu_id, sku_type, base_uom)
       values ($1, $2, $3, 'finished', '件'), ($4, $5, $3, 'finished', '件')
       returning id`,
      [`PG-SKU-A-${suffix}`, "并发 SKU A", spuId, `PG-SKU-B-${suffix}`, "并发 SKU B"],
    );
    skuIds = skus.rows.map((row) => row.id);
    assert.equal(skuIds.length, 2);

    await controller.query("begin");
    controllerTransactionOpen = true;
    await controller.query("select pg_advisory_xact_lock(hashtext($1))", [`sku-barcode:${GTIN}`]);

    const invoke = async (kind: string, index: number, db: typeof dbA) => {
      const actor = { id: userIds[index], name: users.rows[index].name, roles: ["admin"], isApprover: true };
      if (kind === "gtin") return createSkuIdentifier(skuIds[index],
        { kind: "gtin", value: GTIN, packagingLevel: "each", isPrimary: true }, actor, db);
      const result = await fillSkuBarcodesBulk(actor, { items: [{ skuId: skuIds[index], barcode: GTIN }] }, db);
      assert.equal(result.unchanged, 0);
      assert.equal(result.filled + result.conflicts, 1);
      if (result.conflicts) throw new ApiError(409, result.results[0].error ?? "Missing conflict explanation");
      return result;
    };
    const [left, right] = mode.split("/");
    // Attach handlers before observing waiters so early failures are never unhandled.
    const both = Promise.allSettled([invoke(left, 0, dbA), invoke(right, 1, dbB)]);
    pending.push(both);

    await waitUntil("both SKU claims waiting on the identifier advisory lock", async () => {
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

    await controller.query("commit");
    controllerTransactionOpen = false;
    const settled = await both;
    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
    const rejected = settled.find((result) => result.status === "rejected");
    assert.equal((rejected?.reason as { status?: number }).status, 409);
    assert.match(String(rejected?.reason), /已关联 SKU|已在旧条码字段关联 SKU/);

    const ownership = await controller.query<{ owners: number }>(
      `select count(distinct sku_id)::int as owners from (
         select id as sku_id from skus where barcode=$1
         union all select sku_id from sku_identifiers where kind in ('gtin','legacy') and value=$1
       ) owners`,
      [GTIN],
    );
    assert.deepEqual(ownership.rows[0], { owners: 1 });
    const audits = await controller.query<{ n: number }>(
      `select count(*)::int as n from audit_logs where user_id=any($1::int[]) and
       ((entity='sku' and action='barcode_fill' and entity_id=any($2::int[])) or
        (entity='sku_identifier' and action='create' and "after"->>'value'=$3))`, [userIds, skuIds, GTIN],
    );
    assert.equal(audits.rows[0].n, 1);
    console.log(`PostgreSQL identity ${mode}: PASS (2 observed lock waiters, 1 owner, 1 audit)`);
  } finally {
    if (controllerTransactionOpen) {
      await controller.query("rollback");
    }
    await Promise.allSettled(pending);
    // Preserve synthetic evidence and append-only audits. Drop the disposable DB separately if desired.
    await Promise.allSettled([controller.end(), connectionA.end(), connectionB.end()]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(process.cwd(), "scripts/verify-postgres-sku-identity-concurrency.ts")) {
  (async () => {
    for (const mode of ["gtin/gtin", "fill/fill", "fill/gtin"] as const) await verifySkuIdentityConcurrency(mode);
  })().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
