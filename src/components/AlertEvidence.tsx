"use client";

/**
 * 告警证据块（D56/D57 引擎字段）：规则来源 sourceRule、参数快照 paramsSnapshot（服务端已脱敏）、
 * 触发依据 why、已知悉人/时间。
 * /alerts 与 /inventory/alerts 的爆单/预警表共用，避免两处各画一套。
 *
 * why 的来源有两处且**同源**：引擎把候选的 why[] 写进 paramsSnapshot.why（alerts/engine.snapshotWith），
 * 少数读模型另在行上直接给 why 字段。这里优先取行上的 why，否则回落 paramsSnapshot.why——
 * 否则 /alerts（只拿到 params_snapshot）永远看不到依据，而 /inventory/alerts 看得到，同一条告警两个说法。
 * 渲染统一交给 AlertWhyList，本组件不再自画一套列表。
 */
import { Space, Tag, Typography } from "antd";
import AlertWhyList from "@/components/AlertWhyList";

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

/** 行上的 why 优先；否则取 paramsSnapshot.why（引擎落库的位置）。形状不对就当没有，不猜。 */
export function whyOf(alert: AlertEvidenceFields): AlertWhy[] {
  if (Array.isArray(alert.why)) return alert.why;
  const inSnapshot = (alert.paramsSnapshot as { why?: unknown } | null | undefined)?.why;
  if (!Array.isArray(inSnapshot)) return [];
  return inSnapshot.filter((w): w is AlertWhy => !!w && typeof w === "object" && typeof (w as AlertWhy).label === "string");
}

export default function AlertEvidence({ alert }: { alert: AlertEvidenceFields }) {
  const params = alert.paramsSnapshot && typeof alert.paramsSnapshot === "object" && !Array.isArray(alert.paramsSnapshot)
    ? Object.entries(alert.paramsSnapshot).filter(([k]) => k !== "why") // why 单列渲染，不再在参数快照里重复一遍
    : [];
  const why = whyOf(alert);
  return (
    <Space direction="vertical" size={6} style={{ width: "100%", fontSize: 12 }}>
      {why.length ? (
        <div>
          <Typography.Text strong>为什么触发</Typography.Text>
          <AlertWhyList why={why} max={12} />
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
