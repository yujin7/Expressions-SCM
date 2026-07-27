/**
 * Real-PostgreSQL migration contract for CI/staging.
 *
 * PGlite remains the fast test driver; this narrow check proves that drizzle-kit
 * can apply the journal to PostgreSQL and that release-critical columns/constraints
 * exist there. It is intentionally read-only after migration.
 */
import pg from "pg";

async function main(): Promise<void> {
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
      [[
        "users",
        "stock_ledger",
        "stock_balances",
        "bins",
        "bin_balances",
        "bin_movements",
        "audit_logs",
        "batches",
        "planning_versions",
        "planning_version_lines",
        "supply_demand_links",
        "projection_scenarios",
        "month_close_checks",
        "sop_cycles",
        "sop_decisions",
      ]],
    );
    const found = new Set(tables.rows.map((row) => row.table_name));
    const missing = [
      "users",
      "stock_ledger",
      "stock_balances",
      "bins",
      "bin_balances",
      "bin_movements",
      "audit_logs",
      "batches",
      "planning_versions",
      "planning_version_lines",
      "supply_demand_links",
      "projection_scenarios",
      "month_close_checks",
      "sop_cycles",
      "sop_decisions",
    ].filter((name) => !found.has(name));
    if (missing.length) throw new Error(`Missing migrated tables: ${missing.join(", ")}`);

    const sessionColumn = await client.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
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

    const immutableTriggers = await client.query<{
      table_name: string;
      trigger_name: string;
    }>(
      `select c.relname as table_name, t.tgname as trigger_name
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and not t.tgisinternal
          and t.tgname = any($1::text[])`,
      [[
        "stock_ledger_append_only",
        "stock_ledger_append_only_truncate",
        "audit_logs_append_only",
        "audit_logs_append_only_truncate",
        "planning_versions_append_only",
        "planning_versions_append_only_truncate",
        "planning_version_lines_append_only",
        "planning_version_lines_append_only_truncate",
        "supply_demand_links_append_only",
        "supply_demand_links_append_only_truncate",
        "supply_demand_link_identity",
        "projection_scenarios_append_only",
        "projection_scenarios_append_only_truncate",
        "bin_movements_append_only",
        "bin_movements_append_only_truncate",
        "sop_decisions_append_only",
        "sop_decisions_append_only_truncate",
      ]],
    );
    const triggerPairs = new Set(
      immutableTriggers.rows.map((row) => `${row.table_name}:${row.trigger_name}`),
    );
    const requiredTriggerPairs = [
      "stock_ledger:stock_ledger_append_only",
      "stock_ledger:stock_ledger_append_only_truncate",
      "audit_logs:audit_logs_append_only",
      "audit_logs:audit_logs_append_only_truncate",
      "planning_versions:planning_versions_append_only",
      "planning_versions:planning_versions_append_only_truncate",
      "planning_version_lines:planning_version_lines_append_only",
      "planning_version_lines:planning_version_lines_append_only_truncate",
      "supply_demand_links:supply_demand_links_append_only",
      "supply_demand_links:supply_demand_links_append_only_truncate",
      "supply_demand_links:supply_demand_link_identity",
      "projection_scenarios:projection_scenarios_append_only",
      "projection_scenarios:projection_scenarios_append_only_truncate",
      "bin_movements:bin_movements_append_only",
      "bin_movements:bin_movements_append_only_truncate",
      "sop_decisions:sop_decisions_append_only",
      "sop_decisions:sop_decisions_append_only_truncate",
    ];
    const missingTriggers = requiredTriggerPairs.filter((pair) => !triggerPairs.has(pair));
    if (missingTriggers.length) {
      throw new Error(`Missing append-only database triggers: ${missingTriggers.join(", ")}`);
    }

    const requiredLocationConstraints = [
      "ck_warehouse_region_code",
      "ck_warehouse_accounting_taxonomy",
      "ck_bin_kind",
      "uq_bin_wh_code",
      "uq_bin_balance_key",
      "ck_bin_balance_nonnegative",
      "bin_movements_idempotency_key_unique",
      "ck_bin_movement_positive_qty",
      "ck_bin_movement_has_endpoint",
      "ck_bin_movement_distinct_endpoints",
      "ck_bin_movement_operation",
      "ck_supply_demand_positive_demand",
      "ck_supply_demand_positive_available",
      "ck_supply_demand_pegged_range",
      "ck_supply_demand_sequence",
      "ck_supply_demand_confidence",
      "ck_supply_demand_status",
      "ck_month_close_month",
      "ck_month_close_key",
      "ck_month_close_status",
      "ck_month_close_completion",
      "ck_month_close_waiver_note",
      "ck_sop_cycle_month",
      "ck_sop_cycle_status",
      "ck_sop_cycle_version",
      "ck_sop_cycle_lifecycle",
      "ck_sop_decision_round",
      "ck_sop_decision_role",
      "ck_sop_decision_value",
      "ck_sop_reject_note",
    ];
    const locationConstraints = await client.query<{ conname: string }>(
      `select conname
         from pg_constraint
        where conname = any($1::text[])`,
      [requiredLocationConstraints],
    );
    const foundConstraints = new Set(locationConstraints.rows.map((row) => row.conname));
    const missingConstraints = requiredLocationConstraints.filter((name) => !foundConstraints.has(name));
    if (missingConstraints.length) {
      throw new Error(`Missing release-critical database constraints: ${missingConstraints.join(", ")}`);
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
      immutableTriggers: [...triggerPairs].sort(),
      locationConstraints: [...foundConstraints].sort(),
    }, null, 2));
  } finally {
    await client.end();
  }
}

void main();
