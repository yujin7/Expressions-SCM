/**
 * 三方数据来源证据矩阵。
 *
 * 它把“代码有连接器”“数据库见过批次”“业务数据可观察”“已通过 UAT 可作为运营事实”
 * 四件事分开，避免把 token、一次成功运行或静态目录误报成数据产品已放行。
 */
import { sql, type SQL } from "drizzle-orm";

import {
  getConnectorReadiness,
  type ConnectorContractSelectionState,
  type ConnectorIdentityEvidence,
  type ConnectorIdentityScope,
  type ConnectorReadiness,
} from "@/server/integrations/connector";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

export type DataSourceKey = "SCM" | "JIANDAOYUN" | "JST" | "YONYOU";
export type DataSourceState = "operational" | "observation" | "contract_only" | "blocked";

export interface DataSourceReadiness {
  key: DataSourceKey;
  label: string;
  state: DataSourceState;
  configured: boolean;
  enabled: boolean;
  contractSelectionState: ConnectorContractSelectionState;
  selectedContractCount: number;
  successfulStreams: number;
  successfulStreamKeys: string[];
  latestFailedStreams: number;
  latestRunningStreams: number;
  sourceRows: number;
  stagedRows: number;
  rejectedRows: number;
  latestRunAt: string | null;
  lastSuccessAt: string | null;
  sourceAsOfStart: string | null;
  sourceAsOfEnd: string | null;
  openIdentityExceptions: number | null;
  observedIdentities: number | null;
  gate: string;
  nextAction: string;
}

interface SourceRunAggregate {
  connector: string;
  successful_streams: unknown;
  successful_stream_keys: unknown;
  source_rows: unknown;
  staged_rows: unknown;
  rejected_rows: unknown;
  last_success_at: unknown;
  source_as_of_start: unknown;
  source_as_of_end: unknown;
}

interface LatestRunAggregate {
  connector: string;
  latest_failed_streams: unknown;
  latest_running_streams: unknown;
  latest_run_at: unknown;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as T[] : [];
}

function intValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function instant(value: unknown): string | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function dateValue(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function streamKeys(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function loadIdentityEvidence(
  db: ReadDb,
): Promise<Partial<Record<ConnectorIdentityScope, ConnectorIdentityEvidence>>> {
  const result = await db.execute(sql`
    WITH scopes(scope) AS (
      VALUES ('JST'), ('JIANDAOYUN'), ('YONYOU')
    )
    SELECT s.scope,
      (SELECT count(*)::int FROM alias_exceptions ae
        WHERE ae.scope = s.scope AND ae.status = 'open') AS open_exceptions,
      (SELECT count(*)::int FROM alias_exceptions ae
        WHERE ae.scope = s.scope AND ae.status IN ('open', 'ignored'))
      + (SELECT count(*)::int FROM aliases a WHERE a.scope = s.scope)
      + (SELECT count(*)::int FROM sku_identifiers si
          WHERE si.scope = s.scope AND si.active = true) AS observed_identities
    FROM scopes s
  `);
  const evidence: Partial<Record<ConnectorIdentityScope, ConnectorIdentityEvidence>> = {};
  for (const row of resultRows<Record<string, unknown>>(result)) {
    const scope = String(row.scope) as ConnectorIdentityScope;
    if (!(["JST", "JIANDAOYUN", "YONYOU"] as const).includes(scope)) continue;
    evidence[scope] = {
      openExceptions: intValue(row.open_exceptions),
      observedIdentities: intValue(row.observed_identities),
    };
  }
  return evidence;
}

async function loadRunEvidence(db: ReadDb) {
  const [successResult, latestResult] = await Promise.all([
    db.execute(sql`
      WITH ranked AS (
        SELECT ir.*, ij.source_as_of,
          row_number() OVER (PARTITION BY ir.connector, ir.stream ORDER BY ir.id DESC) AS rn
        FROM integration_runs ir
        LEFT JOIN import_jobs ij ON ij.id = ir.import_job_id
        WHERE ir.status = 'succeeded'
      )
      SELECT connector,
        count(*)::int AS successful_streams,
        string_agg(stream, ',' ORDER BY stream) AS successful_stream_keys,
        coalesce(sum(source_rows), 0)::int AS source_rows,
        coalesce(sum(staged_rows), 0)::int AS staged_rows,
        coalesce(sum(rejected_rows), 0)::int AS rejected_rows,
        max(finished_at) AS last_success_at,
        min(source_as_of) AS source_as_of_start,
        max(source_as_of) AS source_as_of_end
      FROM ranked WHERE rn = 1
      GROUP BY connector
    `),
    db.execute(sql`
      WITH ranked AS (
        SELECT ir.*,
          row_number() OVER (PARTITION BY ir.connector, ir.stream ORDER BY ir.id DESC) AS rn
        FROM integration_runs ir
      )
      SELECT connector,
        count(*) FILTER (WHERE status = 'failed')::int AS latest_failed_streams,
        count(*) FILTER (WHERE status = 'running')::int AS latest_running_streams,
        max(started_at) AS latest_run_at
      FROM ranked WHERE rn = 1
      GROUP BY connector
    `),
  ]);
  return {
    successes: new Map(
      resultRows<SourceRunAggregate>(successResult).map((row) => [row.connector, row]),
    ),
    latest: new Map(
      resultRows<LatestRunAggregate>(latestResult).map((row) => [row.connector, row]),
    ),
  };
}

function connectorSource(
  key: DataSourceKey,
  readiness: ConnectorReadiness,
  success: SourceRunAggregate | undefined,
  latest: LatestRunAggregate | undefined,
): DataSourceReadiness {
  const successfulStreams = intValue(success?.successful_streams);
  const latestFailedStreams = intValue(latest?.latest_failed_streams);
  const latestRunningStreams = intValue(latest?.latest_running_streams);
  const enabled = ["not_required", "enabled"].includes(readiness.enablementState);
  const state: DataSourceState = readiness.operational && successfulStreams > 0
    ? "operational"
    : successfulStreams > 0
      ? "observation"
      : readiness.implementation === "ready"
        ? "contract_only"
        : "blocked";
  const observedGate = successfulStreams > 0
    ? `${successfulStreams} 条数据流已有最近成功证据，但连接器仍未同时通过配置、身份、控制总量与 UAT 门禁。`
    : "尚无成功数据流证据；代码或凭据存在不能证明业务数据可用。";
  return {
    key,
    label: readiness.label,
    state,
    configured: readiness.configured,
    enabled,
    contractSelectionState: readiness.contractSelectionState,
    selectedContractCount: readiness.selectedContractCount,
    successfulStreams,
    successfulStreamKeys: streamKeys(success?.successful_stream_keys),
    latestFailedStreams,
    latestRunningStreams,
    sourceRows: intValue(success?.source_rows),
    stagedRows: intValue(success?.staged_rows),
    rejectedRows: intValue(success?.rejected_rows),
    latestRunAt: instant(latest?.latest_run_at),
    lastSuccessAt: instant(success?.last_success_at),
    sourceAsOfStart: dateValue(success?.source_as_of_start),
    sourceAsOfEnd: dateValue(success?.source_as_of_end),
    openIdentityExceptions: readiness.openScopedAliasExceptions,
    observedIdentities: readiness.observedScopedIdentities,
    gate: state === "operational"
      ? "当前连接器与身份门禁已通过；具体数据产品仍须满足各自控制总量和业务口径。"
      : observedGate,
    nextAction: readiness.blocker ?? "持续监控运行、时效、覆盖和身份异常。",
  };
}

export async function loadDataSourceReadiness(
  db: ReadDb,
  options: { env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<DataSourceReadiness[]> {
  const now = options.now ?? new Date();
  const [identityEvidence, runEvidence, scmResult] = await Promise.all([
    loadIdentityEvidence(db),
    loadRunEvidence(db),
    db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM skus) AS sku_count,
        (SELECT count(*)::int FROM stock_balances) AS balance_count,
        (SELECT count(*)::int FROM stock_ledger) AS ledger_count
    `),
  ]);
  const connectorRows = getConnectorReadiness(
    options.env ?? process.env,
    now,
    identityEvidence,
  );
  const byKey = new Map(connectorRows.map((row) => [row.key, row]));
  const [scm = {}] = resultRows<Record<string, unknown>>(scmResult);
  const skuCount = intValue(scm.sku_count);
  const balanceCount = intValue(scm.balance_count);
  const ledgerCount = intValue(scm.ledger_count);

  const internal: DataSourceReadiness = {
    key: "SCM",
    label: "SCM 受控事实",
    state: "operational",
    configured: true,
    enabled: true,
    contractSelectionState: "not_required",
    selectedContractCount: 0,
    successfulStreams: 0,
    successfulStreamKeys: [],
    latestFailedStreams: 0,
    latestRunningStreams: 0,
    sourceRows: skuCount + balanceCount + ledgerCount,
    stagedRows: 0,
    rejectedRows: 0,
    latestRunAt: null,
    lastSuccessAt: null,
    sourceAsOfStart: null,
    sourceAsOfEnd: null,
    openIdentityExceptions: null,
    observedIdentities: skuCount,
    gate: "主档、库存余额与只追加库存流水受 SCM 事务、审计和 posting 门禁约束。",
    nextAction: "继续修复未分批、来源不明与外部身份覆盖，不允许外部观察绕过 posting。",
  };

  const specs: { source: DataSourceKey; connector: "jdy" | "jst" | "yy" }[] = [
    { source: "JIANDAOYUN", connector: "jdy" },
    { source: "JST", connector: "jst" },
    { source: "YONYOU", connector: "yy" },
  ];
  return [
    internal,
    ...specs.map(({ source, connector }) => {
      const readiness = byKey.get(connector);
      if (!readiness) {
        return {
          key: source,
          label: source,
          state: "blocked" as const,
          configured: false,
          enabled: false,
          contractSelectionState: "missing" as const,
          selectedContractCount: 0,
          successfulStreams: 0,
          successfulStreamKeys: [],
          latestFailedStreams: 0,
          latestRunningStreams: 0,
          sourceRows: 0,
          stagedRows: 0,
          rejectedRows: 0,
          latestRunAt: null,
          lastSuccessAt: null,
          sourceAsOfStart: null,
          sourceAsOfEnd: null,
          openIdentityExceptions: null,
          observedIdentities: null,
          gate: "连接器未登记。",
          nextAction: "先登记显式只读契约和安全边界。",
        };
      }
      return connectorSource(
        source,
        readiness,
        runEvidence.successes.get(connector === "yy" ? "yonyou" : connector),
        runEvidence.latest.get(connector === "yy" ? "yonyou" : connector),
      );
    }),
  ];
}
