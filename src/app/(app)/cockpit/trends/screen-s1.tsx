"use client";

import { Space, Table, Tag, Typography } from "antd";
import { CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { VISUAL_COLOR } from "@/components/decision-visuals";
import type { Block } from "@/server/modules/report/cockpit";
import type { DailyFlowBlock, DailyFlowPoint, WowDelta } from "@/server/modules/report/cockpit-trends";
import { metricLabel, Muted, num, qty, signed, TrendCard, useChartTheme } from "./shared";

function WowTag({ label, w }: { label: string; w: WowDelta }) {
  if (w.state !== "ready") return <Tag>{label}：周环比不足（有账 {w.currentDays + w.previousDays} 天）</Tag>;
  const color = w.pct == null ? "default" : w.pct > 0 ? "success" : w.pct < 0 ? "warning" : "default";
  return (
    <Tag color={color}>
      {label}出库 周环比 {signed(w.pct)} · {qty(w.currentOut)} vs {qty(w.previousOut)}
    </Tag>
  );
}

/** 屏1 · 当月逐日出入库（实时仓与快照仓分两组序列，绝不相加）+ 周环比 */
export function DailyFlowCard({ block }: { block: Block<DailyFlowBlock> }) {
  const t = useChartTheme();
  const d = block.data;
  const rows = (d?.points ?? []).map((p) => ({
    date: p.date,
    label: p.date.slice(5),
    realtimeIn: num(p.realtimeIn),
    realtimeOut: num(p.realtimeOut),
    snapshotIn: num(p.snapshotIn),
    snapshotOut: num(p.snapshotOut),
    span: p.snapshotSpanDays,
  }));
  const fmt = (v: unknown) => qty(typeof v === "number" || typeof v === "string" ? v : null);
  return (
    <TrendCard
      block={block}
      title={`${metricLabel("dailyInOut", "当日出入库")}（当月逐日）`}
      question="本月出库在加速还是停滞？哪一天仓库突然没动？是需求变化还是过账积压？"
      metricId="dailyInOut"
      grain="日 × 账务模式"
      unit="基础单位数量"
      height={320}
      summary={d ? `${d.windowFrom ?? ""} → ${d.windowTo ?? ""} 共 ${d.points.length} 天；实时仓 ${d.wow.realtime.state === "ready" ? `周环比 ${signed(d.wow.realtime.pct)}` : "周环比不足"}；快照仓 ${d.wow.snapshot.state === "ready" ? `周环比 ${signed(d.wow.snapshot.pct)}` : "周环比不足"}` : "无数据"}
      dataView={d ? (
        <Table<DailyFlowPoint> rowKey="date" size="small" pagination={false} scroll={{ x: 640, y: 240 }} dataSource={d.points} columns={[
          { title: "日期", dataIndex: "date", width: 110 },
          { title: "实时·入", dataIndex: "realtimeIn", align: "right", render: (v: string | null) => qty(v) },
          { title: "实时·出", dataIndex: "realtimeOut", align: "right", render: (v: string | null) => qty(v) },
          { title: "快照·入（差分）", dataIndex: "snapshotIn", align: "right", render: (v: string | null) => qty(v) },
          { title: "快照·出（差分）", dataIndex: "snapshotOut", align: "right", render: (v: string | null, r) => v == null ? "—" : <span>{qty(v)}{r.snapshotSpanDays && r.snapshotSpanDays > 1 ? <Tag style={{ marginLeft: 4 }}>跨 {r.snapshotSpanDays} 日</Tag> : null}</span> },
        ]} />
      ) : undefined}
    >
      {(data) => (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Space wrap size={[6, 4]} style={{ marginBottom: 6 }}>
            <WowTag label="实时仓" w={data.wow.realtime} />
            <WowTag label="快照仓" w={data.wow.snapshot} />
          </Space>
          <div style={{ flex: 1, minHeight: 0 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={t.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} interval="preserveStartEnd" />
                <YAxis tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} tickFormatter={(v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} width={44} />
                <Tooltip {...t.tooltip} formatter={(v) => fmt(v)} labelFormatter={(l) => `${data.windowFrom?.slice(0, 5) ?? ""}${l}`} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="realtimeIn" name="实时仓·入" stroke={VISUAL_COLOR.primary} strokeWidth={2} dot={false} connectNulls={false} />
                <Line type="monotone" dataKey="realtimeOut" name="实时仓·出" stroke={VISUAL_COLOR.compare} strokeWidth={2} dot={false} connectNulls={false} />
                <Line type="monotone" dataKey="snapshotIn" name="快照仓·入（差分）" stroke={VISUAL_COLOR.warning} strokeWidth={2} strokeDasharray="5 3" dot={{ r: 3 }} connectNulls={false} />
                <Line type="monotone" dataKey="snapshotOut" name="快照仓·出（差分）" stroke={VISUAL_COLOR.accent} strokeWidth={2} strokeDasharray="5 3" dot={{ r: 3 }} connectNulls={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <Muted>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>虚线为快照仓相邻快照差分（落在后一快照日，跨多日为累计），与实线流水口径不同，图上并列不相加。</Typography.Text>
          </Muted>
        </div>
      )}
    </TrendCard>
  );
}
