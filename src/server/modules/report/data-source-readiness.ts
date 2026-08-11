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
import { JIANDAOYUN_FORM_CONTRACTS } from "@/server/integrations/jiandaoyun-contracts";
import { YONYOU_READ_CONTRACTS } from "@/server/integrations/yonyou-contracts";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

export type DataSourceKey = "SCM" | "JIANDAOYUN" | "JST" | "YONYOU";
export type DataSourceState = "operational" | "observation" | "contract_only" | "blocked";
export type DataStreamFreshness = "current" | "stale" | "unknown";

export interface DataStreamEvidence {
  stream: string;
  latestStatus: "running" | "succeeded" | "failed";
  latestRunAt: string;
  lastSuccessAt: string | null;
  sourceAsOf: string | null;
  sourceRows: number;
  stagedRows: number;
  rejectedRows: number;
  releaseBlocked: boolean;
  emptySource: boolean;
  freshnessMaxAgeDays: number | null;
  businessAgeDays: number | null;
  pipelineAgeHours: number | null;
  freshness: DataStreamFreshness;
}

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
  streams: DataStreamEvidence[];
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

interface StreamRunAggregate {
  connector: string;
  stream: string;
  latest_status: unknown;
  latest_run_at: unknown;
  last_success_at: unknown;
  source_as_of: unknown;
  source_rows: unknown;
  staged_rows: unknown;
  rejected_rows: unknown;
  request_scope: unknown;
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

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function ageSince(value: string | null, now: Date, divisor: number): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const elapsed = now.getTime() - parsed;
  if (elapsed < 0) return null;
  return Math.round((elapsed / divisor) * 10) / 10;
}

function yonyouStream(path: string): string {
  return path.replace(/^\/+/, "").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
}

const STREAM_FRESHNESS_DAYS = new Map<string, number>([
  ...JIANDAOYUN_FORM_CONTRACTS.flatMap((contract) => contract.freshnessMaxAgeDays == null
    ? []
    : [[`jdy\u0000${contract.key}`, contract.freshnessMaxAgeDays] as const]),
  ["jst\u0000outbound-sales-daily", 2],
  ["jst\u0000inventory-total-delta", 1],
  ...YONYOU_READ_CONTRACTS.map((contract) => [
    `yonyou\u0000${yonyouStream(contract.path)}`,
    contract.domain === "inventory" || contract.domain === "procurement"
      ? 2
      : contract.domain === "finance" ? 35 : 30,
  ] as const),
]);

