"use client";

/**
 * E7-03：销量变化瀑布图 + KPI 异动自动归因（只读，sales_monthly 单源）。
 * 瀑布图用 recharts <BarChart> + <Bar dataKey="range"> 的「区间条」（每条 [base, base+delta]）实现：
 * 首尾为从 0 起的实心总量柱，中间为悬浮的增减条，视觉上首尾差额即由中间项累加构成。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, App, Card, Radio, Select, Skeleton, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fetchJson } from "@/components/fetchJson";
import DecisionVisual from "@/components/DecisionVisual";
import { VISUAL_COLOR } from "@/components/decision-visuals";
import { formatQty } from "@/components/format";
import { useListState } from "@/components/useListState";
import type { BridgeDim, SalesBridgeResult } from "@/server/modules/report/sales-bridge";

const COLOR_TOTAL = VISUAL_COLOR.primary;
const COLOR_UP = VISUAL_COLOR.positive;
const COLOR_DOWN = VISUAL_COLOR.critical;
const COLOR_OTHER = VISUAL_COLOR.neutral;

const DIM_OPTIONS: { label: string; value: BridgeDim }[] = [
  { label: "品牌", value: "brand" },
  { label: "渠道", value: "channel" },
  { label: "SKU", value: "sku" },
];
const DIM_CN: Record<BridgeDim, string> = { brand: "品牌", channel: "渠道", sku: "SKU" };

/** 数量展示：万级折「万」便于口播，底数仍走 formatQty（去尾零） */
const qty = (v: number): string =>
  Math.abs(v) >= 10000 ? `${formatQty(Math.round(v / 1000) / 10)} 万` : formatQty(Math.round(v * 10000) / 10000);
/** 带符号数量 */
const sq = (v: number): string => `${v > 0 ? "+" : v < 0 ? "−" : ""}${qty(Math.abs(v))}`;

/** 瀑布条：range=[低, 高]（区间条），delta=该条代表的增减/总量 */
interface WfRow {
  name: string;
  range: [number, number];
  delta: number;
  kind: "total" | "up" | "down" | "other";
}

/** 明细表行（含「其他」合并行） */
interface DetailRow {
  key: string;
  label: string;
  delta: number;
  isOther: boolean;
}

