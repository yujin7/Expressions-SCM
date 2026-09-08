"use client";

import { useState } from "react";
import Link from "next/link";
import { Col, Progress, Row, Segmented, Space, Statistic, Table, Tag, Tooltip as AntTooltip, Typography } from "antd";
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import { SERIES_COLORS, VISUAL_COLOR } from "@/components/decision-visuals";
import { formatCount, formatPct, formatYuan } from "@/components/format";
import type { Block } from "@/server/modules/report/cockpit";
import type { AlertPrecisionBlock, AlertPrecisionRow, ExternalDemandBriefBlock, PoTrendBlock, PoTrendPoint, Quadrant, QuadrantBlock, QuadrantPoint, SupplierConcentrationBlock, SupplierConcentrationRow } from "@/server/modules/report/cockpit-trends";
import { metricLabel, Muted, num, signed, TrendCard, useChartTheme } from "./shared";

/* ───────────── 采购订单月趋势 ───────────── */

type PoMeasure = "count" | "qty" | "amount";

const OTIF_SERIES = "逐月 OTIF";

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
    // 逐月 OTIF：可评为 0 的月给 null（connectNulls=false → 线断开），绝不画成 0%
    otifRatePct: p.otif.evaluable > 0 ? p.otifRatePct : null,
    otifEvaluable: p.otif.evaluable,
    isCurrent: p.isCurrent,
    fromHistoryYear: p.fromHistoryYear,
  }));
  const fmt = (v: unknown) => {
    const x = typeof v === "number" || typeof v === "string" ? v : null;
    return measure === "amount" ? formatYuan(x == null ? null : String(x)) : measure === "count" ? `${formatCount(x)} 单` : `${formatCount(x)} 件`;
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
      summary={d ? `${d.points[0]?.month ?? ""} → ${d.points.at(-1)?.month ?? ""} 共 ${d.points.length} 个月；逐月 OTIF 有可评样本 ${d.monthsWithOtif}/${d.points.length} 个月（年度累计 ${formatPct(otifRatePct, 1)}，可评 n=${d.otifYtd.evaluable}）；订单→首批 P50 ${d.cycle.p50 ?? "—"} 天（n=${d.cycle.samples}）` : "无数据"}
      extra={<Segmented size="small" options={options} value={measure} onChange={(v) => setMeasure(v as PoMeasure)} />}
      dataView={d ? (
        <Table<PoTrendPoint> rowKey="month" size="small" pagination={false} scroll={{ y: 240 }} dataSource={d.points} columns={[
          { title: "月份", dataIndex: "month", width: 90, render: (v: string, r) => <span>{v}{r.isCurrent ? <Tag style={{ marginLeft: 4 }}>当月</Tag> : null}</span> },
          { title: "单数", dataIndex: "poCount", align: "right" },
          { title: "行数", dataIndex: "lineCount", align: "right" },
          { title: "件数", dataIndex: "orderedBaseQty", align: "right", render: (v: string) => formatCount(v) },
          { title: "未税金额", dataIndex: "netAmount", align: "right", render: (v: string | null) => v == null ? <Typography.Text type="secondary">无权限 / 无数据</Typography.Text> : formatYuan(v) },
          { title: "逐月 OTIF", key: "otif", align: "right", width: 170, render: (_v, r) => r.otif.evaluable === 0
            ? <Typography.Text type="secondary">不可评（待评 {r.otif.pending} · 缺承诺日 {r.otif.unevaluable}）</Typography.Text>
            : <span>{formatPct(r.otifRatePct, 1)} <Typography.Text type="secondary">n={r.otif.evaluable}</Typography.Text></span> },
        ]} />
      ) : undefined}
    >
      {(data) => (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Row gutter={12} style={{ marginBottom: 6 }}>
            <Col span={8}>
              <Statistic title={<span>{metricLabel("poMonthlyOtif", "逐月 OTIF")}（{data.otifYtd.year} 年累计对照）</span>} value={formatPct(otifRatePct, 1)} valueStyle={{ fontSize: 18 }} />
              <Muted>逐月可评 {data.monthsWithOtif}/{data.points.length} 月 · 年度累计可评 n={data.otifYtd.evaluable} · 命中 {data.otifYtd.hit} · 未中 {data.otifYtd.miss} · 待评 {data.otifYtd.pending} · 不可评 {data.otifYtd.unevaluable}</Muted>
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
              <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} barCategoryGap="25%">
                <CartesianGrid stroke={t.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} tickFormatter={(v: string) => v.slice(2)} />
                <YAxis yAxisId="v" tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} width={48} tickFormatter={(v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} />
                <YAxis yAxisId="otif" orientation="right" domain={[0, 100]} width={44} tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} tickFormatter={(v) => `${v}%`} />
                <Tooltip {...t.tooltip} cursor={{ fill: t.grid, opacity: 0.4 }}
                  formatter={(v, name, item) => name === OTIF_SERIES
                    ? [`${formatPct(typeof v === "number" ? v : null, 1)}（n=${(item?.payload as { otifEvaluable?: number } | undefined)?.otifEvaluable ?? 0}）`, name]
                    : [fmt(v), name]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar yAxisId="v" dataKey="value" name={options.find((o) => o.value === measure)?.label ?? ""} radius={[4, 4, 0, 0]}>
                  {rows.map((r) => <Cell key={r.month} fill={r.isCurrent ? VISUAL_COLOR.muted : r.fromHistoryYear ? VISUAL_COLOR.compare : VISUAL_COLOR.primary} />)}
                </Bar>
                <Line yAxisId="otif" type="monotone" dataKey="otifRatePct" name={OTIF_SERIES} stroke={VISUAL_COLOR.warning} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <Space wrap size={[10, 4]} style={{ marginTop: 6 }}>
            {data.links.map((l) => (
              <Link key={`${l.metricId}-${l.href}`} href={l.href} prefetch={false}>{l.label} →</Link>
            ))}
          </Space>
          <Muted>浅色 = 上一年度（即时计算）；灰色 = 当月进行中。橙线为逐月 OTIF（右轴），可评样本为 0 的月断开不画——那是「不可评」不是 0%。</Muted>
        </div>
      )}
    </TrendCard>
  );
}

