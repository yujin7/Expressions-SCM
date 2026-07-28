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
        "supplier_lifecycle_cases",
        "quality_cases",
        "quality_actions",
        "regulatory_records",
        "electronic_label_versions",
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
      "supplier_lifecycle_cases",
      "quality_cases",
      "quality_actions",
      "regulatory_records",
      "electronic_label_versions",
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

    const inspectionSiteKeyColumn = await client.query<{
      data_type: string;
      is_nullable: string;
    }>(
      `select data_type, is_nullable
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'quality_cases'
          and column_name = 'inspection_site_key'`,
    );
    if (
      inspectionSiteKeyColumn.rows[0]?.data_type !== "text"
      || inspectionSiteKeyColumn.rows[0]?.is_nullable !== "YES"
    ) {
      throw new Error("quality_cases.inspection_site_key migration contract is missing");
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
        "regulatory_records_append_only",
        "regulatory_records_append_only_truncate",
        "electronic_label_versions_append_only",
        "electronic_label_versions_append_only_truncate",
        "quality_cases_no_delete",
        "quality_actions_no_delete",
        "quality_cases_frozen_scope",
        "quality_cases_evidence_immutability",
        "quality_actions_evidence_immutability",
        "regulatory_records_version_chain",
        "electronic_label_versions_version_chain",
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
      "regulatory_records:regulatory_records_append_only",
      "regulatory_records:regulatory_records_append_only_truncate",
      "electronic_label_versions:electronic_label_versions_append_only",
      "electronic_label_versions:electronic_label_versions_append_only_truncate",
      "quality_cases:quality_cases_no_delete",
      "quality_actions:quality_actions_no_delete",
      "quality_cases:quality_cases_frozen_scope",
      "quality_cases:quality_cases_evidence_immutability",
      "quality_actions:quality_actions_evidence_immutability",
      "regulatory_records:regulatory_records_version_chain",
      "electronic_label_versions:electronic_label_versions_version_chain",
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
      "ck_supplier_lifecycle_kind",
      "ck_supplier_lifecycle_status",
      "ck_supplier_lifecycle_priority",
      "ck_supplier_lifecycle_close",
      "ck_supplier_lifecycle_outcome",
      "uq_supplier_lifecycle_idempotency",
      "quality_cases_case_no_unique",
      "quality_cases_idempotency_key_unique",
      "ck_quality_case_kind",
      "ck_quality_case_status",
      "ck_quality_case_severity",
      "ck_quality_case_market",
      "ck_quality_case_source",
      "ck_quality_case_assessment",
      "ck_quality_case_reportable_fields",
      "ck_quality_case_reported",
      "ck_quality_case_recall_anchor",
      "ck_quality_case_recall_scope",
      "ck_quality_case_self_inspection",
      "ck_quality_case_non_inspection_fields",
      "ck_quality_case_self_inspection_report",
      "ck_quality_case_close",
      "ck_quality_case_version",
      "quality_actions_idempotency_key_unique",
      "ck_quality_action_kind",
      "ck_quality_action_status",
      "ck_quality_action_completion",
      "ck_quality_action_verification",
      "ck_quality_action_sod",
      "ck_quality_action_waiver",
      "ck_quality_action_qty",
      "regulatory_records_idempotency_key_unique",
      "uq_regulatory_record_version",
      "ck_regulatory_type",
      "ck_regulatory_status",
      "ck_regulatory_market",
      "ck_regulatory_version",
      "ck_regulatory_previous",
      "electronic_label_versions_public_token_unique",
      "electronic_label_versions_idempotency_key_unique",
      "uq_electronic_label_version",
      "ck_electronic_label_market",
      "ck_electronic_label_locale",
      "ck_electronic_label_version",
      "ck_electronic_label_previous",
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

    // PostgreSQL truncates identifiers above 63 bytes, so generated FK names are
    // not a stable contract. Verify the version-chain self references by meaning.
    const versionChainFks = await client.query<{
      table_name: string;
      definition: string;
    }>(
      `select conrelid::regclass::text as table_name,
              pg_get_constraintdef(oid) as definition
         from pg_constraint
        where contype = 'f'
          and conrelid = confrelid
          and conrelid = any($1::regclass[])`,
      [["regulatory_records", "electronic_label_versions"]],
    );
    const versionChainSelfReferences = new Set(
      versionChainFks.rows
        .filter((row) => row.definition.startsWith("FOREIGN KEY (previous_id) REFERENCES "))
        .map((row) => row.table_name),
    );
    const missingVersionChainFks = ["regulatory_records", "electronic_label_versions"]
      .filter((tableName) => !versionChainSelfReferences.has(tableName));
    if (missingVersionChainFks.length) {
      throw new Error(
        `Missing previous_id self-reference constraints: ${missingVersionChainFks.join(", ")}`,
      );
    }

    const lifecycleIndexes = await client.query<{ indexname: string }>(
      `select indexname
         from pg_indexes
        where schemaname = 'public'
          and tablename = 'supplier_lifecycle_cases'
          and indexname = any($1::text[])`,
      [[
        "uq_supplier_lifecycle_open_kind",
        "ix_supplier_lifecycle_status_due",
        "ix_supplier_lifecycle_supplier_created",
      ]],
    );
    const foundLifecycleIndexes = new Set(lifecycleIndexes.rows.map((row) => row.indexname));
    const missingLifecycleIndexes = [
      "uq_supplier_lifecycle_open_kind",
      "ix_supplier_lifecycle_status_due",
      "ix_supplier_lifecycle_supplier_created",
    ].filter((name) => !foundLifecycleIndexes.has(name));
    if (missingLifecycleIndexes.length) {
      throw new Error(`Missing supplier lifecycle indexes: ${missingLifecycleIndexes.join(", ")}`);
    }

    const requiredQualityIndexes = [
      "uq_quality_self_inspection_site_year",
      "ix_quality_case_kind_status",
      "ix_quality_case_owner_due",
      "ix_quality_case_sku_batch",
      "ix_quality_action_case_status",
      "ix_quality_action_owner_due",
      "ix_regulatory_market_type",
      "ix_regulatory_expiry",
      "ix_electronic_label_sku_market",
    ];
    const qualityIndexes = await client.query<{ indexname: string }>(
      `select indexname
         from pg_indexes
        where schemaname = 'public'
          and indexname = any($1::text[])`,
      [requiredQualityIndexes],
    );
    const foundQualityIndexes = new Set(qualityIndexes.rows.map((row) => row.indexname));
    const missingQualityIndexes = requiredQualityIndexes.filter((name) => !foundQualityIndexes.has(name));
    if (missingQualityIndexes.length) {
      throw new Error(`Missing quality/compliance indexes: ${missingQualityIndexes.join(", ")}`);
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
      inspectionSiteKey: inspectionSiteKeyColumn.rows[0],
      immutableTriggers: [...triggerPairs].sort(),
      locationConstraints: [...foundConstraints].sort(),
      versionChainSelfReferences: [...versionChainSelfReferences].sort(),
      supplierLifecycleIndexes: [...foundLifecycleIndexes].sort(),
      qualityComplianceIndexes: [...foundQualityIndexes].sort(),
    }, null, 2));
  } finally {
    await client.end();
  }
}

void main();
