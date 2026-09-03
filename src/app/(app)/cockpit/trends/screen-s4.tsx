"use client";

import { useMemo, useState } from "react";
import { Col, Row, Segmented, Space, Statistic, Table, Tag, Typography } from "antd";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { VISUAL_COLOR } from "@/components/decision-visuals";
import type { Block } from "@/server/modules/report/cockpit";
import type { AlertLifecycleBlock, GoalHistoryBlock, GoalHistorySeries, TodoCompletionStrictBlock, TodoCompletionStrictCell, TodoThroughputBlock } from "@/server/modules/report/cockpit-trends";
import { metricLabel, Muted, pct, TrendCard, useChartTheme } from "./shared";

/* ───────────── 待办吞吐（6 个月 × 角色，证据不排名） ───────────── */

export function TodoThroughputCard({ block }: { block: Block<TodoThroughputBlock> }) {
  const t = useChartTheme();
  const [role, setRole] = useState<string>("全部");
  const d = block.data;
  const rows = useMemo(() => {
    if (!d) return [];
    return d.months.map((month) => {
      const src = d.rows.filter((r) => r.month === month && (role === "全部" || r.groupKey === role));
      const agg = src.reduce((a, r) => ({ total: a.total + r.total, done: a.done + r.done, onTime: a.onTime + r.onTime, overdue: a.overdue + r.overdue, cancelled: a.cancelled + r.cancelled, suspicious: a.suspicious + r.suspicious }), { total: 0, done: 0, onTime: 0, overdue: 0, cancelled: 0, suspicious: 0 });
      const denom = agg.total - agg.cancelled;
      return {
        month,
        onTime: agg.onTime,
        lateDone: agg.done - agg.onTime,
        open: Math.max(0, denom - agg.done),
        completionRate: denom > 0 ? Math.round((agg.done / denom) * 1000) / 10 : null,
        onTimeRate: agg.done > 0 ? Math.round((agg.onTime / agg.done) * 1000) / 10 : null,
        suspicious: agg.suspicious,
      };
    });
  }, [d, role]);
  return (
    <TrendCard
      block={block}
      title={`${metricLabel("todoCompletionRate", "待办完成率")} · 近 6 个月吞吐`}
      question="团队清系统待办比上季度快了还是慢了？哪个责任角色的积压在增长？"
      metricId="todoCompletionRate"
      grain="创建月 × 责任角色"
      unit="待办条数"
      height={320}
      summary={d ? `近 6 个月（${d.months[0]} → ${d.months.at(-1)}）${role === "全部" ? "全部角色" : role}：${rows.map((r) => `${r.month.slice(5)} 完成率 ${pct(r.completionRate)}`).join("，")}` : "无数据"}
      extra={d ? <Segmented size="small" options={["全部", ...d.roles]} value={role} onChange={(v) => setRole(String(v))} /> : undefined}
      dataView={d ? (
        <Table rowKey="month" size="small" pagination={false} dataSource={rows} columns={[
          { title: "月份", dataIndex: "month", width: 90 },
          { title: "按时完成", dataIndex: "onTime", align: "right" },
          { title: "逾期完成", dataIndex: "lateDone", align: "right" },
          { title: "未完成", dataIndex: "open", align: "right" },
          { title: "完成率", dataIndex: "completionRate", align: "right", render: (v: number | null) => pct(v) },
          { title: "按时率", dataIndex: "onTimeRate", align: "right", render: (v: number | null) => pct(v) },
          { title: "可疑关闭", dataIndex: "suspicious", align: "right" },
        ]} />
      ) : undefined}
    >
      {(data) => (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid stroke={t.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} tickFormatter={(v: string) => v.slice(2)} />
                <YAxis tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} width={40} allowDecimals={false} />
                <Tooltip {...t.tooltip} cursor={{ fill: t.grid, opacity: 0.4 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="onTime" name="按时完成" stackId="s" fill={VISUAL_COLOR.positive} />
                <Bar dataKey="lateDone" name="逾期完成" stackId="s" fill={VISUAL_COLOR.warning} />
                <Bar dataKey="open" name="未完成" stackId="s" fill={VISUAL_COLOR.muted} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Muted>{data.caliber}。按角色看证据，不排名个人（D61）。</Muted>
        </div>
      )}
    </TrendCard>
  );
}

/* ───────────── 告警生命周期 ───────────── */

export function AlertLifecycleCard({ block }: { block: Block<AlertLifecycleBlock> }) {
  const t = useChartTheme();
  const d = block.data;
  return (
    <TrendCard
      block={block}
      title={`${metricLabel("alertTimeToResolve", "告警关闭时长")} · 生命周期`}
      question="告警是在被处理还是在堆积？哪条规则对同一对象反复触发（更像阈值问题而不是真实风险）？"
      metricId="alertTimeToResolve"
      grain="system_alerts 全量 + 近 90 天时长"
      unit="条 / 小时"
      height={340}
      summary={d ? `开放 ${d.open.total}（未知悉 ${d.open.unacked}）；知悉中位 ${d.latency.ackP50Hours ?? "—"} 小时（n=${d.latency.ackSamples}）；关闭中位 ${d.latency.resolveP50Hours ?? "—"} 小时（n=${d.latency.resolveSamples}）；自动关闭 ${d.resolution.auto} / 人工 ${d.resolution.manual}；复发对 ${d.recurrence.length}` : "无数据"}
      dataView={d ? (
        <Table rowKey={(r) => `${r.sourceRule}|${r.dedupeKey}`} size="small" pagination={false} dataSource={d.recurrence} columns={[
          { title: "规则", dataIndex: "sourceRule", width: 160 },
          { title: "去重键", dataIndex: "dedupeKey", ellipsis: true },
          { title: "次数", dataIndex: "times", align: "right", width: 70 },
          { title: "最近命中", dataIndex: "lastHitAt", width: 150, render: (v: string | null) => v ? v.replace("T", " ").slice(0, 16) : "—" },
          { title: "当前", dataIndex: "open", width: 70, render: (v: boolean) => v ? <Tag color="warning">开放</Tag> : <Tag>已关</Tag> },
        ]} />
      ) : undefined}
    >
      {(data) => (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Row gutter={12} style={{ marginBottom: 6 }}>
            <Col span={6}><Statistic title="开放 / 未知悉" value={data.open.total} suffix={`/ ${data.open.unacked}`} valueStyle={{ fontSize: 18, color: data.open.unacked ? VISUAL_COLOR.critical : undefined }} /></Col>
            <Col span={6}><Statistic title={metricLabel("alertTimeToAck", "知悉时长")} value={data.latency.ackP50Hours ?? "—"} suffix="h" valueStyle={{ fontSize: 18 }} /><Muted>中位 · n={data.latency.ackSamples}</Muted></Col>
            <Col span={6}><Statistic title={metricLabel("alertTimeToResolve", "关闭时长")} value={data.latency.resolveP50Hours ?? "—"} suffix="h" valueStyle={{ fontSize: 18 }} /><Muted>中位 · n={data.latency.resolveSamples}</Muted></Col>
            <Col span={6}><Statistic title="自动 / 人工关闭" value={data.resolution.auto} suffix={`/ ${data.resolution.manual}`} valueStyle={{ fontSize: 18 }} /></Col>
          </Row>
          <Row gutter={12} style={{ flex: 1, minHeight: 0 }}>
            <Col span={10} style={{ height: "100%" }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.open.buckets} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="30%">
                  <CartesianGrid stroke={t.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} />
                  <YAxis tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} width={32} allowDecimals={false} />
                  <Tooltip {...t.tooltip} cursor={{ fill: t.grid, opacity: 0.4 }} />
                  <Bar dataKey="count" name="开放告警（按年龄）" radius={[4, 4, 0, 0]}>
                    {data.open.buckets.map((b, i) => <Cell key={b.key} fill={i >= 3 ? VISUAL_COLOR.critical : VISUAL_COLOR.primary} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Col>
            <Col span={14} style={{ height: "100%", overflow: "auto" }}>
              <Typography.Text strong style={{ fontSize: 12 }}>{metricLabel("alertRecurrence", "告警复发")}（同规则 × 同去重键 ≥ 2 次）</Typography.Text>
              {data.recurrence.length ? data.recurrence.slice(0, 6).map((r) => (
                <div key={`${r.sourceRule}|${r.dedupeKey}`} style={{ fontSize: 12, padding: "2px 0" }}>
                  <Tag color={r.open ? "warning" : "default"}>{r.times} 次</Tag>{r.sourceRule} · <Typography.Text type="secondary">{r.dedupeKey}</Typography.Text>
                </div>
              )) : <div style={{ fontSize: 12 }}><Typography.Text type="secondary">无复发对</Typography.Text></div>}
              <Typography.Text strong style={{ fontSize: 12, display: "block", marginTop: 6 }}>按规则</Typography.Text>
              <Space wrap size={[4, 4]}>
                {data.byRule.slice(0, 8).map((r) => <Tag key={r.sourceRule}>{r.sourceRule} {r.total}（开放 {r.open} · 自动关 {r.autoResolved}）</Tag>)}
              </Space>
            </Col>
          </Row>
        </div>
      )}
    </TrendCard>
  );
}

/* ───────────── 目标达成历史（6 期迷你线） ───────────── */

function AttainmentSpark({ s }: { s: GoalHistorySeries }) {
  const data = s.points.map((p) => ({ period: p.period, attainment: p.attainment == null ? null : Number(p.attainment) }));
  const has = data.some((p) => p.attainment != null);
  if (!has) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>无实际值</Typography.Text>;
  return (
    <div role="img" aria-label={`${s.deptKey} ${s.metricLabel} 达成度：${data.map((p) => `${p.period} ${p.attainment ?? "—"}%`).join("，")}`} style={{ width: 140, height: 36 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
          <YAxis hide domain={[0, "auto"]} />
          <Line type="monotone" dataKey="attainment" stroke={VISUAL_COLOR.primary} strokeWidth={2} dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function GoalHistoryCard({ block }: { block: Block<GoalHistoryBlock> }) {
  const d = block.data;
  return (
    <TrendCard
      block={block}
      title={`${metricLabel("goalAttainment", "目标达成度")} · 近 6 期历史`}
      question="我们是否持续在轨？过去 6 个期间里达成了几次，趋势向好还是变差？"
      metricId="goalAttainment"
      grain="部门 × 指标 × 期间（月/季分列）"
      unit="达成度 %"
      contentIsTable
      fitContent
      height={200}
      summary={d ? `${d.series.length} 条部门×指标序列，每条最多 ${d.periodsPerSeries} 期；只读历史登记值，不回填` : "无数据"}
    >
      {(data) => (
        <Table<GoalHistorySeries> rowKey={(r) => `${r.deptKey}|${r.metricKey}|${r.periodKind}`} size="small" pagination={false} scroll={{ x: 760 }} dataSource={data.series} columns={[
          { title: "部门", dataIndex: "deptKey", width: 90 },
          { title: "指标", dataIndex: "metricLabel", width: 160 },
          { title: "期间", dataIndex: "periodKind", width: 60, render: (v: string) => v === "month" ? "月" : "季" },
          { title: "达成度走势", key: "spark", width: 160, render: (_, r) => <AttainmentSpark s={r} /> },
          { title: "各期", key: "pts", render: (_, r) => (
            <Space wrap size={[4, 4]}>
              {r.points.map((p) => (
                <Tag key={p.period} color={p.attained == null ? "default" : p.attained ? "success" : "warning"}>
                  {p.period.slice(2)} {p.attainment == null ? (p.actualValue == null ? "未填" : "—") : `${p.attainment}%`}{p.actualSource === "manual" ? "·手" : ""}
                </Tag>
              ))}
            </Space>
          ) },
          { title: "达成次数", key: "n", width: 90, align: "right", render: (_, r) => `${r.points.filter((p) => p.attained).length} / ${r.points.filter((p) => p.attained != null).length}` },
        ]} />
      )}
    </TrendCard>
  );
}

/* ───────────── 待办完成率（严格口径）：宽 vs 严 + 取消拆分 ───────────── */

type StrictView = "month" | "role";

export function TodoCompletionStrictCard({ block }: { block: Block<TodoCompletionStrictBlock> }) {
  const t = useChartTheme();
  const [view, setView] = useState<StrictView>("month");
  const d = block.data;
  const rows: TodoCompletionStrictCell[] = view === "month" ? d?.byMonth ?? [] : d?.byRole ?? [];
  const gap = (v: number | null) => (v == null ? "—" : `${v} pp`);
  return (
    <TrendCard
      block={block}
      title={`${metricLabel("todoCompletionRateStrict", "待办完成率（严格口径）")} · 宽 vs 严`}
      question="待办是被人做完的，还是等看门狗把告警关掉后「顺手」完成的？哪个角色两种口径差距最大？"
      metricId="todoCompletionRateStrict"
      grain={view === "month" ? "创建月（近 6 个月）× 全部责任角色" : "责任角色（近 6 个月合计）"}
      unit="完成率 %"
      height={320}
      summary={d
        ? `近 6 个月合计：宽口径 ${pct(d.overall.completionRate)} vs 严口径 ${pct(d.overall.completionRateStrict)}（差 ${gap(d.overall.gapPp)}）；已取消 ${d.overall.cancelled} = 来源自动关闭 ${d.overall.cancelledBySourceClose} + 人工 ${d.overall.cancelledByHuman}`
        : "无数据"}
      extra={<Segmented size="small" options={[{ label: "按月", value: "month" }, { label: "按角色", value: "role" }]} value={view} onChange={(v) => setView(v as StrictView)} />}
      dataView={d ? (
        <Table<TodoCompletionStrictCell> rowKey="key" size="small" pagination={false} scroll={{ x: 760 }} dataSource={rows} columns={[
          { title: view === "month" ? "月份" : "角色", dataIndex: "key", width: 110 },
          { title: "总数", dataIndex: "total", align: "right" },
          { title: "已完成", dataIndex: "done", align: "right" },
          { title: "已取消", dataIndex: "cancelled", align: "right" },
          { title: "来源自动关闭", dataIndex: "cancelledBySourceClose", align: "right" },
          { title: "人工取消", dataIndex: "cancelledByHuman", align: "right" },
          { title: "宽口径", dataIndex: "completionRate", align: "right", render: (v: number | null) => pct(v) },
          { title: "严口径", dataIndex: "completionRateStrict", align: "right", render: (v: number | null) => pct(v) },
          { title: "宽 − 严", dataIndex: "gapPp", align: "right", render: (v: number | null) => gap(v) },
        ]} />
      ) : undefined}
    >
      {(data) => (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Row gutter={12} style={{ marginBottom: 6 }}>
            <Col span={8}>
              <Statistic title="宽口径（近 6 个月合计）" value={pct(data.overall.completionRate)} valueStyle={{ fontSize: 18, color: VISUAL_COLOR.neutral }} />
              <Muted>已完成 ÷ (总数 − 全部已取消)</Muted>
            </Col>
            <Col span={8}>
              <Statistic title="严口径" value={pct(data.overall.completionRateStrict)} valueStyle={{ fontSize: 18, color: VISUAL_COLOR.primary }} />
              <Muted>来源自动关闭的取消留在分母 · 宽 − 严 = {gap(data.overall.gapPp)}</Muted>
            </Col>
            <Col span={8}>
              <Statistic title="取消拆分（自动 / 人工）" value={data.overall.cancelledBySourceClose} suffix={`/ ${data.overall.cancelledByHuman}`} valueStyle={{ fontSize: 18 }} />
              <Muted>自动 = 来源告警被引擎迟滞关闭，条件自己消失</Muted>
            </Col>
          </Row>
          <div style={{ flex: 1, minHeight: 0 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid stroke={t.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="key" tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} tickFormatter={(v: string) => (view === "month" ? v.slice(2) : v)} />
                <YAxis domain={[0, 100]} tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} width={40} />
                <Tooltip {...t.tooltip} cursor={{ fill: t.grid, opacity: 0.4 }} formatter={(v) => pct(typeof v === "number" ? v : null)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="completionRate" name="宽口径" fill={VISUAL_COLOR.muted} radius={[4, 4, 0, 0]} />
                <Bar dataKey="completionRateStrict" name="严口径" fill={VISUAL_COLOR.primary} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Muted>柱高 = 完成率；宽、严之差越大，越多「完成」其实是告警自行消失。按角色看证据，不排名个人（D61）。</Muted>
        </div>
      )}
    </TrendCard>
  );
}