function streamEvidence(row: StreamRunAggregate, now: Date): DataStreamEvidence {
  const scope = objectValue(row.request_scope);
  const sourceAsOf = dateValue(row.source_as_of)
    ?? dateValue(scope.sourceAsOf)
    ?? dateValue(scope.bizDate)
    ?? dateValue(scope.observedAt);
  const lastSuccessAt = instant(row.last_success_at);
  const businessAgeDays = sourceAsOf
    ? ageSince(`${sourceAsOf}T00:00:00.000Z`, now, 86_400_000)
    : null;
  const pipelineAgeHours = ageSince(lastSuccessAt, now, 3_600_000);
  const freshnessMaxAgeDays = STREAM_FRESHNESS_DAYS.get(`${row.connector}\u0000${row.stream}`) ?? null;
  const comparableAgeDays = businessAgeDays ?? (pipelineAgeHours == null ? null : pipelineAgeHours / 24);
  const freshness: DataStreamFreshness = freshnessMaxAgeDays == null || comparableAgeDays == null
    ? "unknown"
    : comparableAgeDays > freshnessMaxAgeDays ? "stale" : "current";
  const latestStatus = String(row.latest_status);
  return {
    stream: row.stream,
    latestStatus: latestStatus === "succeeded" || latestStatus === "failed" ? latestStatus : "running",
    latestRunAt: instant(row.latest_run_at) ?? now.toISOString(),
    lastSuccessAt,
    sourceAsOf,
    sourceRows: intValue(row.source_rows),
    stagedRows: intValue(row.staged_rows),
    rejectedRows: intValue(row.rejected_rows),
    releaseBlocked: scope.releaseBlocked === true,
    emptySource: scope.emptySource === true,
    freshnessMaxAgeDays,
    businessAgeDays,
    pipelineAgeHours,
    freshness,
  };
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

async function loadRunEvidence(db: ReadDb, now: Date) {
  const [successResult, latestResult, streamResult] = await Promise.all([
    db.execute(sql`
      WITH ranked AS (
        SELECT ir.*, ij.source_as_of,
          CASE WHEN ir.connector IN ('yy', 'yonyou') THEN 'yonyou' ELSE ir.connector END AS connector_key,
          row_number() OVER (
            PARTITION BY CASE WHEN ir.connector IN ('yy', 'yonyou') THEN 'yonyou' ELSE ir.connector END, ir.stream
            ORDER BY ir.id DESC
          ) AS rn
        FROM integration_runs ir
        LEFT JOIN import_jobs ij ON ij.id = ir.import_job_id
        WHERE ir.status = 'succeeded'
      )
      SELECT connector_key AS connector,
        count(*)::int AS successful_streams,
        string_agg(stream, ',' ORDER BY stream) AS successful_stream_keys,
        coalesce(sum(source_rows), 0)::int AS source_rows,
        coalesce(sum(staged_rows), 0)::int AS staged_rows,
        coalesce(sum(rejected_rows), 0)::int AS rejected_rows,
        max(finished_at) AS last_success_at,
        min(source_as_of) AS source_as_of_start,
        max(source_as_of) AS source_as_of_end
      FROM ranked WHERE rn = 1
      GROUP BY connector_key
    `),
    db.execute(sql`
      WITH ranked AS (
        SELECT ir.*,
          CASE WHEN ir.connector IN ('yy', 'yonyou') THEN 'yonyou' ELSE ir.connector END AS connector_key,
          row_number() OVER (
            PARTITION BY CASE WHEN ir.connector IN ('yy', 'yonyou') THEN 'yonyou' ELSE ir.connector END, ir.stream
            ORDER BY ir.id DESC
          ) AS rn
        FROM integration_runs ir
      )
      SELECT connector_key AS connector,
        count(*) FILTER (WHERE status = 'failed')::int AS latest_failed_streams,
        count(*) FILTER (WHERE status = 'running')::int AS latest_running_streams,
        max(started_at) AS latest_run_at
      FROM ranked WHERE rn = 1
      GROUP BY connector_key
    `),
    db.execute(sql`
      WITH latest_any AS (
        SELECT ir.*,
          CASE WHEN ir.connector IN ('yy', 'yonyou') THEN 'yonyou' ELSE ir.connector END AS connector_key,
          row_number() OVER (
            PARTITION BY CASE WHEN ir.connector IN ('yy', 'yonyou') THEN 'yonyou' ELSE ir.connector END, ir.stream
            ORDER BY ir.id DESC
          ) AS rn
        FROM integration_runs ir
      ), latest_success AS (
        SELECT ir.*, ij.source_as_of,
          CASE WHEN ir.connector IN ('yy', 'yonyou') THEN 'yonyou' ELSE ir.connector END AS connector_key,
          row_number() OVER (
            PARTITION BY CASE WHEN ir.connector IN ('yy', 'yonyou') THEN 'yonyou' ELSE ir.connector END, ir.stream
            ORDER BY ir.id DESC
          ) AS rn
        FROM integration_runs ir
        LEFT JOIN import_jobs ij ON ij.id = ir.import_job_id
        WHERE ir.status = 'succeeded'
      )
      SELECT la.connector_key AS connector, la.stream,
        la.status AS latest_status,
        la.started_at AS latest_run_at,
        ls.finished_at AS last_success_at,
        ls.source_as_of,
        coalesce(ls.source_rows, 0)::int AS source_rows,
        coalesce(ls.staged_rows, 0)::int AS staged_rows,
        coalesce(ls.rejected_rows, 0)::int AS rejected_rows,
        ls.request_scope
      FROM latest_any la
      LEFT JOIN latest_success ls
        ON ls.connector_key = la.connector_key AND ls.stream = la.stream AND ls.rn = 1
      WHERE la.rn = 1
      ORDER BY la.connector_key, la.stream
    `),
  ]);
  const streamsByConnector = new Map<string, DataStreamEvidence[]>();
  for (const row of resultRows<StreamRunAggregate>(streamResult)) {
    const rows = streamsByConnector.get(row.connector) ?? [];
    rows.push(streamEvidence(row, now));
    streamsByConnector.set(row.connector, rows);
  }
  return {
    successes: new Map(
      resultRows<SourceRunAggregate>(successResult).map((row) => [row.connector, row]),
    ),
    latest: new Map(
      resultRows<LatestRunAggregate>(latestResult).map((row) => [row.connector, row]),
    ),
    streams: streamsByConnector,
  };
}

function connectorSource(
  key: DataSourceKey,
  readiness: ConnectorReadiness,
  success: SourceRunAggregate | undefined,
  latest: LatestRunAggregate | undefined,
  streams: DataStreamEvidence[],
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
    streams,
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
    loadRunEvidence(db, now),
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
    streams: [],
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
          streams: [],
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
        runEvidence.streams.get(connector === "yy" ? "yonyou" : connector) ?? [],
      );
    }),
  ];
}
