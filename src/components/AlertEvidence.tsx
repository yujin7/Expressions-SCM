"use client";

/**
 * 告警证据块（D56/D57 引擎字段）：规则来源 sourceRule、参数快照 paramsSnapshot（服务端已脱敏）、
 * 可选的 why（另一领域正在服务端补，缺失时不渲染）、已知悉人/时间。
 * /alerts 与 /inventory/alerts 的爆单/预警表共用，避免两处各画一套。
 */
import { Space, Tag, Typography } from "antd";

export interface AlertWhy { label: string; value: string; source: string }

export interface AlertEvidenceFields {
  sourceRule?: string | null;
  paramsSnapshot?: Record<string, unknown> | null;
  why?: AlertWhy[] | null;
  ackedAt?: string | null;
  ackedBy?: number | null;
  ackedByName?: string | null;
}

function fmtVal(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function ackText(a: Pick<AlertEvidenceFields, "ackedAt" | "ackedBy" | "ackedByName">): string {
  if (!a.ackedAt) return "未知悉";
  const who = a.ackedByName ?? (a.ackedBy != null ? `#${a.ackedBy}` : "—");
  return `${who} · ${String(a.ackedAt).replace("T", " ").slice(0, 16)}`;
}

export default function AlertEvidence({ alert }: { alert: AlertEvidenceFields }) {
  const params = alert.paramsSnapshot && typeof alert.paramsSnapshot === "object" && !Array.isArray(alert.paramsSnapshot)
    ? Object.entries(alert.paramsSnapshot)
    : [];
  const why = Array.isArray(alert.why) ? alert.why : [];
  return (
    <Space direction="vertical" size={6} style={{ width: "100%", fontSize: 12 }}>
      {why.length ? (
        <div>
          <Typography.Text strong>为什么触发</Typography.Text>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {why.map((w, i) => (
              <li key={`${w.label}-${i}`}>{w.label}：{w.value} <Typography.Text type="secondary">（{w.source}）</Typography.Text></li>
            ))}
          </ul>
        </div>
      ) : null}
      <div><Typography.Text type="secondary">规则：</Typography.Text>{alert.sourceRule ?? "—"}</div>
      {params.length ? (
        <div>
          <Typography.Text type="secondary">参数快照：</Typography.Text>
          <Space wrap size={4}>{params.map(([k, v]) => <Tag key={k} style={{ marginInlineEnd: 0 }}>{k} = {fmtVal(v)}</Tag>)}</Space>
        </div>
      ) : null}
      <div><Typography.Text type="secondary">已知悉：</Typography.Text>{ackText(alert)}</div>
    </Space>
  );
}
