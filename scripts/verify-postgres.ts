/**
 * Real-PostgreSQL migration contract for CI/staging.
 *
 * PGlite remains the fast test driver; this narrow check proves that drizzle-kit
 * can apply the journal to PostgreSQL and that release-critical columns/constraints
 * exist there. It is intentionally read-only after migration.
 */
import pg from "pg";

const url = process.env.DATABASE_URL?.trim();
if (!url?.startsWith("postgres")) {
  throw new Error("check:postgres requires DATABASE_URL=postgres://...");
}

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
await client.connect();
try {
  const health = await client.query<{ ok: number }>("select 1 as ok");
  if (health.rows[0]?.ok !== 1) throw new Error("PostgreSQL SELECT 1 failed");

  const tables = await client.query<{ table_name: string }>(
    `select table_name
       from information_schema.tables
      where table_schema = 'public'
        and table_name = any($1::text[])`,
    [["users", "stock_ledger", "stock_balances", "audit_logs", "batches"]],
  );
  const found = new Set(tables.rows.map((row) => row.table_name));
  const missing = ["users", "stock_ledger", "stock_balances", "audit_logs", "batches"].filter(
    (name) => !found.has(name),
  );
  if (missing.length) throw new Error(`Missing migrated tables: ${missing.join(", ")}`);

  const sessionColumn = await client.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
    `select data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public'
        and table_name = 'users'
        and column_name = 'session_version'`,
  );
  const column = sessionColumn.rows[0];
  if (!column || column.data_type !== "integer" || column.is_nullable !== "NO") {
    throw new Error("users.session_version migration contract is missing or nullable");
  }

  const migrationCount = await client.query<{ count: string }>(
    `select count(*)::text as count from drizzle.__drizzle_migrations`,
  );
  const applied = Number(migrationCount.rows[0]?.count ?? 0);
  if (!Number.isInteger(applied) || applied < 1) throw new Error("No drizzle migrations recorded");

  console.log(JSON.stringify({
    ok: true,
    engine: "postgresql",
    appliedMigrations: applied,
    requiredTables: [...found].sort(),
    sessionVersion: column,
  }, null, 2));
} finally {
  await client.end();
}
