"use client";

/**
 * 告警「为什么」依据清单：紧凑渲染 `why: {label, value, source}[]`（引擎在 evidence / payload 里给出的判定依据）。
 * 只展示、不解释口径——口径说明走 metrics 注册表 / DecisionVisual；来源以浅色小字随项标注。
 */
import { Tooltip, Typography } from "antd";

export interface AlertWhyItem {
  label: string;
  value: string | number | null | undefined;
  /** 依据来源（读模型 / 表 / 参数名），浅色随项标注 */
  source?: string | null;
}

export interface AlertWhyListProps {
  why: AlertWhyItem[] | null | undefined;
  /** 最多显示几项，其余折叠为「+N」（调用方显式给，不设缺省——不同面板的容量不一样） */
  max: number;
}

function formatValue(v: AlertWhyItem["value"]): string {
  if (v == null || v === "") return "—";
  if (typeof v === "number") return Number.isFinite(v) ? v.toLocaleString("zh-CN", { maximumFractionDigits: 4 }) : "—";
  const n = Number(v);
  return /^-?\d+(\.\d+)?$/.test(v) && Number.isFinite(n) ? n.toLocaleString("zh-CN", { maximumFractionDigits: 4 }) : v;
}

export default function AlertWhyList({ why, max }: AlertWhyListProps) {
  if (!why?.length) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>无依据明细</Typography.Text>;
  const items = why.slice(0, Math.max(1, max));
  const rest = why.length - items.length;
  const restTip = rest > 0 ? why.slice(items.length).map((w) => `${w.label}：${formatValue(w.value)}`).join("；") : "";

  const item = (w: AlertWhyItem, i: number) => (
    <span key={`${w.label}-${i}`} style={{ whiteSpace: "nowrap" }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{w.label}</Typography.Text>
      <Typography.Text strong style={{ fontSize: 12, marginLeft: 4 }}>{formatValue(w.value)}</Typography.Text>
      {w.source ? (
        <Tooltip title={`来源：${w.source}`}>
          <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>（{w.source}）</Typography.Text>
        </Tooltip>
      ) : null}
    </span>
  );
  const more = rest > 0 ? (
    <Tooltip key="more" title={restTip}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>+{rest}</Typography.Text>
    </Tooltip>
  ) : null;

  return (
    <ul aria-label="告警依据" style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.7 }}>
      {items.map((w, i) => <li key={`${w.label}-${i}`}>{item(w, i)}</li>)}
      {more ? <li style={{ listStyle: "none", marginLeft: -16 }}>{more}</li> : null}
    </ul>
  );
}
