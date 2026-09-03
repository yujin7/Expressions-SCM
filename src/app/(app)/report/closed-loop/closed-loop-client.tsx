"use client";

/**
 * 建议闭环追踪：补货建议 / NPD 首单 生成的 BH 草稿 → 审批执行状态（只读）。
 * 闭环审计 #12：追加「建议准确度」（净需求 vs 实际下单 vs 实际出库，只给分布不给分数）与「已复核并放弃」计数。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Card, Col, Row, Statistic, Table, Tag, theme, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import CaliberNote from "@/components/CaliberNote";
import DecisionVisual from "@/components/DecisionVisual";
import { VISUAL_COLOR, type VisualState } from "@/components/decision-visuals";
import { fetchJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import { metric } from "@/components/metrics";
import { useListState } from "@/components/useListState";
import type { AccuracyBucket, AccuracyBucketKey, SuggestionAccuracy } from "@/server/modules/report/closed-loop";

interface ClosedLoopRow {
  id: number;
  createdAt: string;
  docNo: string;
  source: string;
  lineCount: number;
  createdBy: string;
  currentStatus: string;
  receivedQty: number;
  plannedQty: number;
  receiptRate: number | null;
  statusLabel: string;
  downstreamWo: string;
}

interface ClosedLoopSummary {
  total: number;
  adopted: number;
  pending: number;
  rejected: number;
  deleted: number;
  adoptRate: number;
  deliveredRate: number;
  deliveredCount: number;
  /** 已复核并放弃（审计 decline_suggestion）；单列，不进采纳率分母 */
  declined: number;
}

interface ClosedLoopData {
  rows: ClosedLoopRow[];
  total: number;
  summary: ClosedLoopSummary;
  accuracy: SuggestionAccuracy;
}

/* ────────────── 建议准确度分布（只给分布与样本数） ────────────── */

const BUCKET_COLOR: Record<AccuracyBucketKey, string> = {
  none: VISUAL_COLOR.muted,
  lt50: VISUAL_COLOR.warning,
  "50_90": VISUAL_COLOR.compare,
  "90_110": VISUAL_COLOR.positive,
  "110_150": VISUAL_COLOR.compare,
  gt150: VISUAL_COLOR.critical,
};

