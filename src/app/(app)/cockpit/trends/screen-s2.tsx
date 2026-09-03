"use client";

import { useState } from "react";
import { Col, Row, Segmented, Space, Statistic, Table, Tag, Typography } from "antd";
import { Bar, BarChart, CartesianGrid, Cell, Legend, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import { SERIES_COLORS, VISUAL_COLOR } from "@/components/decision-visuals";
import type { Block } from "@/server/modules/report/cockpit";
import type { ExternalDemandBriefBlock, PoTrendBlock, PoTrendPoint, Quadrant, QuadrantBlock, QuadrantPoint } from "@/server/modules/report/cockpit-trends";
import { metricLabel, Muted, num, pct, qty, signed, TrendCard, useChartTheme, yuan } from "./shared";

/* ───────────── 采购订单月趋势 ───────────── */

type PoMeasure = "count" | "qty" | "amount";

export function PoTrendCard({ block }: { block: Block<PoTrendBlock> }) {
  const t = useChartTheme();
  const [measure, setMeasure] = useState<PoMeasure>("count");
  const d = block.data;
  const options = [
    { label: "单数", value: "count" },
    { label: "件数", value: "qty" },
    ...(d?.moneyVisible ? [{ label: "未税金额", value: "amount" }] : []),
  ];
  const rows = (d?.points ?? []).map((p) => ({
    month: p.month,
    value: measure === "count" ? p.poCount : measure === "qty" ? num(p.orderedBaseQty) : num(p.netAmount),
    isCurrent: p.isCurrent,
    fromHistoryYear: p.fromHistoryYear,
  }));
  const fmt = (v: unknown) => {
    const x = typeof v === "number" || typeof v === "string" ? v : null;
    return measure === "amount" ? yuan(x == null ? null : String(x)) : measure === "count" ? `${qty(x)} 单` : `${qty(x)} 件`;
  };
  const otifRatePct = d?.otifYtd.rate == null ? null : Math.round(d.otifYtd.rate * 1000) / 10;
  return (
    <TrendCard
      block={block}
      title={`${metricLabel("poOrderedQty", "已下单数量")} · 近 12 个月`}
      question="下单节奏与供应商准时率是在变好还是变坏？本月是异常值还是趋势延续？"
      metricId="poOrderedQty"
      grain="月（按审批通过日归期）"
      unit={measure === "amount" ? "未税金额" : measure === "count" ? "订单数" : "基础单位数量"}
      height={320}
      summary={d ? `${d.points[0]?.month ?? ""} → ${d.points.at(-1)?.month ?? ""} 共 ${d.points.length} 个月；本年 OTIF ${pct(otifRatePct)}（可评 n=${d.otifYtd.evaluable}）；订单→首批 P50 ${d.cycle.p50 ?? "—"} 天（n=${d.cycle.samples}）` : "无数据"}
      extra={<Segmented size="small" options={options} value={measure} onChange={(v) => setMeasure(v as PoMeasure)} />}
      dataView={d ? (
        <Table<PoTrendPoint> rowKey="month" size="small" pagination={false} scroll={{ y: 240 }} dataSource={d.points} columns={[
          { title: "月份", dataIndex: "month", width: 90, render: (v: string, r) => <span>{v}{r.isCurrent ? <Tag style={{ marginLeft: 4 }}>当月</Tag> : null}</span> },
          { title: "单数", dataIndex: "poCount", align: "right" },
          { title: "行数", dataIndex: "lineCount", align: "right" },
          { title: "件数", dataIndex: "orderedBaseQty", align: "right", render: (v: string) => qty(v) },
          { title: "未税金额", dataIndex: "netAmount", align: "right", render: (v: string | null) => v == null ? <Typography.Text type="secondary">无权限 / 无数据</Typography.Text> : yuan(v) },
        ]} />
      ) : undefined}
    >
      {(data) => (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Row gutter={12} style={{ marginBottom: 6 }}>
            <Col span={8}>
              <Statistic title={<span>{metricLabel("supplierOtif", "供应商 OTIF")}（{data.otifYtd.year} 年累计）</span>} value={pct(otifRatePct)} valueStyle={{ fontSize: 18 }} />
              <Muted>可评 n={data.otifYtd.evaluable} · 命中 {data.otifYtd.hit} · 未中 {data.otifYtd.miss} · 待评 {data.otifYtd.pending} · 不可评 {data.otifYtd.unevaluable}</Muted>
            </Col>
            <Col span={8}>
              <Statistic title={metricLabel("poOrderToDeliveryDays", "订单至交付")} value={data.cycle.p50 == null ? "样本不足" : `${data.cycle.p50} 天`} valueStyle={{ fontSize: 18 }} />
              <Muted>P90 {data.cycle.p90 ?? "—"} 天 · n={data.cycle.samples}{data.cycle.insufficient ? "（样本不足）" : ""}</Muted>
            </Col>
            <Col span={8}>
              <Statistic title="当月（进行中）" value={data.points.find((p) => p.isCurrent)?.poCount ?? 0} suffix="单" valueStyle={{ fontSize: 18, color: VISUAL_COLOR.neutral }} />
              <Muted>当月置灰：审批与收货尚未走完，结构性偏低</Muted>
            </Col>
          </Row>
          <div style={{ flex: 1, minHeight: 0 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} barCategoryGap="25%">
                <CartesianGrid stroke={t.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} tickFormatter={(v: string) => v.slice(2)} />
                <YAxis tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} width={48} tickFormatter={(v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} />
                <Tooltip {...t.tooltip} formatter={(v) => fmt(v)} cursor={{ fill: t.grid, opacity: 0.4 }} />
                <Bar dataKey="value" name={options.find((o) => o.value === measure)?.label ?? ""} radius={[4, 4, 0, 0]}>
                  {rows.map((r) => <Cell key={r.month} fill={r.isCurrent ? VISUAL_COLOR.muted : r.fromHistoryYear ? VISUAL_COLOR.compare : VISUAL_COLOR.primary} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Muted>浅色 = 上一年度（即时计算）；灰色 = 当月进行中。OTIF 只有年度累计口径，读模型无逐月 OTIF。</Muted>
        </div>
      )}
    </TrendCard>
  );
}

/* ───────────── 外部需求 7 日环比简报 ───────────── */

const ARROW: Record<"up" | "down" | "flat" | "unknown", { glyph: string; color: string; text: string }> = {
  up: { glyph: "↑", color: VISUAL_COLOR.positive, text: "上行" },
  down: { glyph: "↓", color: VISUAL_COLOR.critical, text: "下行" },
  flat: { glyph: "→", color: VISUAL_COLOR.neutral, text: "持平" },
  unknown: { glyph: "?", color: VISUAL_COLOR.neutral, text: "未知" },
};

function Movement({ label, dir, delta, unit }: { label: string; dir: keyof typeof ARROW; delta: number | null; unit: string }) {
  const a = ARROW[dir];
  return (
    <Col xs={12} md={6}>
      <Statistic title={label} value={a.glyph} suffix={<span style={{ fontSize: 14 }}>{signed(delta, unit)}</span>} valueStyle={{ color: a.color, fontSize: 22 }} />
      <Muted>{a.text}（方向 + 变化率，不下发件数）</Muted>
    </Col>
  );
}

export function ExternalDemandCard({ block }: { block: Block<ExternalDemandBriefBlock> }) {
  const d = block.data;
  return (
    <TrendCard
      block={block}
      title={`${metricLabel("externalNetDemand", "外部净需求")} · 近 7 日 vs 前 7 日`}
      question="这周外部需求或退款率动了吗？这个变动是真实的，还是身份覆盖在变？"
      metricId="externalNetDemand"
      grain="7 日滚动窗口（天猫）"
      unit="变化率 %"
      fitContent
      height={140}
      summary={d ? `净需求 ${ARROW[d.movement.netDemand].text} ${signed(d.change.netQtyPct)}；退款率 ${ARROW[d.movement.refundRate].text} ${signed(d.change.refundRateDeltaPp, "pp")}；映射覆盖 ${ARROW[d.movement.mappedPaidCoverage].text} ${signed(d.change.mappedPaidCoverageDeltaPp, "pp")}` : "无数据"}
    >
      {(data) => (
        <div>
          <Space wrap size={[6, 4]} style={{ marginBottom: 8 }}>
            <Tag color="blue">观察口径 · 只预警不定量</Tag>
            <Tag>窗口 {data.current.startDate} → {data.current.endDate}（{data.current.observedDays}/{data.current.requiredDays} 天）</Tag>
            <Tag>前窗口 {data.previous.startDate} → {data.previous.endDate}</Tag>
          </Space>
          <Row gutter={[12, 12]}>
            <Movement label="净需求" dir={data.movement.netDemand} delta={data.change.netQtyPct} unit="%" />
            <Movement label="支付件数" dir={data.change.paidQtyPct == null ? "unknown" : data.change.paidQtyPct > 0 ? "up" : data.change.paidQtyPct < 0 ? "down" : "flat"} delta={data.change.paidQtyPct} unit="%" />
            <Movement label={`${metricLabel("refundRate", "退款率")} ${pct(data.current.refundRatePct)}`} dir={data.movement.refundRate} delta={data.change.refundRateDeltaPp} unit="pp" />
            <Movement label={`映射覆盖 ${pct(data.current.mappedPaidCoveragePct)}`} dir={data.movement.mappedPaidCoverage} delta={data.change.mappedPaidCoverageDeltaPp} unit="pp" />
          </Row>
        </div>
      )}
    </TrendCard>
  );
}

/* ───────────── 可销天数 × 外部销速象限 ───────────── */

const QUADRANT_META: Record<Quadrant, { label: string; color: string }> = {
  stockout_risk: { label: "断货风险（覆盖薄·外部在卖）", color: VISUAL_COLOR.critical },
  writeoff_risk: { label: "呆滞风险（覆盖厚·外部无动销）", color: VISUAL_COLOR.warning },
  healthy: { label: "外销强·覆盖足", color: VISUAL_COLOR.positive },
  watch: { label: "观察", color: VISUAL_COLOR.neutral },
};
const TIER_ORDER = ["S", "A", "B", "C"] as const;
const tierColor = (tier: string | null): string => {
  const i = tier ? TIER_ORDER.indexOf(tier as (typeof TIER_ORDER)[number]) : -1;
  return i >= 0 ? SERIES_COLORS[i] : VISUAL_COLOR.muted;
};

export function QuadrantCard({ block }: { block: Block<QuadrantBlock> }) {
  const t = useChartTheme();
  const d = block.data;
  const plotted = (d?.points ?? []).filter((p) => p.coverDays != null);
  const infinite = (d?.points ?? []).filter((p) => p.coverDays == null).length;
  const byTier = TIER_ORDER.map((tier) => ({ tier, rows: plotted.filter((p) => p.tier === tier) }));
  const untiered = plotted.filter((p) => !p.tier);
  return (
    <TrendCard
      block={block}
      title={`${metricLabel("daysCover", "在库可销天数")} × ${metricLabel("externalNetDemand", "外部净需求")}`}
      question="哪些 SKU 内部库存看似充足但外部已经卖不动（呆滞风险）？哪些外部热卖但覆盖很薄（断货风险）？"
      metricId="daysCover"
      grain="成品 SKU（已映射外部身份）"
      unit="横轴 天 · 纵轴 外部观察净件数（天猫，近 30 天）"
      height={360}
      summary={d ? `已映射 ${d.coverage.mappedRows} 个 SKU：断货风险 ${d.counts.stockout_risk}、呆滞风险 ${d.counts.writeoff_risk}、外销强覆盖足 ${d.counts.healthy}、观察 ${d.counts.watch}；未映射 ${d.coverage.unmappedRows} 个排除` : "无数据"}
      dataView={d ? (
        <Table<QuadrantPoint> rowKey="skuId" size="small" pagination={{ pageSize: 20, size: "small" }} scroll={{ x: 760 }} dataSource={d.points} columns={[
          { title: "象限", dataIndex: "quadrant", width: 200, render: (v: Quadrant) => <Tag color={QUADRANT_META[v].color}>{QUADRANT_META[v].label}</Tag> },
          { title: "等级", dataIndex: "tier", width: 60, render: (v: string | null) => v ?? "—" },
          { title: "SKU", dataIndex: "code", width: 130 },
          { title: "品牌", dataIndex: "brand", width: 100, render: (v: string | null) => v ?? "—" },
          { title: "在库", dataIndex: "onHand", align: "right", render: (v: string) => qty(v) },
          { title: "可销天数", dataIndex: "coverDays", align: "right", render: (v: number | null) => v == null ? "∞（无动销）" : `${v}d` },
          { title: "阈值", dataIndex: "alertDays", align: "right", render: (v: number) => `${v}d` },
          { title: "外部净件数（天猫 30d）", dataIndex: "tmallNet30", align: "right" },
          { title: "90 日有售天数", dataIndex: "activeDays90", align: "right" },
        ]} />
      ) : undefined}
    >
      {(data) => (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Space wrap size={[6, 4]} style={{ marginBottom: 6 }}>
            {(Object.keys(QUADRANT_META) as Quadrant[]).map((q) => (
              <Tag key={q} color={QUADRANT_META[q].color}>{QUADRANT_META[q].label} {data.counts[q]}</Tag>
            ))}
            {infinite > 0 ? <Tag>可销 ∞（无动销）{infinite} 个未画入</Tag> : null}
          </Space>
          <div style={{ flex: 1, minHeight: 0 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid stroke={t.grid} strokeDasharray="3 3" />
                <XAxis type="number" dataKey="coverDays" name={data.axis.x} unit="d" tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} label={{ value: data.axis.x, position: "insideBottom", offset: -4, fill: t.axis, fontSize: 11 }} />
                <YAxis type="number" dataKey="tmallNet30" name={data.axis.y} tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} width={48} label={{ value: data.axis.y, angle: -90, position: "insideLeft", fill: t.axis, fontSize: 11 }} />
                <ReferenceLine x={data.thresholds.slowDays} stroke={VISUAL_COLOR.warning} strokeDasharray="4 2" label={{ value: `呆滞 ${data.thresholds.slowDays}d`, fill: t.axis, fontSize: 11, position: "top" }} />
                <Tooltip
                  {...t.tooltip}
                  cursor={{ strokeDasharray: "3 3" }}
                  content={({ payload }) => {
                    const p = payload?.[0]?.payload as QuadrantPoint | undefined;
                    if (!p) return null;
                    return (
                      <div style={t.tooltip.contentStyle}>
                        <div><b>{p.code}</b> {p.brand ?? ""} {p.tier ? <Tag>{p.tier}</Tag> : null}</div>
                        <div>可销 {p.coverDays == null ? "∞" : `${p.coverDays}d`}（阈值 {p.alertDays}d）· 在库 {qty(p.onHand)}</div>
                        <div>外部净件数（天猫 30d）{p.tmallNet30} · 90 日有售 {p.activeDays90} 天</div>
                        <div style={{ color: QUADRANT_META[p.quadrant].color }}>{QUADRANT_META[p.quadrant].label}</div>
                      </div>
                    );
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {byTier.map(({ tier, rows }) => (
                  <Scatter key={tier} name={`${tier} 级`} data={rows} fill={tierColor(tier)} fillOpacity={0.75} shape="circle" />
                ))}
                {untiered.length ? <Scatter name="未分层" data={untiered} fill={VISUAL_COLOR.muted} shape="circle" /> : null}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <Muted>纵轴为观察口径（拼多多未接入，仅天猫），只用于定位象限，不进补货数量；点色 = ABC 等级。</Muted>
        </div>
      )}
    </TrendCard>
  );
}
