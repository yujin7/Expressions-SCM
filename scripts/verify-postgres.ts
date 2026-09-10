/**
 * Real-PostgreSQL migration contract for CI/staging.
 *
 * PGlite remains the fast test driver; this narrow check proves that drizzle-kit
 * can apply the journal to PostgreSQL and that release-critical columns/constraints
 * exist there. It is intentionally read-only after migration.
 */
import pg from "pg";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export interface ExpectedMigration { tag: string; when: number; hash: string }
export interface AppliedMigration { hash: string; created_at: string | number | null }

/** Match drizzle's exact UTF-8 file hashing, but also reject unjournaled SQL. */
export function expectedPostgresMigrations(folder: string): ExpectedMigration[] {
  const journal = JSON.parse(readFileSync(resolve(folder, "meta/_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string; when: number }[];
  };
  if (!Array.isArray(journal.entries) || !journal.entries.length) throw new Error("Empty migration journal");
  const tags = new Set<string>();
  let previousWhen = -1;
  const expected = journal.entries.map((entry, index) => {
    if (entry.idx !== index || !/^\d{4}_[A-Za-z0-9_]+$/.test(entry.tag)
      || tags.has(entry.tag) || !Number.isSafeInteger(entry.when) || entry.when <= previousWhen) {
      throw new Error(`Invalid migration journal entry at index ${index}`);
    }
    tags.add(entry.tag);
    previousWhen = entry.when;
    return { tag: entry.tag, when: entry.when, hash: createHash("sha256")
      .update(readFileSync(resolve(folder, `${entry.tag}.sql`), "utf8")).digest("hex") };
  });
  const sqlFiles = readdirSync(folder).filter((file) => file.endsWith(".sql"));
  if (sqlFiles.length !== expected.length || sqlFiles.some((file) => !tags.has(file.slice(0, -4)))) {
    throw new Error("Migration SQL files and journal differ");
  }
  return expected;
}

export function assertPostgresMigrationHistory(expected: readonly ExpectedMigration[], applied: readonly AppliedMigration[]): void {
  if (applied.length !== expected.length) throw new Error(`Migration count mismatch: expected ${expected.length}, applied ${applied.length}`);
  const byTime = new Map<number, AppliedMigration>();
  for (const row of applied) {
    const when = row.created_at == null ? Number.NaN : Number(row.created_at);
    if (!Number.isSafeInteger(when) || byTime.has(when)) throw new Error("Invalid or duplicate applied migration timestamp");
    byTime.set(when, row);
  }
  for (const entry of expected) {
    if (byTime.get(entry.when)?.hash !== entry.hash) throw new Error(`Migration timestamp/hash mismatch: ${entry.tag}`);
  }
}

/** Normalize whitespace only outside SQL literals/quoted identifiers. Expected
 * definitions below are the actual PG16 catalog grammar, not reconstructed SQL.
 * Never erase casts, parentheses, token boundaries, or characters inside quotes. */
export function normalizedPgDefinition(value: string): string {
  let result = "";
  let quote: "'" | '"' | null = null;
  let pendingSpace = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote !== null) {
      result += char;
      if (char === quote) {
        if (value[index + 1] === quote) result += value[++index];
        else quote = null;
      }
    } else if (/\s/.test(char)) {
      pendingSpace = true;
    } else {
      if (pendingSpace && result) result += " ";
      pendingSpace = false;
      result += char;
      if (char === "'" || char === '"') quote = char;
    }
  }
  if (quote !== null) throw new Error("Unclosed quote in PostgreSQL catalog definition");
  return result;
}
export const RECENT_PG_CONSTRAINTS = [
  ["alert_events", "alert_events_idempotency_key_unique", "UNIQUE (idempotency_key)"],
  ["alert_events", "ck_alert_events_event", "CHECK ((event = ANY (ARRAY['open'::text, 'refresh'::text, 'ack'::text, 'ack_reset'::text, 'close'::text, 'verify'::text, 'reopen'::text])))"],
  ["alert_events", "ck_alert_events_reason", "CHECK (((reason_code IS NULL) OR (reason_code = ANY (ARRAY['fixed'::text, 'false_positive'::text, 'wont_fix'::text, 'superseded'::text, 'auto_hysteresis'::text, 'manual'::text]))))"],
  ["alert_events", "ck_alert_events_close_reason_required", "CHECK (((event <> 'close'::text) OR (reason_code IS NOT NULL)))"],
  ["alert_events", "ck_alert_events_verify_evidence_required", "CHECK (((event <> 'verify'::text) OR (evidence_ref IS NOT NULL)))"],
  ["alert_events", "alert_events_alert_id_system_alerts_id_fk", "FOREIGN KEY (alert_id) REFERENCES system_alerts(id)"],
  ["alert_events", "alert_events_actor_id_users_id_fk", "FOREIGN KEY (actor_id) REFERENCES users(id)"],
  ["qc_records", "fk_qc_record_quality_case", "FOREIGN KEY (quality_case_id) REFERENCES quality_cases(id)"],
  ["qc_records", "uq_qc_record_quality_case", "UNIQUE (quality_case_id)"],
  ["qc_records", "uq_qc_record_return_ct", "UNIQUE (return_ct_id)"],
  ["qc_records", "uq_qc_record_sh", "UNIQUE (sh_id)"],
  ["qc_lines", "uq_qc_line_receipt_line", "UNIQUE (qc_id, sh_line_id)"],
  ["notification_reads", "pk_notification_reads", "PRIMARY KEY (notification_id, user_id)"],
  ["notification_reads", "notification_reads_notification_id_notifications_id_fk", "FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE"],
  ["notification_reads", "notification_reads_user_id_users_id_fk", "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE"],
  ["sop_execution_drafts", "uq_sop_execution_draft_idempotency", "UNIQUE (idempotency_key)"],
  ["sop_execution_drafts", "uq_sop_execution_draft_bh", "UNIQUE (bh_id)"],
  ["sop_execution_drafts", "ck_sop_execution_draft_round", "CHECK ((cycle_version > 0))"],
  ["sop_execution_drafts", "sop_execution_drafts_cycle_id_sop_cycles_id_fk", "FOREIGN KEY (cycle_id) REFERENCES sop_cycles(id)"],
  ["sop_execution_drafts", "sop_execution_drafts_bh_id_bh_docs_id_fk", "FOREIGN KEY (bh_id) REFERENCES bh_docs(id)"],
  ["sop_execution_drafts", "sop_execution_drafts_planning_version_id_planning_versions_id_fk", "FOREIGN KEY (planning_version_id) REFERENCES planning_versions(id)"],
  ["sop_execution_drafts", "sop_execution_drafts_created_by_users_id_fk", "FOREIGN KEY (created_by) REFERENCES users(id)"],
  ["integration_record_deletions", "ck_integration_record_deletion_reason", "CHECK ((length(btrim(reason)) >= 4))"],
  ["integration_record_deletions", "integration_record_deletions_observed_in_job_id_import_jobs_id_fk", "FOREIGN KEY (observed_in_job_id) REFERENCES import_jobs(id)"],
  ["integration_record_deletions", "integration_record_deletions_acked_by_users_id_fk", "FOREIGN KEY (acked_by) REFERENCES users(id)"],
] as const;