export default function SalesBridgeClient() {
  const { message } = App.useApp();
  const router = useRouter();
  const [data, setData] = useState<SalesBridgeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const viewState = useListState({
    key: "sales-bridge",
    defaults: { dim: "brand", fromYm: "", toYm: "" },
    paginated: false,
  });
  const dim = (["brand", "channel", "sku"].includes(viewState.filters.dim)
    ? viewState.filters.dim
    : "brand") as BridgeDim;
  const fromYm = viewState.filters.fromYm;
  const toYm = viewState.filters.toYm;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ dim });
      if (fromYm) params.set("fromYm", fromYm);
      if (toYm) params.set("toYm", toYm);
      setData(await fetchJson<SalesBridgeResult>(`/api/report/sales-bridge?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [dim, fromYm, toYm, message]);
  useEffect(() => { void load(); }, [load]);

  /* ── 瀑布数据：起始总量柱 → 各增减悬浮条 → 结束总量柱 ── */
  const wf = useMemo<WfRow[]>(() => {
    if (!data || !data.fromYm) return [];
    const rows: WfRow[] = [{ name: data.fromYm, range: [Math.min(0, data.from), Math.max(0, data.from)], delta: data.from, kind: "total" }];
    let base = data.from;
    const push = (name: string, delta: number, kind: WfRow["kind"]) => {
      const next = base + delta;
      rows.push({ name, range: [Math.min(base, next), Math.max(base, next)], delta, kind });
      base = next;
    };
    for (const it of data.items) push(it.label, it.delta, it.delta >= 0 ? "up" : "down");
    if (data.othersDelta !== 0) push("其他", data.othersDelta, "other");
    rows.push({ name: data.toYm, range: [Math.min(0, data.to), Math.max(0, data.to)], delta: data.to, kind: "total" });
    return rows;
  }, [data]);

  const detail = useMemo<DetailRow[]>(() => {
    if (!data) return [];
    const rows: DetailRow[] = data.items.map((i) => ({ key: i.key, label: i.label, delta: i.delta, isOther: false }));
    if (data.othersDelta !== 0) rows.push({ key: "__others__", label: "其他（未进 TOP8 的项合计）", delta: data.othersDelta, isOther: true });
    return rows;
  }, [data]);

  /** 明细行 → 对应筛选页（渠道无独立筛选页，不跳转） */
  const hrefOf = (r: DetailRow): string | null => {
    if (r.isOther || !data) return null;
    if (data.dim === "brand") return `/report/segmentation?q=${encodeURIComponent(r.key)}`;
    if (data.dim === "sku") return `/report/sku-360?sku=${encodeURIComponent(r.key)}`;
    return null;
  };

  /* ── 异动自动归因文案 ── */
  const narrative = useMemo<string>(() => {
    if (!data || !data.fromYm || !data.toYm) return "暂无销量数据，无法归因。";
    const up = data.total >= 0;
    const pct = data.from !== 0 ? `（${up ? "+" : "−"}${Math.abs((data.total / data.from) * 100).toFixed(1)}%）` : "";
    const parts = [`${data.toYm} 比 ${data.fromYm} ${up ? "增加" : "减少"} ${qty(Math.abs(data.total))}${pct}`];
    const side = (s: { ups: { label: string; delta: number }[]; downs: { label: string; delta: number }[] }, main: boolean) =>
      (up === main ? s.ups : s.downs)[0];
    const brandMain = side(data.attribution.brand, true);
    const chMain = side(data.attribution.channel, true);
    const mains = [
      brandMain ? `品牌${brandMain.label}（${sq(brandMain.delta)}）` : null,
      chMain ? `渠道${chMain.label}（${sq(chMain.delta)}）` : null,
    ].filter(Boolean) as string[];
    if (mains.length) parts.push(`主要来自${mains.join("与")}`);
    const drags = [
      side(data.attribution.brand, false) ? { t: "品牌", ...side(data.attribution.brand, false) } : null,
      side(data.attribution.channel, false) ? { t: "渠道", ...side(data.attribution.channel, false) } : null,
    ].filter(Boolean) as { t: string; label: string; delta: number }[];
    drags.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    if (drags[0]) parts.push(`${up ? "拖累项" : "对冲项"}为${drags[0].t}${drags[0].label}（${sq(drags[0].delta)}）`);
    const best = (Object.keys(data.byDim) as BridgeDim[]).sort((a, b) => data.byDim[b] - data.byDim[a])[0];
    if (data.byDim[best] > 0) parts.push(`按${DIM_CN[best]}拆分最能解释本次变化（最大单项 ${qty(data.byDim[best])}）`);
    return `${parts.join("；")}。`;
  }, [data]);

  const columns: ColumnsType<DetailRow> = [
    {
      title: "项目",
      dataIndex: "label",
      render: (v: string, r) => {
        const href = hrefOf(r);
        return href ? <a href={href} onClick={(e) => e.preventDefault()}>{v}</a> : <span>{v}</span>;
      },
    },
    {
      title: "增减",
      dataIndex: "delta",
      width: 160,
      align: "right",
      render: (v: number) => (
        <Typography.Text type={v > 0 ? "success" : v < 0 ? "danger" : undefined} strong>
          {v > 0 ? "+" : v < 0 ? "−" : ""}
          {formatQty(Math.abs(v))}
        </Typography.Text>
      ),
    },
    {
      title: "占变化比重",
      dataIndex: "delta",
      key: "share",
      width: 130,
      align: "right",
      render: (v: number) =>
        !data || data.total === 0 ? <Typography.Text type="secondary">—</Typography.Text> : `${((v / data.total) * 100).toFixed(1)}%`,
    },
  ];

  if (loading && !data) return <Skeleton active paragraph={{ rows: 10 }} />;

  const monthOpts = (data?.months ?? []).map((mth) => ({ label: mth, value: mth }));
  const curFrom = fromYm || data?.fromYm || "";
  const curTo = toYm || data?.toYm || "";

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>销量变化归因</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="瀑布（bridge）分解：起始月总量 → 各维度增减 → 结束月总量。左右两根蓝柱为两期总量，中间悬浮条按 |变化| 取 TOP8，其余合并为「其他」；条目合计恒等于首尾差额。"
        description={<Typography.Text type="secondary">口径：sales_monthly 全渠道月销量（跨 SKU 直加仅作趋势参考）；默认对比数据最新月与其上一月。</Typography.Text>}
      />

      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap size={16}>
          <Space size={8}>
            <Typography.Text type="secondary">拆分维度</Typography.Text>
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              size="small"
              value={dim}
              options={DIM_OPTIONS}
              onChange={(event) => viewState.setFilter({ dim: event.target.value as BridgeDim })}
            />
          </Space>
          <Space size={8}>
            <Typography.Text type="secondary">对比区间</Typography.Text>
            {monthOpts.length > 0 ? (
              <>
                <Select size="small" style={{ width: 120 }} value={curFrom || undefined} options={monthOpts} onChange={(value) => viewState.setFilter({ fromYm: value })} placeholder="起始月" />
                <span>→</span>
                <Select size="small" style={{ width: 120 }} value={curTo || undefined} options={monthOpts} onChange={(value) => viewState.setFilter({ toYm: value })} placeholder="结束月" />
              </>
            ) : (
              <Typography.Text>{curFrom || "—"} → {curTo || "—"}</Typography.Text>
            )}
          </Space>
          <Space size={6}>
            <Typography.Text type="secondary">维度解释力（最大单项）</Typography.Text>
            {(["brand", "channel", "sku"] as BridgeDim[]).map((d) => (
              <Tag key={d} color={data && data.byDim[d] === Math.max(...Object.values(data.byDim)) && data.byDim[d] > 0 ? "blue" : undefined}>
                {DIM_CN[d]} {qty(data?.byDim[d] ?? 0)}
              </Tag>
            ))}
          </Space>
        </Space>
      </Card>

      <Alert
        type={data && data.total >= 0 ? "success" : "warning"}
        showIcon
        style={{ marginBottom: 12 }}
        message="异动自动归因"
        description={<Typography.Text>{narrative}</Typography.Text>}
      />

      <DecisionVisual
        title={`销量变化瀑布（按${data ? DIM_CN[data.dim] : ""}拆分）`}
        question="两个月销量为何变化，哪些项目贡献增长或造成下滑？"
        metricId="salesQty"
        grain={`月 × ${DIM_CN[dim]}`}
        unit="基础单位数量"
        source={{
          tier: "snapshot",
          source: "sales_monthly 销售月事实",
          asOf: data?.toYm,
        }}
        coverage={{ covered: data?.months.length ?? 0, total: 6, label: "可选月份" }}
        activeFilters={[`${curFrom || "—"} → ${curTo || "—"}`, `按${DIM_CN[dim]}`]}
        summary={narrative}
        caveat="当前只有月粒度数量；跨 SKU 汇总用于解释趋势，不代表收入或毛利变化。TOP 8 之外合并为“其他”。"
        state={loading && !data ? "loading" : wf.length === 0 ? "empty" : "ready"}
        stateDetail="当前月份或拆分维度没有销量事实。"
        height={380}
        dataView={
          <Table<DetailRow>
            rowKey="key"
            size="small"
            columns={columns}
            dataSource={detail}
            pagination={false}
            scroll={{ y: 280 }}
            onRow={(row) => {
              const href = hrefOf(row);
              return {
                onClick: () => { if (href) router.push(href); },
                style: href ? { cursor: "pointer" } : undefined,
              };
            }}
          />
        }
      >
          <ResponsiveContainer>
            <BarChart data={wf} margin={{ top: 8, right: 16, left: 8, bottom: 72 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" interval={0} angle={-30} textAnchor="end" tick={{ fontSize: 11 }} height={72} />
              <YAxis tickFormatter={(v: number) => (Math.abs(v) >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} />
              <ReferenceLine y={0} stroke="#8c8c8c" />
              <Tooltip
                cursor={{ fill: "rgba(0,0,0,0.04)" }}
                formatter={(_v, _n, item) => {
                  const p = (item?.payload ?? {}) as WfRow;
                  return p.kind === "total" ? [qty(p.delta), "当月总量"] : [sq(p.delta), "较上期增减"];
                }}
              />
              <Bar dataKey="range" name="变化" isAnimationActive={false}>
                {wf.map((r, i) => (
                  <Cell
                    key={i}
                    fill={r.kind === "total" ? COLOR_TOTAL : r.kind === "other" ? COLOR_OTHER : r.kind === "up" ? COLOR_UP : COLOR_DOWN}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
      </DecisionVisual>

      <Space size={12} style={{ margin: "8px 0 12px" }}>
        <Tag color={COLOR_TOTAL}>期间总量</Tag>
        <Tag color={COLOR_UP}>增长项</Tag>
        <Tag color={COLOR_DOWN}>下降项</Tag>
        <Tag color={COLOR_OTHER}>其他（合并）</Tag>
      </Space>

    </div>
  );
}