function AccuracyCard({ metricId, fallbackTitle, question, buckets, n, accuracy, caveat }: {
  metricId: string;
  fallbackTitle: string;
  question: string;
  buckets: AccuracyBucket[];
  /** 进入本分布的行数（下单 = 已成熟行；出库 = 已成熟且有实时仓流水的行） */
  n: number;
  accuracy: SuggestionAccuracy;
  caveat: string;
}) {
  const { token } = theme.useToken();
  const def = metric(metricId);
  const state: VisualState = accuracy.sample === 0 ? "empty" : n === 0 ? "insufficient" : "ready";
  const summary = `样本 ${n} 行：${buckets.map((b) => `${b.label} ${b.count}`).join("，")}`;
  return (
    <DecisionVisual
      title={def?.label ?? fallbackTitle}
      question={question}
      metricId={metricId}
      grain="已捕获的建议行（同 SKU 同业务日取最新版本，视野期已走完）"
      unit="行数"
      source={{ tier: "derived", source: `${accuracy.version} · planning_version_lines × bh/po 行 × stock_ledger` }}
      summary={summary}
      state={state}
      stateDetail={accuracy.sample === 0
        ? "尚无人工捕获的建议快照——在补货建议页固化版本（planning_versions）后才有样本"
        : `已捕获 ${accuracy.sample} 行，视野期已走完 ${accuracy.matured} 行、未走完 ${accuracy.immature} 行；本分布可评 ${n} 行`}
      caveat={caveat}
      height={220}
      dataView={(
        <Table<AccuracyBucket> rowKey="key" size="small" pagination={false} dataSource={buckets} columns={[
          { title: "实际 ÷ 净需求", dataIndex: "label", width: 160 },
          { title: "行数", dataIndex: "count", align: "right", width: 90 },
          { title: "占比", key: "share", align: "right", width: 90, render: (_, r) => (n > 0 ? `${Math.round((r.count / n) * 1000) / 10}%` : "—") },
        ]} />
      )}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={buckets} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} barCategoryGap="25%">
          <CartesianGrid stroke={token.colorBorderSecondary} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fill: token.colorTextSecondary, fontSize: 11 }} stroke={token.colorBorderSecondary} />
          <YAxis allowDecimals={false} width={36} tick={{ fill: token.colorTextSecondary, fontSize: 11 }} stroke={token.colorBorderSecondary} />
          <ChartTooltip
            contentStyle={{ background: token.colorBgElevated, border: `1px solid ${token.colorBorder}`, borderRadius: token.borderRadius, color: token.colorText, fontSize: 12 }}
            cursor={{ fill: token.colorBorderSecondary, opacity: 0.4 }}
            formatter={(v) => [`${String(v)} 行`, "样本"]}
          />
          <Bar dataKey="count" name="行数" radius={[4, 4, 0, 0]}>
            {buckets.map((b) => <Cell key={b.key} fill={BUCKET_COLOR[b.key]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </DecisionVisual>
  );
}

/** 采纳类=green，待审批=blue，否决/关闭=red，作废/删除=default(灰) */
function statusColor(status: string): string {
  if (["approved", "in_progress", "completed", "done"].includes(status)) return "green";
  if (["draft", "pending"].includes(status)) return "blue";
  if (["rejected", "closed"].includes(status)) return "red";
  return "default"; // void / 已删除
}

const SOURCE_COLORS: Record<string, string> = { 补货建议: "geekblue", NPD首单: "purple" };

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function ClosedLoopClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<ClosedLoopData | null>(null);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：分页进 URL，密度与已保存视图存本地
  const listState = useListState({ key: "closed-loop", defaults: {}, defaultPageSize: 20 });
  const { page, pageSize } = listState;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      setData(await fetchJson<ClosedLoopData>(`/api/report/closed-loop?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const s = data?.summary;
  const a = data?.accuracy;

  const columns: ColumnsType<ClosedLoopRow> = [
    { title: "生成时间", dataIndex: "createdAt", width: 160, render: (v: string) => fmtTime(v) },
    {
      title: "单号",
      dataIndex: "docNo",
      width: 170,
      render: (v: string) => (v ? <a href={`/outsource/bh?q=${encodeURIComponent(v)}`}>{v}</a> : "—"),
    },
    { title: "来源", dataIndex: "source", width: 110, render: (v: string) => <Tag color={SOURCE_COLORS[v] ?? "default"}>{v}</Tag> },
    { title: "行数", dataIndex: "lineCount", width: 80, align: "right" },
    { title: "发起人", dataIndex: "createdBy", width: 120 },
    {
      title: "当前状态",
      dataIndex: "statusLabel",
      width: 110,
      render: (v: string, r) => <Tag color={statusColor(r.currentStatus)}>{v}</Tag>,
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>建议闭环追踪</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="追踪补货建议 / NPD 首单生成的 BH 草稿，直至审批执行的全过程，据此看清建议是否被采纳。"
        description="采纳率 = 进入审批通过及以后状态（已审批/执行中/已完成）的草稿占比。单号对应 BH 单据不存在时记为「已删除」。「已复核并放弃」= 计划员在补货建议页点「不采纳」留痕的条数，单列不进采纳率分母。只读，不产生任何写入。"
      />
      <Row gutter={[10, 10]} className="compact-kpi-row">
        <Col><Card size="small"><Statistic title="建议草稿总数" value={s?.total ?? 0} /></Card></Col>
        <Col><Card size="small"><Statistic title="采纳率（到审批）" value={s?.adoptRate ?? 0} precision={1} suffix="%" valueStyle={{ color: "#52c41a" }} /></Card></Col>
        <Col><Card size="small"><Statistic title="实际到货率" value={s?.deliveredRate ?? 0} precision={1} suffix="%" valueStyle={{ color: "#3f8600" }} /></Card></Col>
        <Col><Card size="small"><Statistic title="采纳中/已完成" value={s?.adopted ?? 0} valueStyle={{ color: "#52c41a" }} /></Card></Col>
        <Col><Card size="small"><Statistic title="待审批" value={s?.pending ?? 0} valueStyle={{ color: "#1677ff" }} /></Card></Col>
        <Col><Card size="small"><Statistic title="已否决/关闭" value={s?.rejected ?? 0} valueStyle={{ color: "#8c8c8c" }} /></Card></Col>
        {s?.deleted ? <Col><Card size="small"><Statistic title="已删除" value={s.deleted} valueStyle={{ color: "#8c8c8c" }} /></Card></Col> : null}
        <Col>
          <Card size="small">
            <Statistic
              title={<Tooltip title="计划员看过建议、判断不需要下单时在补货建议页点「不采纳」留痕（审计 decline_suggestion）；与「草稿被否决」不是一回事，不进采纳率分母"><span>已复核并放弃</span></Tooltip>}
              value={s?.declined ?? 0}
              valueStyle={{ color: "#8c8c8c" }}
            />
          </Card>
        </Col>
      </Row>

      {a ? (
        <div style={{ marginTop: 16 }}>
          <Typography.Title level={5} style={{ marginTop: 0 }}>建议准确度</Typography.Title>
          <CaliberNote
            summary={
              <>采纳率量的是「照做了没有」，这里量的是「建议对不对」：净需求 vs 视野期内实际下单 vs 实际出库，只给分布与样本数，不给单一分数。
              已捕获 <b>{a.sample}</b> 行，视野期已走完 <b>{a.matured}</b> 行（未走完 {a.immature} 行不进分布）；
              实时仓有流水 {a.ledgerCoverage.withRealtimeLedger} 行、快照仓 SKU {a.ledgerCoverage.snapshotOnly} 行无流水（出库分布弃权）。</>
            }
            detail={<ul style={{ paddingLeft: 16, margin: 0 }}>{a.caliber.map((c, i) => <li key={i}>{c}</li>)}</ul>}
          />
          <Row gutter={[12, 12]}>
            <Col xs={24} xl={12}>
              <AccuracyCard
                metricId="suggestionOrderedRatio"
                fallbackTitle="建议 vs 实际下单"
                question="按建议下单的量与建议的净需求差多少？是普遍没下单（0），还是下得偏多 / 偏少？"
                buckets={a.orderedVsRequired}
                n={a.matured}
                accuracy={a}
                caveat="实际下单 = 视野期内创建、非作废的 BH 行 + PO 行（PO 按 uom_factor 折基础单位）；只对视野期已走完的行分桶；分桶边界是展示约定不是考核线"
              />
            </Col>
            <Col xs={24} xl={12}>
              <AccuracyCard
                metricId="suggestionRealizedRatio"
                fallbackTitle="建议 vs 实际出库"
                question="建议的净需求后来真的被消耗掉了吗？出库远低于建议说明需求估高，远高于建议说明估低。"
                buckets={a.outboundVsRequired}
                n={a.ledgerCoverage.withRealtimeLedger}
                accuracy={a}
                caveat={`出库 = 视野期内实时仓流水出库合计（含调拨/发料，不是纯销售）；快照仓 SKU 无流水，${a.ledgerCoverage.snapshotOnly} 行弃权不进分布，所以样本少于「实际下单」`}
              />
            </Col>
          </Row>
        </div>
      ) : null}
      <Typography.Title level={5} style={{ marginTop: 16 }}>建议草稿明细</Typography.Title>
      <ListToolbar state={listState} />
      <Table<ClosedLoopRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: data?.total ?? 0 })}
      />
    </div>
  );
}