export interface RecentConstraintRow { table_name: string; constraint_name: string; definition: string; validated: boolean }
export function assertRecentPostgresConstraints(rows: readonly RecentConstraintRow[]): void {
  for (const [table, name, definition] of RECENT_PG_CONSTRAINTS) {
    const row = rows.find((item) => item.table_name === table && item.constraint_name === name.slice(0, 63));
    if (!row?.validated || normalizedPgDefinition(row.definition) !== normalizedPgDefinition(definition)) {
      throw new Error(`Missing, unvalidated or changed PostgreSQL constraint: ${table}.${name}`);
    }
  }
}

export const RECENT_PG_INDEXES = [
  { table: "system_alerts", name: "uq_alert_open_dedupe", unique: true, columns: ["category", "dedupe_key"], predicate: "(status = 'open'::text)" },
  { table: "sop_decisions", name: "uq_sop_agree_one_per_signer", unique: true, columns: ["cycle_id", "cycle_version", "decided_by"], predicate: "(decision = 'agree'::text)" },
  { table: "sop_decisions", name: "uq_sop_reject_one_per_role_round", unique: true, columns: ["cycle_id", "cycle_version", "role"], predicate: "(decision = 'reject'::text)" },
  { table: "integration_record_deletions", name: "uq_integration_record_deletion", unique: true, columns: ["connector", "stream", "source_record_id"], predicate: null },
  { table: "integration_record_deletions", name: "ix_integration_record_deletion_stream", unique: false, columns: ["connector", "stream"], predicate: null },
] as const;
export interface RecentIndexRow { table_name: string; index_name: string; valid: boolean; ready: boolean; unique: boolean; columns: string[]; predicate: string | null }
export function assertRecentPostgresIndexes(rows: readonly RecentIndexRow[]): void {
  for (const expected of RECENT_PG_INDEXES) {
    const row = rows.find((item) => item.table_name === expected.table && item.index_name === expected.name);
    if (!row?.valid || !row.ready || row.unique !== expected.unique
      || JSON.stringify(row.columns) !== JSON.stringify(expected.columns)
      || normalizedPgDefinition(row.predicate ?? "") !== normalizedPgDefinition(expected.predicate ?? "")) {
      throw new Error(`Missing, invalid or changed PostgreSQL index: ${expected.table}.${expected.name}`);
    }
  }
}

