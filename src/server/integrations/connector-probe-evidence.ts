/**
 * 外部连接器只读权限探测的最小、可持久化证据。
 *
 * 该对象会被 JSON 写入 job_runs.message，因此故意使用紧凑键名，并且仅允许
 * 固定枚举、数量、安全错误码和非秘密配置绑定。不得放入 token、端点、租户/组织、
 * 外部编码、源行或任何业务值。
 */

export const CONNECTOR_PROBE_VERSION = "connector-probe/v1" as const;
/** 每日两次探测；留 2 小时调度/外部报障容差。 */
export const CONNECTOR_PROBE_MAX_AGE_HOURS = 26;
export const CONNECTOR_PROBE_JOB_NAMES = {
  jst: "probe-jst-permissions",
  yy: "probe-yonyou-permissions",
} as const;

export type ConnectorProbeKey = keyof typeof CONNECTOR_PROBE_JOB_NAMES;
export type ConnectorProbeStatus = "succeeded" | "partial" | "skipped";
export type ConnectorProbeAuthentication = "validated" | "not_validated" | "not_checked";

export interface ConnectorProbeEvidence {
  /** schema version */
  v: typeof CONNECTOR_PROBE_VERSION;
  /** connector */
  c: ConnectorProbeKey;
  /** aggregate state */
  s: ConnectorProbeStatus;
  /** authentication state */
  a: ConnectorProbeAuthentication;
  /** passed / total */
  p: number;
  t: number;
  /** ordered per-check result: ok | not_checked | bounded error category */
  r: string[];
  /** non-secret configuration/UAT binding */
  b: string | null;
  /** invariant: probes never write vendor business data */
  w: false;
}

export const JST_PROBE_CHECKS = [
  { id: "shops", label: "店铺" },
  { id: "warehouses", label: "仓库" },
  { id: "outboundSales", label: "销售出库" },
  { id: "inventory", label: "现存量" },
  { id: "itemMaster", label: "商品档案" },
  { id: "inboundReceipts", label: "采购入库" },
] as const;

const SAFE_RESULT = /^(?:ok|not_checked|missing_configuration|invalid_configuration|invalid_actor|network_or_timeout|unexpected_response|http_[1-5]\d{2}|api_code_[A-Za-z0-9_-]{1,24})$/;
const SAFE_BINDING = /^(?:JST1|YY1)_[A-Z0-9]{8,48}$/;

export function safeConnectorProbeResult(value: unknown): string {
  return typeof value === "string" && SAFE_RESULT.test(value)
    ? value
    : "unexpected_response";
}

export function connectorProbeEvidence(input: Omit<ConnectorProbeEvidence, "v" | "w">): ConnectorProbeEvidence {
  const expectedTotal = input.c === "jst" ? JST_PROBE_CHECKS.length : 8;
  const results = input.r.slice(0, expectedTotal).map(safeConnectorProbeResult);
  while (results.length < expectedTotal) results.push("not_checked");
  const passed = results.filter((result) => result === "ok").length;
  return {
    v: CONNECTOR_PROBE_VERSION,
    c: input.c,
    s: input.s === "skipped"
      ? "skipped"
      : passed === expectedTotal ? "succeeded" : "partial",
    a: input.a,
    p: passed,
    t: expectedTotal,
    r: results,
    b: typeof input.b === "string" && SAFE_BINDING.test(input.b) ? input.b : null,
    w: false,
  };
}

/** Fail closed when stored job output was truncated, tampered with, or came from another task. */
export function parseConnectorProbeEvidence(value: unknown): ConnectorProbeEvidence | null {
  if (typeof value !== "string" || value.length > 500) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Partial<ConnectorProbeEvidence>;
  if (
    row.v !== CONNECTOR_PROBE_VERSION
    || (row.c !== "jst" && row.c !== "yy")
    || !["succeeded", "partial", "skipped"].includes(String(row.s))
    || !["validated", "not_validated", "not_checked"].includes(String(row.a))
    || row.w !== false
    || !Array.isArray(row.r)
  ) return null;
  const expectedTotal = row.c === "jst" ? JST_PROBE_CHECKS.length : 8;
  if (
    row.t !== expectedTotal
    || row.r.length !== expectedTotal
    || row.r.some((result) => typeof result !== "string" || !SAFE_RESULT.test(result))
    || !Number.isSafeInteger(row.p)
    || Number(row.p) < 0
    || Number(row.p) > expectedTotal
    || Number(row.p) !== row.r.filter((result) => result === "ok").length
    || (row.b !== null && (typeof row.b !== "string" || !SAFE_BINDING.test(row.b)))
  ) return null;
  const statusByPassed = row.s === "skipped"
    ? "skipped"
    : row.p === expectedTotal ? "succeeded" : "partial";
  if (row.s !== statusByPassed) return null;
  return row as ConnectorProbeEvidence;
}