/* ───────────── 供应商集中度 × 账期 × OTIF（C2） ───────────── */

const ATTAINMENT_META: Record<string, { text: string; color: string }> = {
  attained: { text: "已达标", color: "success" },
  below_target: { text: "低于目标", color: "warning" },
  not_credit: { text: "非账期", color: "default" },
  unknown: { text: "待核对", color: "default" },
  pending: { text: "待生效", color: "warning" },
};
const RANK_TREND_META: Record<string, string> = { up: "名次较上一年上升", down: "名次较上一年下降", flat: "名次持平", unknown: "缺对比年，无名次趋势" };

export function SupplierConcentrationCard({ block }: { block: Block<SupplierConcentrationBlock> }) {
  const t = useChartTheme();
  const d = block.data;
  const rows = (d?.rows ?? []).map((r) => ({ ...r, shortName: r.name.length > 10 ? `${r.name.slice(0, 9)}…` : r.name }));
  return (
    <TrendCard
      block={block}
      title={`${metricLabel("supplierSpendConcentration", "供应商采购额集中度")} · 前 ${d?.topN ?? 5} 家 × 账期 × OTIF`}
      question="采购额有多少压在前 5 家？他们在往账期走吗？这几家是不是正好也是 OTIF 掉队的那几家？"
      metricId="supplierSpendConcentration"
      grain={`供应商（${d?.year ?? ""} 年，PO 未税 + JS 结算）`}
      unit="占比 % · OTIF %"
      height={330}
      summary={d
        ? `前 ${d.topN} 家占 ${formatPct(d.topSharePct, 1)}（有采购额供应商 ${d.suppliersWithSpend} 家）；账期类采购额占比 ${formatPct(d.creditTermSpendSharePct, 1)}；账期达成率 ${formatPct(d.attainment.rate, 1)}（候选 ${d.attainment.candidates} 家、达标 ${d.attainment.attained} 家）`
        : "无数据"}
      extra={d ? <Link href={d.link} prefetch={false}>供应商记分卡 →</Link> : undefined}
      dataView={d ? (
        <Table<SupplierConcentrationRow> rowKey="supplierId" size="small" pagination={false} scroll={{ x: 940 }} dataSource={d.rows} columns={[
          { title: "名次", dataIndex: "rank", width: 70, align: "right", render: (v: number | null, r) => <AntTooltip title={RANK_TREND_META[r.rankTrend] ?? ""}><span>{v ?? "—"}</span></AntTooltip> },
          { title: "供应商", dataIndex: "name", width: 180, ellipsis: true, render: (v: string, r) => `${r.code} ${v}` },
          { title: "分池", dataIndex: "poolLabel", width: 100 },
          { title: "采购额", dataIndex: "spend", width: 120, align: "right", render: (v: string | null) => v == null ? <Typography.Text type="secondary">无权限</Typography.Text> : formatYuan(v) },
          { title: "占比", dataIndex: "sharePct", width: 90, align: "right", render: (v: number | null) => formatPct(v, 1) },
          { title: "合作年限", dataIndex: "cooperationYears", width: 110, align: "right", render: (v: number | null, r) => v == null ? "—" : <AntTooltip title={r.cooperationSource === "system_inferred" ? "由最早已批 PO/JG 建单日系统推算，不是供应商主数据" : ""}><span>{v} 年{r.cooperationSource === "system_inferred" ? " *" : ""}</span></AntTooltip> },
          { title: "登记账期", dataIndex: "paymentTermText", width: 180, render: (v: string | null, r) => <Space direction="vertical" size={0}><Tag color={ATTAINMENT_META[r.attainment]?.color}>{ATTAINMENT_META[r.attainment]?.text ?? r.attainment}</Tag><span>{v ?? "—"}</span>{r.paymentTermEffectiveFrom ? <Typography.Text type="secondary">生效日 {r.paymentTermEffectiveFrom}</Typography.Text> : null}</Space> },
          { title: "OTIF", key: "otif", width: 180, align: "right", render: (_v, r) => r.otif == null || r.otif.evaluable === 0
            ? <Typography.Text type="secondary">当年无可评 PO</Typography.Text>
            : <span>{formatPct(r.otifRatePct, 1)} <Typography.Text type="secondary">n={r.otif.evaluable}</Typography.Text></span> },
        ]} />
      ) : undefined}
    >
      {(data) => (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Row gutter={12} style={{ marginBottom: 6 }}>
            <Col xs={12} md={8}>
              <Statistic title={`前 ${data.topN} 家采购额占比`} value={formatPct(data.topSharePct, 1)} valueStyle={{ fontSize: 18 }} />
              <Muted>有采购额供应商 {data.suppliersWithSpend} 家{data.moneyVisible ? "" : "（金额无权限，占比仍全员可见）"}</Muted>
            </Col>
            <Col xs={12} md={8}>
              <Statistic title={metricLabel("creditTermSpendShare", "账期类采购额占比")} value={formatPct(data.creditTermSpendSharePct, 1)} valueStyle={{ fontSize: 18 }} />
              <Muted>截至 {data.termAsOf} 的采购代理，非应付余额。{data.unclassifiedSpendSuppliers > 0 ? `${data.unclassifiedSpendSuppliers} 家有采购额的条款待核对/待生效，占比留空。` : "只计当前已生效月结。"}</Muted>
            </Col>
            <Col xs={24} md={8}>
              <Statistic title={metricLabel("paymentTermAttainment", "账期达成率")} value={formatPct(data.attainment.rate, 1)} valueStyle={{ fontSize: 18 }} />
              <Progress percent={data.attainment.rate ?? 0} size="small" showInfo={false} status={data.attainment.rate == null ? "normal" : data.attainment.rate >= 100 ? "success" : "active"} />
              <Muted>候选 {data.attainment.candidates} 家 · 达标 {data.attainment.attained} 家；候选为 0 时无值而不是 100%</Muted>
            </Col>
          </Row>
          <div style={{ flex: 1, minHeight: 0 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid stroke={t.grid} strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" domain={[0, 100]} tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} tickFormatter={(v) => `${v}%`} />
                <YAxis type="category" dataKey="shortName" width={110} tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} />
                <Tooltip {...t.tooltip} cursor={{ fill: t.grid, opacity: 0.4 }} formatter={(v, name) => [formatPct(typeof v === "number" ? v : null, 1), name]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="sharePct" name="采购额占比" fill={VISUAL_COLOR.primary} radius={[0, 4, 4, 0]} />
                <Bar dataKey="otifRatePct" name="OTIF（当年可评）" fill={VISUAL_COLOR.warning} radius={[0, 4, 4, 0]} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <Muted>
            合作年限由最早已批 PO/JG 建单日系统推算（cooperationSource=system_inferred，{data.cooperationInferred}/{data.rows.length} 家），不是供应商主数据；
            OTIF 只在该供应商当年有可评 PO 时才有条（{data.otifMatched}/{data.rows.length} 家），其余不画、不按 0% 处理。
          </Muted>
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
            <Movement label={`${metricLabel("refundRate", "退款率")} ${formatPct(data.current.refundRatePct, 1)}`} dir={data.movement.refundRate} delta={data.change.refundRateDeltaPp} unit="pp" />
            <Movement label={`映射覆盖 ${formatPct(data.current.mappedPaidCoveragePct, 1)}`} dir={data.movement.mappedPaidCoverage} delta={data.change.mappedPaidCoverageDeltaPp} unit="pp" />
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
          { title: "在库", dataIndex: "onHand", align: "right", render: (v: string) => formatCount(v) },
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
                        <div>可销 {p.coverDays == null ? "∞" : `${p.coverDays}d`}（阈值 {p.alertDays}d）· 在库 {formatCount(p.onHand)}</div>
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

/* ───────────── 预警命中率（已验证） ───────────── */

export function AlertPrecisionCard({ block }: { block: Block<AlertPrecisionBlock> }) {
  const t = useChartTheme();
  const d = block.data;
  const groups = d?.groups ?? [];
  const precisionText = (g: AlertPrecisionRow, minSample: number) =>
    g.insufficient ? `样本不足（真+误 ${g.scored} < ${minSample}）` : `${formatPct(g.precisionPct, 1)} · n=${g.scored}`;
  return (
    <TrendCard
      block={block}
      title={`${metricLabel("alertPrecision", "预警命中率（已验证）")} · 近 ${d?.days ?? 90} 天`}
      question="系统喊「要断货」的告警，后来到底断了没有？哪条规则误报多——该调阈值，而不是催人？"
      metricId="alertPrecision"
      grain="告警类别 × 来源规则（按核验时间）"
      unit="条 · 精确率 %"
      height={300}
      summary={d
        ? `当前口径已核验 ${d.verifiedTotal} 条：真 ${d.totals.truePositive}、误报 ${d.totals.falsePositive}、弃权 ${d.totals.unverifiable}；旧口径 ${d.legacyVerifiedTotal} 条单列不计分；${groups.map((g) => `${g.label} ${precisionText(g, d.minSample)}`).join("，")}`
        : "无数据"}
      dataView={d ? (
        <Table<AlertPrecisionRow> rowKey="key" size="small" pagination={false} scroll={{ x: 640 }} dataSource={d.groups} columns={[
          { title: "类别 / 规则", dataIndex: "label", width: 220 },
          { title: "已核验", dataIndex: "verified", align: "right", width: 80 },
          { title: "真", dataIndex: "truePositive", align: "right", width: 70 },
          { title: "误报", dataIndex: "falsePositive", align: "right", width: 70 },
          { title: "弃权", dataIndex: "unverifiable", align: "right", width: 70 },
          { title: "精确率", key: "p", align: "right", width: 170, render: (_, r) => precisionText(r, d.minSample) },
        ]} />
      ) : undefined}
    >
      {(data) => (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Space wrap size={[6, 4]} style={{ marginBottom: 6 }}>
            {data.groups.map((g) => (
              <Tag key={g.key} color={g.insufficient ? "default" : "processing"}>
                {g.label}：{precisionText(g, data.minSample)}
              </Tag>
            ))}
          </Space>
          <div style={{ flex: 1, minHeight: 0 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.groups} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid stroke={t.grid} strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" allowDecimals={false} tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} />
                <YAxis type="category" dataKey="label" width={160} tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} />
                <Tooltip {...t.tooltip} cursor={{ fill: t.grid, opacity: 0.4 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="truePositive" name="真（断货确实发生）" stackId="s" fill={VISUAL_COLOR.positive} />
                <Bar dataKey="falsePositive" name="误报（未断货且无入库）" stackId="s" fill={VISUAL_COLOR.critical} />
                <Bar dataKey="unverifiable" name="弃权（不进分母）" stackId="s" fill={VISUAL_COLOR.muted} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Muted>{data.caliber}</Muted>
        </div>
      )}
    </TrendCard>
  );
}