export interface AlertTriggerRow {
  trigger_name: string; enabled: string; type: number; function_schema: string;
  function_name: string; function_body: string; function_language: string;
  function_returns: string; condition: string | null; argument_count: number;
}
const IMMUTABLE_BODY = "BEGIN RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000'; END;";
export function assertPostgresAlertTriggers(rows: readonly AlertTriggerRow[]): void {
  for (const [name, type] of [["alert_events_append_only", 27], ["alert_events_append_only_truncate", 34]] as const) {
    const row = rows.find((item) => item.trigger_name === name);
    if (!row || !["O", "A"].includes(row.enabled) || row.type !== type || row.condition !== null || row.argument_count !== 0
      || row.function_schema !== "public" || row.function_name !== "reject_immutable_fact_mutation"
      || row.function_language !== "plpgsql" || row.function_returns !== "trigger"
      || normalizedPgDefinition(row.function_body) !== IMMUTABLE_BODY) {
      throw new Error(`Missing, disabled or changed immutable alert trigger: ${name}`);
    }
  }
}

async function main(): Promise<void> {
  const expectedMigrations = expectedPostgresMigrations(resolve(process.cwd(), "drizzle"));
  const url = process.env.DATABASE_URL?.trim();
  if (!url?.startsWith("postgres")) {
    throw new Error("check:postgres requires DATABASE_URL=postgres://...");
  }

  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL search_path = public, pg_catalog");
    await client.query("SET LOCAL statement_timeout = '10s'");
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
        "sku_identifiers",
        "quality_cases",
        "quality_actions",
        "regulatory_records",
        "electronic_label_versions",
        "integration_runs",
        "integration_checkpoints",
        "notifications",
        "aliases",
        "alias_exceptions",
        "data_product_outcome_events",
        "report_read_model_cache",
        "alert_events", "integration_record_deletions", "job_locks", "notification_reads", "sop_execution_drafts",
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
      "sku_identifiers",
      "quality_cases",
      "quality_actions",
      "regulatory_records",
      "electronic_label_versions",
      "integration_runs",
      "integration_checkpoints",
      "notifications",
      "aliases",
      "alias_exceptions",
      "data_product_outcome_events",
      "report_read_model_cache",
      "alert_events", "integration_record_deletions", "job_locks", "notification_reads", "sop_execution_drafts",
    ].filter((name) => !found.has(name));
    if (missing.length) throw new Error(`Missing migrated tables: ${missing.join(", ")}`);

    const readModelColumns = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'report_read_model_cache'
          and column_name = any($1::text[])`,
      [["key", "source_binding", "payload", "built_at"]],
    );
    const readModelColumnMap = new Map(
      readModelColumns.rows.map((row) => [row.column_name, row]),
    );
    if (
      readModelColumnMap.get("key")?.data_type !== "text"
      || readModelColumnMap.get("key")?.is_nullable !== "NO"
      || readModelColumnMap.get("source_binding")?.data_type !== "text"
      || readModelColumnMap.get("source_binding")?.is_nullable !== "NO"
      || readModelColumnMap.get("payload")?.data_type !== "jsonb"
      || readModelColumnMap.get("payload")?.is_nullable !== "NO"
      || readModelColumnMap.get("built_at")?.data_type !== "timestamp with time zone"
      || readModelColumnMap.get("built_at")?.is_nullable !== "NO"
    ) {
      throw new Error("report_read_model_cache migration contract is incomplete");
    }

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

    const notificationLeaseColumns = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'notifications'
          and column_name = any($1::text[])`,
      [["dispatch_started_at", "attempt_count"]],
    );
    const notificationColumns = new Map(
      notificationLeaseColumns.rows.map((row) => [row.column_name, row]),
    );
    const dispatchStartedAt = notificationColumns.get("dispatch_started_at");
    const attemptCount = notificationColumns.get("attempt_count");
    if (
      dispatchStartedAt?.data_type !== "timestamp with time zone"
      || dispatchStartedAt.is_nullable !== "YES"
      || attemptCount?.data_type !== "integer"
      || attemptCount.is_nullable !== "NO"
      || !attemptCount.column_default?.includes("0")
    ) {
      throw new Error("notifications dispatch lease migration contract is missing");
    }

    const skuGovernanceColumns = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select table_name, column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public'
          and (
            (table_name = 'skus' and column_name = any($1::text[]))
            or (table_name = 'sku_params' and column_name = 'logistics_lead_days')
          )`,
      [["commercial_role", "short_name", "channel_id"]],
    );
    const skuGovernanceColumnMap = new Map(
      skuGovernanceColumns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
    );
    const commercialRole = skuGovernanceColumnMap.get("skus.commercial_role");
    const shortName = skuGovernanceColumnMap.get("skus.short_name");
    const channelId = skuGovernanceColumnMap.get("skus.channel_id");
    const logisticsLeadDays = skuGovernanceColumnMap.get("sku_params.logistics_lead_days");
    if (
      commercialRole?.data_type !== "text"
      || commercialRole.is_nullable !== "NO"
      || !commercialRole.column_default?.includes("unclassified")
      || shortName?.data_type !== "text"
      || shortName.is_nullable !== "YES"
      || channelId?.data_type !== "integer"
      || channelId.is_nullable !== "YES"
      || logisticsLeadDays?.data_type !== "integer"
      || logisticsLeadDays.is_nullable !== "YES"
    ) {
      throw new Error("SKU governance/logistics lead-time migration contract is missing");
    }

    const aliasScopeColumns = await client.query<{
      table_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select table_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public'
          and table_name = any($1::text[])
          and column_name = 'scope'`,
      [["aliases", "alias_exceptions"]],
    );
    const aliasScopeColumnMap = new Map(
      aliasScopeColumns.rows.map((row) => [row.table_name, row]),
    );
    for (const table of ["aliases", "alias_exceptions"]) {
      const scope = aliasScopeColumnMap.get(table);
      if (
        scope?.data_type !== "text"
        || scope.is_nullable !== "NO"
        || !scope.column_default?.includes("GLOBAL")
      ) {
        throw new Error(`${table}.scope migration contract is missing`);
      }
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
          and t.tgenabled in ('O', 'A')
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
        "data_product_outcome_chain_identity",
        "data_product_outcomes_append_only",
        "data_product_outcomes_append_only_truncate",
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
      "data_product_outcome_events:data_product_outcome_chain_identity",
      "data_product_outcome_events:data_product_outcomes_append_only",
      "data_product_outcome_events:data_product_outcomes_append_only_truncate",
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
      "ck_notify_attempt_count",
      "ck_skus_commercial_role",
      "ck_skus_short_name_length",
      "ck_sku_params_logistics_lead_days",
      "uq_sku_identifier_scope_value",
      "ck_sku_identifier_kind",
      "ck_sku_identifier_packaging_level",
      "ck_sku_identifier_scope",
      "ck_sku_identifier_gtin_level",
      "uq_alias_type_scope_value",
      "uq_alias_exc_type_scope_value",
      "data_product_outcome_events_idempotency_key_unique",
      "ck_data_product_outcome_decision",
      "ck_data_product_outcome_result",
      "ck_data_product_outcome_handling",
      "ck_data_product_outcome_saved_hours",
      "ck_data_product_outcome_currency",
      "ck_data_product_outcome_reason",
      "ck_data_product_outcome_reason_required",
      "ck_data_product_outcome_evidence_required",
      "ck_data_product_outcome_no_self_supersede",
    ];
    const locationConstraints = await client.query<{ conname: string }>(
      `select conname
         from pg_constraint
        where connamespace = 'public'::regnamespace
          and convalidated
          and conname = any($1::text[])`,
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

    const outcomeChainFk = await client.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
         from pg_constraint
        where contype = 'f'
          and conrelid = 'data_product_outcome_events'::regclass
          and confrelid = 'data_product_outcome_events'::regclass`,
    );
    if (!outcomeChainFk.rows.some((row) => row.definition.startsWith("FOREIGN KEY (supersedes_id) REFERENCES "))) {
      throw new Error("Missing data_product_outcome_events.supersedes_id self-reference constraint");
    }

    const requiredOutcomeIndexes = [
      "ix_data_product_outcome_product_date",
      "uq_data_product_outcome_root",
      "uq_data_product_outcome_supersedes",
    ];
    const outcomeIndexes = await client.query<{ indexname: string }>(
      `select indexname
         from pg_indexes
        where schemaname = 'public'
          and tablename = 'data_product_outcome_events'
          and indexname = any($1::text[])`,
      [requiredOutcomeIndexes],
    );
    const foundOutcomeIndexes = new Set(outcomeIndexes.rows.map((row) => row.indexname));
    const missingOutcomeIndexes = requiredOutcomeIndexes.filter((name) => !foundOutcomeIndexes.has(name));
    if (missingOutcomeIndexes.length) {
      throw new Error(`Missing data product outcome indexes: ${missingOutcomeIndexes.join(", ")}`);
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

    const requiredSkuIdentifierIndexes = [
      "uq_sku_identifier_primary_slot",
      "ix_sku_identifier_sku_active",
    ];
    const skuIdentifierIndexes = await client.query<{ indexname: string }>(
      `select indexname
         from pg_indexes
        where schemaname = 'public'
          and tablename = 'sku_identifiers'
          and indexname = any($1::text[])`,
      [requiredSkuIdentifierIndexes],
    );
    const foundSkuIdentifierIndexes = new Set(
      skuIdentifierIndexes.rows.map((row) => row.indexname),
    );
    const missingSkuIdentifierIndexes = requiredSkuIdentifierIndexes
      .filter((name) => !foundSkuIdentifierIndexes.has(name));
    if (missingSkuIdentifierIndexes.length) {
      throw new Error(
        `Missing SKU identifier indexes: ${missingSkuIdentifierIndexes.join(", ")}`,
      );
    }

    const recentConstraints = await client.query<RecentConstraintRow>(
      `select c.relname as table_name, k.conname as constraint_name,
              pg_get_constraintdef(k.oid) as definition, k.convalidated as validated
         from pg_constraint k join pg_class c on c.oid = k.conrelid
        where k.connamespace = 'public'::regnamespace and k.conname = any($1::text[])`,
      [RECENT_PG_CONSTRAINTS.map(([, name]) => name.slice(0, 63))],
    );
    assertRecentPostgresConstraints(recentConstraints.rows);

    const recentIndexes = await client.query<RecentIndexRow>(
      `select c.relname as table_name, x.relname as index_name,
              i.indisvalid as valid, i.indisready as ready, i.indisunique as "unique",
              array(select pg_get_indexdef(i.indexrelid, k, true)
                      from generate_series(1, i.indnkeyatts) k order by k) as columns,
              pg_get_expr(i.indpred, i.indrelid) as predicate
         from pg_index i join pg_class c on c.oid = i.indrelid
         join pg_class x on x.oid = i.indexrelid
        where c.relnamespace = 'public'::regnamespace and x.relname = any($1::text[])`,
      [RECENT_PG_INDEXES.map((item) => item.name)],
    );
    assertRecentPostgresIndexes(recentIndexes.rows);

    const alertTriggers = await client.query<AlertTriggerRow>(
      `select t.tgname as trigger_name, t.tgenabled as enabled, t.tgtype::int as type,
              n.nspname as function_schema, p.proname as function_name, p.prosrc as function_body,
              l.lanname as function_language, format_type(p.prorettype, null) as function_returns,
              t.tgqual::text as condition, t.tgnargs::int as argument_count
         from pg_trigger t join pg_proc p on p.oid = t.tgfoid
         join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
        where t.tgrelid = 'public.alert_events'::regclass and not t.tgisinternal
          and t.tgname = any($1::text[])`,
      [["alert_events_append_only", "alert_events_append_only_truncate"]],
    );
    assertPostgresAlertTriggers(alertTriggers.rows);

    const migrations = await client.query<AppliedMigration>(
      "select hash, created_at from drizzle.__drizzle_migrations order by created_at, id",
    );
    assertPostgresMigrationHistory(expectedMigrations, migrations.rows);
    const applied = migrations.rows.length;

    console.log(JSON.stringify({
      ok: true,
      engine: "postgresql",
      appliedMigrations: applied,
      journalMatched: true,
      requiredTables: [...found].sort(),
      sessionVersion: column,
      inspectionSiteKey: inspectionSiteKeyColumn.rows[0],
      notificationLeaseColumns: [...notificationColumns.values()],
      skuGovernanceColumns: [...skuGovernanceColumnMap.values()],
      aliasScopeColumns: [...aliasScopeColumnMap.values()],
      immutableTriggers: [...triggerPairs].sort(),
      locationConstraints: [...foundConstraints].sort(),
      versionChainSelfReferences: [...versionChainSelfReferences].sort(),
      outcomeIndexes: [...foundOutcomeIndexes].sort(),
      supplierLifecycleIndexes: [...foundLifecycleIndexes].sort(),
      qualityComplianceIndexes: [...foundQualityIndexes].sort(),
      skuIdentifierIndexes: [...foundSkuIdentifierIndexes].sort(),
      recentConstraints: recentConstraints.rows.map((row) => `${row.table_name}.${row.constraint_name}`).sort(),
      recentIndexes: recentIndexes.rows.map((row) => `${row.table_name}.${row.index_name}`).sort(),
      alertImmutableTriggers: alertTriggers.rows.map((row) => row.trigger_name).sort(),
    }, null, 2));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

// Pure contract helpers are imported by tests; only the documented CLI entry opens PG.
if (process.argv[1] && resolve(process.argv[1]) === resolve(process.cwd(), "scripts/verify-postgres.ts")) {
  void main().catch((error) => {
    console.error(`PostgreSQL contract failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
