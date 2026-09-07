"use client";

/**
 * 驾驶舱趋势块共享层：页面实例持有读取，切 Tab 不重拉；离开后不保留模块级业务缓存，
 * 五态块 → DecisionVisual 图卡契约的映射，主题感知的图表配色（AntD token）。
 * 指标标题 / 口径 tooltip 一律取自 components/metrics 注册表，不在这里手写口径。
 */
import { theme, Typography } from "antd";
import DecisionVisual, { type DecisionVisualSource } from "@/components/DecisionVisual";
import type { VisualState } from "@/components/decision-visuals";
import { useDocumentRead } from "@/components/useDocumentRead";
import { formatAsOf } from "@/components/format";
import { metric } from "@/components/metrics";
import type { Block, CockpitSource } from "@/server/modules/report/cockpit";
import type { CockpitTrendsData, SourceTrendBlock } from "@/server/modules/report/cockpit-trends";

const URL = "/api/report/cockpit/trends";

export function useTrends(): { data: CockpitTrendsData | null; error: string | null; loading: boolean; reload: () => void } {
  const { data, error, phase, retry } = useDocumentRead<CockpitTrendsData>(URL);
  return { data, error, loading: phase === "loading", reload: retry };
}

/* ───────────── 格式化 ─────────────
 * 数量 / 金额 / 百分数一律用 `@/components/format` 的 formatCount / formatYuan / formatPct
 * （驾驶舱唯一显示格式化权威）。本层曾另写一套 qty()/yuan()/pct()，与共享层逐字重复
 * 却又各自演化——2026-09-04 清理审计 #3 已删除；这里只留趋势层特有的两个小工具。 */

export function signed(v: number | null | undefined, suffix = "%"): string {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v}${suffix}`;
}
export function num(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ───────────── 主题感知图表配色 ───────────── */

export interface ChartTheme {
  grid: string;
  axis: string;
  text: string;
  tooltip: { contentStyle: React.CSSProperties; labelStyle: React.CSSProperties; itemStyle: React.CSSProperties };
}

export function useChartTheme(): ChartTheme {
  const { token } = theme.useToken();
  return {
    grid: token.colorBorderSecondary,
    axis: token.colorTextSecondary,
    text: token.colorText,
    tooltip: {
      contentStyle: { background: token.colorBgElevated, border: `1px solid ${token.colorBorder}`, borderRadius: token.borderRadius, color: token.colorText, fontSize: 12 },
      labelStyle: { color: token.colorTextSecondary },
      itemStyle: { color: token.colorText },
    },
  };
}

/* ───────────── 五态块 → 图卡契约 ───────────── */

const TIER_MAP: Record<CockpitSource["tier"], DecisionVisualSource["tier"]> = {
  fact: "ledger", snapshot: "snapshot", observation: "reference", manual: "reference", derived: "derived",
};

export function visualState(block: Block<unknown>): VisualState {
  switch (block.state) {
    case "ready": return "ready";
    case "insufficient": return "insufficient";
    case "error": return "error";
    default: return "empty";
  }
}

export function stateDetail(block: Block<unknown>): string {
  if (block.state === "no_access") return `无权限：${block.note}`;
  if (block.state === "pending_domain") return `待接入：${block.note}`;
  return block.note;
}

/** 注册表标题：未登记时回退到给定文案（不编造口径） */
export function metricLabel(id: string, fallback: string): string {
  return metric(id)?.label ?? fallback;
}

export interface TrendCardProps<T> {
  block: Block<T>;
  title: string;
  question: string;
  metricId: string;
  grain?: string;
  unit?: string;
  summary: string;
  height?: number;
  fitContent?: boolean;
  contentIsTable?: boolean;
  dataView?: React.ReactNode;
  extra?: React.ReactNode;
  children: (data: T) => React.ReactNode;
}

/** 趋势块图卡：标题来自注册表 label，口径 tooltip 由 DecisionVisual 按 metricId 生成；限制文案 = 服务端 note */
export function TrendCard<T>({ block, title, question, metricId, grain, unit, summary, height, fitContent, contentIsTable, dataView, extra, children }: TrendCardProps<T>) {
  const state = visualState(block);
  return (
    <DecisionVisual
      title={title}
      question={question}
      metricId={metricId}
      grain={grain}
      unit={unit}
      source={{ tier: TIER_MAP[block.source.tier], source: block.source.source, asOf: block.source.asOf ? formatAsOf(block.source.asOf) : null }}
      summary={summary}
      state={state}
      stateDetail={stateDetail(block)}
      caveat={block.state === "ready" && block.note ? block.note : undefined}
      height={height}
      fitContent={fitContent}
      contentIsTable={contentIsTable}
      dataView={state === "ready" ? dataView : undefined}
      extra={extra}
    >
      {block.state === "ready" && block.data ? children(block.data) : null}
    </DecisionVisual>
  );
}

export function Muted({ children }: { children: React.ReactNode }) {
  return <Typography.Text type="secondary" style={{ fontSize: 12 }}>{children}</Typography.Text>;
}

/* ───────────── 来源类周序列（C6 新鲜度 / B8 数据质量共用画法） ───────────── */

export type SourceMeasure = "maxAgeDays" | "passRatePct";

/** 把 8 周 × 来源类的序列摊平成 recharts 需要的「一周一行、一来源类一列」 */
export function sourceChartRows(block: SourceTrendBlock, measure: SourceMeasure): Record<string, string | number | null>[] {
  return block.weeks.map((week) => {
    const row: Record<string, string | number | null> = { week, label: week.slice(5) };
    for (const s of block.series) {
      const p = s.points.find((x) => x.week === week);
      // 门槛按**这张图画的那条读数**判（审计 C8b）：有运行 ≠ 这条读数有值
      const ready = measure === "maxAgeDays" ? s.ageState === "ready" : s.passRateState === "ready";
      // 不足周数的来源类整条不画；单周无读数给 null（断线），绝不补 0
      row[s.sourceClass] = ready ? (p ? p[measure] : null) : null;
    }
    return row;
  });
}
