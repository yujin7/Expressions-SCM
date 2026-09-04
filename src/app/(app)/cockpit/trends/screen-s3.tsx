"use client";

import Link from "next/link";
import { Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { VISUAL_COLOR } from "@/components/decision-visuals";
import { formatCount, formatPct } from "@/components/format";
import type { Block } from "@/server/modules/report/cockpit";
import type { ExpiryBrandRow, ExpiryBucketsBlock, TurnoverWindowCell, TurnoverWindowRow, TurnoverWindowsBlock } from "@/server/modules/report/cockpit-trends";
import { metricLabel, Muted, TrendCard, useChartTheme } from "./shared";

function CellValue({ c }: { c: TurnoverWindowCell }) {
  if (c.suppressed) {
    return <Tooltip title={c.reason ?? "压制"}><Typography.Text type="secondary">—</Typography.Text></Tooltip>;
  }
  return <span>{c.turns} <Typography.Text type="secondary">/ {c.dio ?? "—"}d</Typography.Text></span>;
}

/** 屏3 · 三窗口（30/90/365 天）周转与 DIO 并列——同日三窗口是无需新算的趋势代理 */
export function TurnoverWindowsCard({ block }: { block: Block<TurnoverWindowsBlock> }) {
  const d = block.data;
  const windows = d?.windows ?? [];
  const columns: ColumnsType<TurnoverWindowRow> = [
    { title: "地区", dataIndex: "regionCode", width: 70 },
    { title: "仓库", dataIndex: "name", ellipsis: true },
    { title: "在库", dataIndex: "onHand", align: "right", width: 100, render: (v: string) => formatCount(v) },
    ...windows.map((w, i) => ({
      title: `${w} 天 周转 / DIO`, key: `w${w}`, align: "right" as const, width: 130,
      render: (_: unknown, r: TurnoverWindowRow) => r.windows[i] ? <CellValue c={r.windows[i]} /> : "—",
    })),
  ];
  return (
    <TrendCard
      block={block}
      title={`${metricLabel("warehouseTurns", "逐仓周转次数")} · 30 / 90 / 365 天窗口并列`}
      question="周转是在恶化还是改善？同一天看三个窗口，短窗口低于长窗口意味着近期放缓。"
      metricId="warehouseTurns"
      grain="实时仓 × 窗口"
      unit="年化周转次数 / 库存天数"
      contentIsTable
      fitContent
      height={220}
      summary={d ? `窗口 ${d.windows.join("/")} 天；总周转 ${d.summary.map((c) => c.suppressed ? "—" : String(c.turns)).join(" / ")}；${d.rows.length} 个实时仓` : "无数据"}
    >
      {(data) => (
        <div>
          <Space wrap size={[8, 4]} style={{ marginBottom: 8 }}>
            {data.summary.map((c) => (
              <Tag key={c.windowDays} color={c.suppressed ? "default" : "processing"}>
                {c.windowDays} 天：{c.suppressed ? `— （${c.reason}）` : `周转 ${c.turns} · ${metricLabel("warehouseDio", "DIO")} ${c.dio ?? "—"} 天 · 出库 ${formatCount(c.outboundQty)}`}
              </Tag>
            ))}
          </Space>
          <Table<TurnoverWindowRow> rowKey="warehouseId" size="small" pagination={false} scroll={{ x: 640 }} dataSource={data.rows} columns={columns} />
          <Muted>只算实时仓（快照仓无流水不计算）；出库含调拨/发料/盘亏；窗口覆盖不完整（流水最早日 {data.ledgerFirstDay ?? "—"} 晚于窗口起点）或零出库时压制不显示。</Muted>
        </div>
      )}
    </TrendCard>
  );
}

/* ───────────── 临期与呆滞（C3） ───────────── */

const BUCKET_COLOR: Record<string, string> = {
  expired: VISUAL_COLOR.critical,
  d30: VISUAL_COLOR.warning,
  d60: VISUAL_COLOR.accent,
  d90: VISUAL_COLOR.compare,
};

/** 屏3 · 已过期 / ≤30 / 31–60 / 61–90 天效期段位 × 品牌 + 呆滞在库 */
export function ExpiryBucketsCard({ block }: { block: Block<ExpiryBucketsBlock> }) {
  const t = useChartTheme();
  const d = block.data;
  const keys = (d?.totals ?? []).map((b) => b.key);
  const chartRows = (d?.brands ?? []).map((b) => ({
    brand: b.brand.length > 8 ? `${b.brand.slice(0, 7)}…` : b.brand,
    ...b.buckets,
  }));
  return (
    <TrendCard
      block={block}
      title={`${metricLabel("expiryByBrand", "效期分布（按品牌）")} · 临期与呆滞`}
      question="多少货在 30/60/90 天内到期、在哪个品牌？其中还有哪些外部其实还在卖？"
      metricId="expiryByBrand"
      grain="品牌 × 效期段位（批次剩余天数）"
      unit="基础单位数量 · SKU 数"
      height={330}
      summary={d
        ? `${d.totals.map((b) => `${b.label} ${formatCount(b.qty)}（${b.skus} 个 SKU）`).join("；")}；呆滞（可销 ≥ ${d.slowThreshold} 天）${d.slowSkus} 个 SKU`
        : "无数据"}
      extra={d ? <Link href={d.link} prefetch={false}>风险处置工作台 →</Link> : undefined}
      dataView={d ? (
        <Table<ExpiryBrandRow> rowKey="brand" size="small" pagination={false} scroll={{ x: 780 }} dataSource={d.brands} columns={[
          { title: "品牌", dataIndex: "brand", width: 140, fixed: "left" },
          ...(d.totals.map((b) => ({
            title: b.label, key: b.key, align: "right" as const, width: 110,
            render: (_v: unknown, r: ExpiryBrandRow) => formatCount(r.buckets[b.key]),
          }))),
          { title: "临期 SKU", dataIndex: "expirySkus", align: "right", width: 100 },
          { title: `呆滞 SKU（≥${d.slowThreshold}d）`, dataIndex: "slowSkus", align: "right", width: 150 },
          { title: "呆滞在库", dataIndex: "slowOnHand", align: "right", width: 110, render: (v: number) => formatCount(v) },
          { title: "外部仍在卖", dataIndex: "slowStillSellingExternally", align: "right", width: 110 },
        ]} />
      ) : undefined}
    >
      {(data) => (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Space wrap size={[6, 4]} style={{ marginBottom: 6 }}>
            {data.totals.map((b) => (
              <Tag key={b.key} color={b.key === "expired" ? "error" : b.key === "d30" ? "warning" : "processing"}>
                {b.label} {formatCount(b.qty)} · {b.skus} 个 SKU
              </Tag>
            ))}
            <Tag>{metricLabel("expirySlowMoverOnHand", "呆滞在库")} {data.slowSkus} 个 SKU（可销 ≥ {data.slowThreshold} 天）</Tag>
            {data.externalNote.stillSelling > 0
              ? <Tag color="blue">外部近 30 天仍在卖 {data.externalNote.stillSelling}/{data.externalNote.withSignal}（观察注记）</Tag>
              : null}
          </Space>
          <div style={{ flex: 1, minHeight: 0 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartRows} margin={{ top: 4, right: 12, left: 0, bottom: 0 }} barCategoryGap="25%">
                <CartesianGrid stroke={t.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="brand" tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} interval={0} />
                <YAxis tick={{ fill: t.axis, fontSize: 11 }} stroke={t.grid} width={52} tickFormatter={(v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} />
                <ChartTooltip {...t.tooltip} cursor={{ fill: t.grid, opacity: 0.4 }} formatter={(v, name) => [formatCount(typeof v === "number" ? v : null), name]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {keys.map((k, i) => (
                  <Bar key={k} dataKey={k} stackId="e" name={data.totals[i]?.label ?? k} fill={BUCKET_COLOR[k] ?? VISUAL_COLOR.muted}
                    radius={i === keys.length - 1 ? [4, 4, 0, 0] : undefined} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Muted>
            段位按批次剩余天数统一刻度，&gt; 90 天不入桶；其中 {data.fallbackSkus} 个 SKU（{formatPct(data.fallbackSharePct, 1)}）的临期阈值走 90 天兜底，段位并非逐 SKU 统一口径。
            数量取 batch_stocks（效期盘点载体，不是账本）；外部动销为观察注记，不驱动处置数量。
          </Muted>
        </div>
      )}
    </TrendCard>
  );
}
