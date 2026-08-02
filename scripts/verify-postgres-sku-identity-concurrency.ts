/**
 * Real-PostgreSQL proof for SKU identifier ownership serialization.
 *
 * Two sessions attempt to claim one GTIN for different SKUs while a controller holds the same
 * advisory lock. After release, exactly one claim may commit and the other must fail with the
 * governed ownership conflict; the database must never contain two owners.
 */
import assert from "node:assert/strict";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "@/db/schema";
import { createSkuIdentifier } from "@/server/modules/master/sku-identifier";

const GTIN = "4006381333931";

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

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url?.startsWith("postgres")) {
    throw new Error("check:postgres:sku-identity-concurrency requires DATABASE_URL=postgres://...");
  }
  if (process.env.SCM_ALLOW_MUTATING_PG_CONTRACT !== "1") {
    throw new Error("Refusing mutating PostgreSQL proof without SCM_ALLOW_MUTATING_PG_CONTRACT=1");
  }

  const suffix = `${Date.now()}-${process.pid}`;
  const appA = `scm-sku-identity-a-${suffix}`;
  const appB = `scm-sku-identity-b-${suffix}`;
  const controller = new pg.Client({
    connectionString: url,
    application_name: `scm-sku-identity-control-${suffix}`,
  });
  const connectionA = new pg.Client({ connectionString: url, application_name: appA });
  const connectionB = new pg.Client({ connectionString: url, application_name: appB });
  const dbA = drizzle(connectionA, { schema });
  const dbB = drizzle(connectionB, { schema });
  let controllerTransactionOpen = false;
  let spuId: number | null = null;
  let skuIds: number[] = [];
  let userIds: number[] = [];

  await Promise.all([controller.connect(), connectionA.connect(), connectionB.connect()]);
  try {
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
      [`C${String(Date.now()).slice(-5)}`, `SKU identity concurrency ${suffix}`],
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

    const promiseA = createSkuIdentifier(
      skuIds[0],
      { kind: "gtin", value: GTIN, packagingLevel: "each", isPrimary: true },
      { id: userIds[0], name: users.rows[0].name, roles: ["admin"], isApprover: true },
      dbA,
    );
    const promiseB = createSkuIdentifier(
      skuIds[1],
      { kind: "gtin", value: GTIN, packagingLevel: "each", isPrimary: true },
      { id: userIds[1], name: users.rows[1].name, roles: ["admin"], isApprover: true },
      dbB,
    );

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
    const settled = await Promise.allSettled([promiseA, promiseB]);
    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
    const rejected = settled.find((result) => result.status === "rejected");
    assert.match(String(rejected?.reason), /已关联 SKU/);

    const ownership = await controller.query<{ rows: number; owners: number }>(
      `select count(*)::int as rows, count(distinct sku_id)::int as owners
         from sku_identifiers
        where kind = 'gtin' and scope = 'GS1' and value = $1`,
      [GTIN],
    );
    assert.deepEqual(ownership.rows[0], { rows: 1, owners: 1 });
    console.log("PostgreSQL SKU identity concurrency contract: OK");
  } finally {
    if (controllerTransactionOpen) {
      await controller.query("rollback").catch(() => undefined);
    }
    if (userIds.length > 0) {
      await controller.query("delete from audit_logs where user_id = any($1::int[])", [userIds])
        .catch(() => undefined);
    }
    if (skuIds.length > 0) {
      await controller.query("delete from skus where id = any($1::int[])", [skuIds])
        .catch(() => undefined);
    }
    if (spuId != null) {
      await controller.query("delete from spus where id = $1", [spuId]).catch(() => undefined);
    }
    if (userIds.length > 0) {
      await controller.query("delete from users where id = any($1::int[])", [userIds])
        .catch(() => undefined);
    }
    await Promise.allSettled([controller.end(), connectionA.end(), connectionB.end()]);
  }
}

void main();
