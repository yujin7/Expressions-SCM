"use client";

import SearchInput from "@/components/SearchInput";

/**
 * E7-04 库存分析三视图：健康散点 × 库存账龄 × 周转指标（只读）。
 *
 * 三个视角回答三个不同的问题：
 * - 散点：全部成品的健康分布长什么样（销速 × 可销天数 × 在库量 × ABC）；
 * - 账龄：这批货「已经压了多久」（效期健康 ≠ 资金没被压死）；
 * - 周转：一年转几次 / 压几天（管理层语言）。
 * 口径局限（平均在库用当前在库近似）在页面顶部与周转页签内均常驻提示，不做美化。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Col, Row as GridRow, Segmented, Space, Table, Tabs, Tag, Tooltip as AntTooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { fetchJson } from "@/components/fetchJson";
import CaliberNote from "@/components/CaliberNote";
import DecisionMetric from "@/components/DecisionMetric";
import DecisionVisual from "@/components/DecisionVisual";
import ProductExternalDecisionEvidenceCard from "@/components/ProductExternalDecisionEvidenceCard";
import { VISUAL_COLOR, positiveLogAxis } from "@/components/decision-visuals";
import { exportCsv } from "@/components/exportCsv";
import ListToolbar from "@/components/ListToolbar";
import { AsyncExportButton } from "@/components/ExportButton";
import { buildInventoryExternalEvidenceBriefs } from "@/components/inventory-external-evidence";
import type { ProductExternalDecisionEvidenceBrief } from "@/components/product-external-decision-evidence";
import { useListState } from "@/components/useListState";
import type { JiandaoyunSupportingObservation } from "@/server/modules/report/jiandaoyun-supporting-observation";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import type { InvAnalyticsRow as Row, InvAnalyticsResult } from "@/server/modules/report/inventory-analytics";
import { formatInventoryDaily, inventorySalesStatus, inventorySalesPeriod, inventorySalesExport, INVENTORY_SALES_EXPORT_COLUMNS } from "@/lib/inventory-sales-evidence";

type AgingBucket = "d30" | "d60" | "d90" | "d180" | "d180p";
const BUCKETS: AgingBucket[] = ["d30", "d60", "d90", "d180", "d180p"];
const BUCKET_LABELS: Record<AgingBucket, string> = {
  d30: "≤30天",
  d60: "31–60天",
  d90: "61–90天",
  d180: "91–180天",
  d180p: ">180天",
};
/** 越老越红——账龄图的唯一色序 */
const BUCKET_COLORS: Record<AgingBucket, string> = {
  d30: "#52c41a",
  d60: "#a0d911",
  d90: "#faad14",
  d180: "#fa8c16",
  d180p: "#cf1322",
};
const ABC_COLORS: Record<string, string> = { A: "#f5222d", B: "#fa8c16", C: "#8c8c8c" };

interface Data extends InvAnalyticsResult {
  supportingObservations: JiandaoyunSupportingObservation[];
  externalDecisionEvidence: ProductExternalDecisionEvidenceBrief | null;
}

const fmt = (v: number | null | undefined): string => (v == null ? "—" : Number(v).toLocaleString("zh-CN"));
/** 图表数据上限：散点/账龄图只画在库量 TOP N（超出在提示中明说，不静默截断） */
const CHART_LIMIT = 500;
/** 可销天数显示封顶；已登记非正日销在左上独立占位，不声称无穷。 */
const COVER_CAP = 720;

const displayExternalMetric = (value: string): string => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString("zh-CN", { maximumFractionDigits: 4 })
    : value;
};

function InventoryExternalEvidence({ observations }: { observations: readonly JiandaoyunSupportingObservation[] }) {
  const briefs = buildInventoryExternalEvidenceBriefs(observations);
  return (
    <Card
      size="small"
      title="简道云库存外部佐证（历史观察，不调账）"
      extra={<Button type="link" size="small" href="/import/exceptions?status=open&scope=JIANDAOYUN">处理仓库认领</Button>}
      style={{ marginBottom: 12 }}
    >
      <Alert
        banner
        showIcon
        type="warning"
        message="仓库、盘点和调拨旧表只用于解释流程与发现身份缺口；不得改写当前在库、自动调平或替代聚水潭/用友实时库存。"
        style={{ marginBottom: 10 }}
      />
      <GridRow gutter={[10, 10]}>
        {briefs.map((brief) => (
          <Col xs={24} xl={8} key={brief.stream}>
            <Card
              type="inner"
              size="small"
              title={brief.label}
              extra={<Tag color={brief.state === "available" ? "gold" : "default"}>{brief.state === "available" ? "历史辅助" : "缺失"}</Tag>}
            >
              {brief.state === "missing" ? (
                <Typography.Text type="secondary">尚无最新成功批次；保持未知，不显示为 0。</Typography.Text>
              ) : (
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Typography.Text type="secondary">
                    源截止 {brief.sourceAsOf ?? "未提供"} · 业务期 {brief.period}
                  </Typography.Text>
                  {brief.dateAnomaly ? <Tag color="orange" style={{ whiteSpace: "normal" }}>时间异常：{brief.dateAnomaly}</Tag> : null}
                  <Space size={[6, 6]} wrap>
                    {brief.metrics.map((metric) => (
                      <Tag key={metric.key}>{metric.label} {displayExternalMetric(metric.value)}{metric.unit}</Tag>
                    ))}
                  </Space>
                  {brief.warehouseIdentity ? (
                    <Typography.Text type={brief.warehouseIdentity.openValues > 0 ? "warning" : "secondary"}>
                      仓库身份已认领 {brief.warehouseIdentity.governedMatches}/{brief.warehouseIdentity.distinctValues}；
                      待认领 {brief.warehouseIdentity.openValues}
                    </Typography.Text>
                  ) : (
                    <Typography.Text type="secondary">该批次未提供可治理的仓库身份。</Typography.Text>
                  )}
                </Space>
              )}
            </Card>
          </Col>
        ))}
      </GridRow>
    </Card>
  );
}

interface Point {
  code: string;
  name: string;
  x: number;
  y: number;
  z: number;
  abc: string;
  cell: string | null;
  noSales: boolean;
  capped: boolean;
  daily: number;
  daysCover: number | null;
}

export default function InventoryAnalyticsClient() {
  const [data, setData] = useState<Data | null>(null);
  const [chart, setChart] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const tableRequestRef = useRef<AbortController | null>(null);
  const chartRequestRef = useRef<AbortController | null>(null);
  const listState = useListState({ key: "inventory-analytics", defaults: { q: "", windowDays: "90", view: "scatter" }, defaultPageSize: 50 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const windowDays = filters.windowDays || "90";
  const tab = filters.view || "scatter";

  /* 表格数据：随分页变化 */
  const load = useCallback(async () => {
    tableRequestRef.current?.abort();
    const controller = new AbortController();
    tableRequestRef.current = controller;
    setLoading(true);
    setLoadError(null);
    setData(null);
    try {
      const params = new URLSearchParams({ q, windowDays, page: String(page), pageSize: String(pageSize) });
      const next = await fetchJson<Data>(`/api/report/inventory-analytics?${params.toString()}`, { signal: controller.signal });
      if (!controller.signal.aborted) setData(next);
    } catch (e) {
      if (!controller.signal.aborted) setLoadError((e as Error).message);
    } finally {
      if (tableRequestRef.current === controller) {
        tableRequestRef.current = null;
        setLoading(false);
      }
    }
  }, [q, windowDays, page, pageSize]);
  useEffect(() => { void load(); }, [load]);

  /* 图表数据：只随筛选变化（分页翻页不重算，省一次全表计算） */
  const loadChart = useCallback(async () => {
    chartRequestRef.current?.abort();
    const controller = new AbortController();
    chartRequestRef.current = controller;
    setChartError(null);
    setChart(null);
    try {
      const params = new URLSearchParams({ q, windowDays, page: "1", pageSize: String(CHART_LIMIT), includeExternalEvidence: "0" });
      const next = await fetchJson<Data>(`/api/report/inventory-analytics?${params.toString()}`, { signal: controller.signal });
      if (!controller.signal.aborted) setChart(next);
    } catch (e) {
      if (!controller.signal.aborted) setChartError((e as Error).message);
    } finally {
      if (chartRequestRef.current === controller) chartRequestRef.current = null;
    }
  }, [q, windowDays]);
  useEffect(() => { void loadChart(); }, [loadChart]);
  useEffect(() => () => {
    tableRequestRef.current?.abort();
    chartRequestRef.current?.abort();
  }, []);

  const chartRows = useMemo(() => chart?.rows ?? [], [chart]);
  const stockedRows = useMemo(() => chartRows.filter((r) => r.onHand > 0), [chartRows]);
  const qualifiedRows = useMemo(() => stockedRows.filter((r): r is Row & { daily: number } => r.daily != null), [stockedRows]);
  const unknownSalesCount = stockedRows.length - qualifiedRows.length;
  const truncated = (chart?.total ?? 0) > CHART_LIMIT;
  const dailyAxis = useMemo(
    () => positiveLogAxis(qualifiedRows.map((r) => r.daily)),
    [qualifiedRows],
  );

  /* ── 散点数据 ── */
  const points = useMemo<Point[]>(
    () =>
      qualifiedRows
        .map((r) => ({
          code: r.code,
          name: r.name,
          x: r.daily > 0 ? r.daily : dailyAxis.placeholder,
          y: r.daysCover == null ? COVER_CAP : Math.min(r.daysCover, COVER_CAP),
          z: r.onHand,
          abc: r.abc ?? "C",
          cell: r.cell,
          noSales: !(r.daily > 0),
          capped: r.daysCover == null || r.daysCover > COVER_CAP,
          daily: r.daily,
          daysCover: r.daysCover,
        })),
    [qualifiedRows, dailyAxis],
  );

  const onPointClick = (d: unknown) => {
    const p = d as { payload?: { code?: string }; code?: string } | null;
    const code = p?.payload?.code ?? p?.code;
    if (code) window.location.href = `/report/sku-360?sku=${encodeURIComponent(code)}`;
  };

  /* ── 账龄堆叠柱（在库 TOP 15） ── */
  const agingBarData = useMemo(
    () =>
      chartRows
        .filter((r) => r.onHand > 0)
        .slice(0, 15)
        .map((r) => ({
          code: r.code,
          d30: r.aging.d30,
          d60: r.aging.d60,
          d90: r.aging.d90,
          d180: r.aging.d180,
          d180p: r.aging.d180p,
        })),
    [chartRows],
  );

  const doExport = async () => {
    const all: Row[] = [];
    const salesEvidence: ReturnType<typeof inventorySalesExport>[] = [];
    let serverTotal = 0;
    for (let p2 = 1; p2 <= 20; p2++) {
      const params = new URLSearchParams({ q, windowDays, page: String(p2), pageSize: String(CHART_LIMIT) });
      const d = await fetchJson<Data>(`/api/report/inventory-analytics?${params.toString()}`);
      serverTotal = d.total;
      all.push(...d.rows);
      salesEvidence.push(...d.rows.map((r) => inventorySalesExport(r, d.salesWindow)));
      if (all.length >= d.total) break;
    }
    exportCsv(
      `库存分析-${data?.today ?? ""}`,
      ["SKU编码", "名称", "品牌", "ABC", "格", "在库", "日均销", "可销天数", `窗口出库(${windowDays}天)`, "周转次数(年化)", "DIO(天)", "加权库龄(天)", ...BUCKETS.map((b) => BUCKET_LABELS[b]), "来源不明", ...INVENTORY_SALES_EXPORT_COLUMNS.map((c) => c.title)],
      all.map((r, i) => [
        r.code, r.name, r.brand, r.abc, r.cell, r.onHand, r.daily, r.daysCover, r.outQty, r.turns, r.dio, r.avgAgeDays,
        ...BUCKETS.map((b) => r.aging[b]), r.unknownOriginQty,
        ...INVENTORY_SALES_EXPORT_COLUMNS.map((c) => salesEvidence[i][c.key]),
      ]),
      all.length < serverTotal
        ? `……仅导出前 ${all.length} 行，服务端共 ${serverTotal} 行（浏览器分页取数已达上限）；请缩小筛选范围，或改用「导出任务」`
        : undefined,
    );
  };

  const skuCol: ColumnsType<Row>[number] = {
    title: "SKU 编码",
    dataIndex: "code",
    width: 150,
    fixed: "left",
    render: (v: string, r) => (
      <Space size={6}>
        <a href={`/report/sku-360?sku=${encodeURIComponent(v)}`}>{v}</a>
        {r.abc ? <Tag color={r.abc === "A" ? "red" : r.abc === "B" ? "orange" : "default"} style={{ marginInlineEnd: 0 }}>{r.cell ?? r.abc}</Tag> : null}
      </Space>
    ),
  };
  const nameCol: ColumnsType<Row>[number] = { title: "名称", dataIndex: "name", ellipsis: true, width: 200 };
  const onHandCol: ColumnsType<Row>[number] = { title: "在库", dataIndex: "onHand", width: 100, align: "right", render: (v: number) => fmt(v) };
  const dailyCol: ColumnsType<Row>[number] = { title: "日均销", dataIndex: "daily", width: 145, align: "right",
    render: (v: number | null, r) => <div>
      <div>{formatInventoryDaily(v)}</div>
      <Typography.Text type={r.salesState === "registered" ? "secondary" : "warning"} style={{ fontSize: 12 }}>
        {inventorySalesStatus(r)}
      </Typography.Text>
    </div>,
  };
  const coverCol: ColumnsType<Row>[number] = { title: "可销天数", dataIndex: "daysCover", width: 140, align: "right",
    render: (v: number | null, r) => v != null ? fmt(v)
      : <Typography.Text type="secondary">{r.daily == null ? "缺销售证据" : "无正日销，不计算"}</Typography.Text>,
  };

  const agingColumns: ColumnsType<Row> = [
    skuCol,
    nameCol,
    onHandCol,
    {
      title: "加权库龄",
      dataIndex: "avgAgeDays",
      width: 105,
      align: "right",
      sorter: (a, b) => (a.avgAgeDays ?? -1) - (b.avgAgeDays ?? -1),
      render: (v: number | null) =>
        v == null ? <Typography.Text type="secondary">—</Typography.Text> : v > 180 ? <Typography.Text type="danger" strong>{v} 天</Typography.Text> : v > 90 ? <Typography.Text type="warning">{v} 天</Typography.Text> : `${v} 天`,
    },
    ...BUCKETS.map<ColumnsType<Row>[number]>((b) => ({
      title: BUCKET_LABELS[b],
      key: b,
      width: 95,
      align: "right",
      render: (_: unknown, r: Row) => (r.aging[b] > 0 ? fmt(r.aging[b]) : <Typography.Text type="secondary">—</Typography.Text>),
    })),
    {
      title: "来源不明",
      dataIndex: "unknownOriginQty",
      width: 100,
      align: "right",
      render: (v: number) =>
        v > 0 ? (
          <AntTooltip title="在库量超过历史入库流水合计（期初直接建账 / 快照仓无流水）。该部分无入库日期，已按最坏假设计入 >180 天桶，且不参与加权库龄。">
            <Typography.Text type="warning">{fmt(v)}</Typography.Text>
          </AntTooltip>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];

  const turnoverColumns: ColumnsType<Row> = [
    skuCol,
    nameCol,
    onHandCol,
    { title: `窗口出库（${windowDays}天）`, dataIndex: "outQty", width: 130, align: "right", sorter: (a, b) => a.outQty - b.outQty, render: (v: number) => fmt(v) },
    {
      title: "周转次数（年化）",
      dataIndex: "turns",
      width: 135,
      align: "right",
      sorter: (a, b) => (a.turns ?? -1) - (b.turns ?? -1),
      render: (v: number | null) =>
        v == null ? <Typography.Text type="secondary">无法计算</Typography.Text> : v <= 0 ? <Typography.Text type="danger">0（窗口零出库）</Typography.Text> : v < 2 ? <Typography.Text type="warning">{v}</Typography.Text> : <Typography.Text>{v}</Typography.Text>,
    },
    {
      title: "DIO（天）",
      dataIndex: "dio",
      width: 110,
      align: "right",
      sorter: (a, b) => (a.dio ?? -1) - (b.dio ?? -1),
      render: (v: number | null) => (v == null ? <Typography.Text type="secondary">—</Typography.Text> : v > 180 ? <Typography.Text type="danger">{fmt(v)}</Typography.Text> : fmt(v)),
    },
    dailyCol,
    coverCol,
  ];

  const pagination = {
    current: page,
    pageSize,
    total: data?.total ?? 0,
    showSizeChanger: true,
    showTotal: (t: number) => `共 ${t} 条`,
    onChange: (p: number, ps: number) => listState.setPage(p, ps),
  };

  const summary = data?.summary;

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>库存分析</Typography.Title>
      <CaliberNote
        summary={`口径日 ${data?.today ?? "—"}${data ? `；快照仓数据时点 ${data.snapDate ?? "无快照仓数据"}` : ""}；先用健康矩阵找异常，再用账龄和周转验证原因。`}
        detail={
          <>
            在库 = 实时账 + 快照仓最新快照（core/stock-view 唯一口径）；
            {data?.snapDate
              ? `快照部分的数据时点是 ${data.snapDate}，不是口径日 ${data.today}——两者相差几天时，本页在库偏保守/偏陈旧，请对照「数据日期」判断新鲜度。`
              : data
                ? "本次结果不含任何快照仓数据（快照仓无该口径记录），在库全部来自实时账。"
                : ""}
            日均销取正式月销最新月份向前3月，沿用历史÷91；三月均有记录才计算，不证明全渠道完整。缺月/无记录不补零，可销天数保持未知。
            出入库取自 stock_ledger 带符号流水。仅统计在用成品。
            {truncated ? ` 图表仅绘制在库量 TOP ${CHART_LIMIT}（共 ${chart?.total ?? 0} 个 SKU），明细表分页完整。` : ""}
          </>
        }
      />

      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="库存分析明细" retrying={loading} />
      <LoadErrorAlert error={chartError} onRetry={() => void loadChart()} subject="库存分析图表" />
      {data ? <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        正式月销窗口：{inventorySalesPeriod(data.salesWindow)} · 日均分母 {data.salesWindow.divisorDays} 天（历史口径，非自然月实际天数）。已登记月份不代表全渠道覆盖；历史窗口不代表今天的需求。
      </Typography.Paragraph> : null}

      <section className="dashboard-kpi-grid" aria-label="库存分析关键指标" style={{ marginBottom: 12 }}>
        <div className="dashboard-kpi-grid__item">
          <DecisionMetric
            metricId="finishedSkuCount"
            value={summary ? summary.skuCount : "—"}
            source={{ tier: "ledger", name: "SKU 主数据" }}
            asOf={data?.today}
          />
        </div>
        <div className="dashboard-kpi-grid__item">
          <DecisionMetric
            metricId="turns"
            value={summary?.avgTurns ?? "—"}
            source={{ tier: "derived", name: `库存流水与当前在库（${windowDays} 天窗口）` }}
            asOf={data?.today}
          />
        </div>
        <div className="dashboard-kpi-grid__item">
          <DecisionMetric
            metricId="dio"
            value={summary?.avgDio ?? "—"}
            source={{ tier: "derived", name: `库存流水与当前在库（${windowDays} 天窗口）` }}
            asOf={data?.today}
          />
        </div>
        <div className="dashboard-kpi-grid__item">
          <DecisionMetric
            metricId="unknownOriginQty"
            value={summary ? summary.unknownOriginQty : "—"}
            status={summary ? (summary.unknownOriginQty > 0 ? "warning" : "positive") : "neutral"}
            source={{ tier: "derived", name: "当前在库 − 可追溯历史入库" }}
            asOf={data?.today}
            actionHref="/inventory/ledger"
            actionLabel="核对库存流水"
          />
        </div>
      </section>

      <InventoryExternalEvidence observations={data?.supportingObservations ?? []} />
      <ProductExternalDecisionEvidenceCard evidence={data?.externalDecisionEvidence} />

      <ListToolbar
        state={listState}
        onExport={() => void doExport()}
        primaryActions={
          /* W2-4：页脚一直在推销的「导出任务」现在真的有入口（EXPORT_KINDS["inventory-analytics"]） */
          <AsyncExportButton kind="inventory-analytics" params={{ q, windowDays }} />
        }
        extra={
          <>
            <Space size={4}>
              <Typography.Text type="secondary">周转窗口</Typography.Text>
              <Segmented
                size="small"
                value={windowDays}
                options={[
                  { label: "30天", value: "30" },
                  { label: "60天", value: "60" },
                  { label: "90天", value: "90" },
                  { label: "180天", value: "180" },
                  { label: "365天", value: "365" },
                ]}
                onChange={(v) => listState.setFilter({ windowDays: String(v) })}
              />
            </Space>
            <SearchInput
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索编码/名称"
              style={{ width: 240 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
          </>
        }
      />

      <Tabs
        activeKey={tab}
        onChange={(view) => listState.setFilter({ view })}
        items={[
          {
            key: "scatter",
            label: "健康散点",
            children: (
              <DecisionVisual
                title="库存健康矩阵（横轴=日均销·对数，纵轴=可销天数，气泡=在库量，颜色=ABC）"
                question="哪些 SKU 同时处于低销速、高库存或短覆盖的异常象限？"
                metricId="daysCover"
                grain="SKU"
                unit="日均销 × 可销天数 × 在库量"
                source={{
                  tier: "derived",
                  source: `库存过账台账 + 最新快照 + 正式月销 ${inventorySalesPeriod(chart?.salesWindow)}`,
                  asOf: chart?.today,
                }}
                coverage={{
                  covered: points.length,
                  total: chart?.total,
                  label: truncated ? `图形 TOP ${CHART_LIMIT}` : "有在库成品",
                }}
                activeFilters={[`周转窗口 ${windowDays} 天`, q ? `搜索：${q}` : "全部 SKU"]}
                caveat={`当前已加载在库样本中，${unknownSalesCount} 个因无月销/缺月未绘点，仍保留在数据表与导出。已登记非正日销在最左上独立占位，不代表可销无穷或实际无销售。正日销按真实值绘制；可销天数超过 ${COVER_CAP} 天封顶。月销${inventorySalesPeriod(chart?.salesWindow)}，历史÷${chart?.salesWindow.divisorDays ?? "—"}；不代表全渠道完整或当前需求。`}
                summary={`图中 ${points.length} 个 SKU；橙色虚线为 ${data?.coverAlertDays ?? 30} 天缺货告警线，黄色虚线为 ${data?.slowDaysThreshold ?? 180} 天滞销线。气泡越大表示在库越多。`}
                state={chartError ? "error" : chart == null ? "loading" : points.length === 0 ? stockedRows.length ? "insufficient" : "empty" : "ready"}
                stateDetail={chartError ?? (stockedRows.length ? "有在库成品，但缺少合格的三个月销售记录；可切换数据表核对，不按零销量绘图。" : "当前筛选范围内没有在库成品。")}
                extra={<Space size={4}>{(["A", "B", "C"] as const).map((a) => <Tag key={a} color={a === "A" ? "red" : a === "B" ? "orange" : "default"}>{a} 类</Tag>)}</Space>}
                height={460}
                dataView={
                  <Table<Row>
                    rowKey="code"
                    size="small"
                    columns={[
                      { title: "SKU", dataIndex: "code" },
                      { title: "名称", dataIndex: "name", ellipsis: true },
                      { title: "ABC", dataIndex: "abc" },
                      dailyCol,
                      { title: "窗口已登记销量", dataIndex: "salesQty", align: "right", render: (v: string | null) => v ?? "—" },
                      coverCol,
                      onHandCol,
                    ]}
                    dataSource={stockedRows}
                    pagination={{ pageSize: 20, showSizeChanger: false }}
                    scroll={{ x: "max-content", y: 330 }}
                  />
                }
              >
                <ResponsiveContainer>
                    <ScatterChart margin={{ top: 16, right: 24, bottom: 28, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        type="number"
                        dataKey="x"
                        name="日均销"
                        scale="log"
                        domain={dailyAxis.domain}
                        ticks={dailyAxis.ticks}
                        niceTicks="none"
                        interval="preserveStartEnd"
                        minTickGap={16}
                        tick={{ fontSize: 11 }}
                        padding={{ left: 16, right: 16 }}
                        allowDataOverflow
                        tickFormatter={dailyAxis.formatTick}
                        label={{ value: "日均销（对数轴）", position: "insideBottom", offset: -16, fontSize: 12 }}
                      />
                      <YAxis
                        type="number"
                        dataKey="y"
                        name="可销天数"
                        domain={[0, COVER_CAP]}
                        tickFormatter={(v: number) => (v >= COVER_CAP ? `${COVER_CAP}+` : String(v))}
                        label={{ value: "可销天数", angle: -90, position: "insideLeft", fontSize: 12 }}
                      />
                      <ZAxis type="number" dataKey="z" range={[24, 520]} name="在库" />
                      <Tooltip
                        cursor={{ strokeDasharray: "3 3" }}
                        formatter={(v, n, item) => {
                          // 横轴对无动销 SKU 用占位值作图，tooltip 必须回到真实值，不能骗人
                          const p = (item as unknown as { payload?: Point } | undefined)?.payload;
                          if (n === "日均销") return [formatInventoryDaily(p?.daily ?? (v as number)), "日均销"];
                          if (n === "可销天数") {
                            return [p?.daysCover == null ? "无正日销，不计算（图上占位）" : fmt(p.daysCover), "可销天数"];
                          }
                          return [fmt(v as number), String(n)];
                        }}
                        labelFormatter={(_label, payload) => {
                          const p = (payload as unknown as { payload?: Point }[] | undefined)?.[0]?.payload;
                          return p ? `${p.code} ${p.name}${p.cell ? `（${p.cell}）` : ""}` : "";
                        }}
                      />
                      <ReferenceLine
                        y={data?.coverAlertDays ?? 30}
                        stroke={VISUAL_COLOR.critical}
                        strokeDasharray="4 4"
                        label={{ value: `缺货告警线 ${data?.coverAlertDays ?? 30} 天`, position: "insideTopRight", fontSize: 11, fill: VISUAL_COLOR.critical }}
                      />
                      <ReferenceLine
                        y={data?.slowDaysThreshold ?? 180}
                        stroke={VISUAL_COLOR.warning}
                        strokeDasharray="4 4"
                        label={{ value: `滞销线 ${data?.slowDaysThreshold ?? 180} 天`, position: "insideTopRight", fontSize: 11, fill: VISUAL_COLOR.warning }}
                      />
                      <Legend verticalAlign="top" height={24} />
                      <Scatter name="成品 SKU（点击进 SKU 360）" data={points} onClick={onPointClick} cursor="pointer">
                        {points.map((p, i) => (
                          <Cell key={i} fill={ABC_COLORS[p.abc] ?? "#8c8c8c"} fillOpacity={p.noSales ? 0.45 : 0.7} />
                        ))}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
              </DecisionVisual>
            ),
          },
          {
            key: "aging",
            label: "库存账龄",
            children: (
              <>
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="账龄 = FIFO 假设回溯：先进先出下账面剩下的必然是最后进来的批次，故按入库时间倒序消耗当前在库，逐笔落桶。"
                  description={
                    <Typography.Text type="secondary">
                      效期说「还能卖多久」，账龄说「已经压了多久」——压半年的健康效期库存同样是资金坟场。
                      {(summary?.unknownOriginQty ?? 0) > 0
                        ? ` 其中「来源不明」${fmt(summary?.unknownOriginQty)}（在库超过历史入库流水合计，多为期初直接建账/快照仓无流水）已计入 >180 天桶，且不参与加权库龄计算。`
                        : ""}
                    </Typography.Text>
                  }
                />
                <Space wrap size={8} style={{ marginBottom: 12 }}>
                  {BUCKETS.map((b) => (
                    <Tag key={b} color={BUCKET_COLORS[b]}>{BUCKET_LABELS[b]}：{summary ? fmt(summary.agingTotals[b]) : "—"}</Tag>
                  ))}
                </Space>
                <div style={{ marginBottom: 12 }}>
                  <DecisionVisual
                    title={`账龄结构（在库量 TOP ${agingBarData.length} SKU）`}
                    question="哪些高库存 SKU 的货已经压得最久？"
                    metricId="unknownOriginQty"
                    grain="SKU × 账龄桶"
                    unit="基础单位数量"
                    source={{
                      tier: "derived",
                      source: "库存台账按 FIFO 假设回溯",
                      asOf: data?.today,
                    }}
                    coverage={{
                      covered: agingBarData.length,
                      total: chartRows.filter((row) => row.onHand > 0).length,
                      label: "图形 TOP SKU",
                    }}
                    caveat="来源不明库存按最坏假设计入 >180 天桶，但不参与加权库龄；图形是聚焦视图，分页明细完整。"
                    summary={`展示在库量最高的 ${agingBarData.length} 个 SKU；颜色从绿到红依次表示由新到老的五个账龄区间。`}
                    state={chartError ? "error" : chart == null ? "loading" : agingBarData.length === 0 ? "empty" : "ready"}
                    stateDetail={chartError ?? "当前筛选范围内没有在库成品。"}
                    height={340}
                    dataView={
                      <Table
                        rowKey="code"
                        size="small"
                        dataSource={agingBarData}
                        columns={[
                          { title: "SKU", dataIndex: "code" },
                          ...BUCKETS.map((bucket) => ({
                            title: BUCKET_LABELS[bucket],
                            dataIndex: bucket,
                            align: "right" as const,
                            render: fmt,
                          })),
                        ]}
                        pagination={false}
                        scroll={{ x: "max-content", y: 250 }}
                      />
                    }
                  >
                    <ResponsiveContainer>
                      <BarChart data={agingBarData} margin={{ top: 8, right: 16, bottom: 48, left: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="code" interval={0} angle={-30} textAnchor="end" tick={{ fontSize: 11 }} />
                        <YAxis tickFormatter={(v: number) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} />
                        <Tooltip formatter={(v, n) => [fmt(v as number), String(n)]} />
                        <Legend verticalAlign="top" height={24} />
                        {BUCKETS.map((b) => (
                          <Bar key={b} dataKey={b} stackId="age" name={BUCKET_LABELS[b]} fill={BUCKET_COLORS[b]} />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  </DecisionVisual>
                </div>
                <Table<Row>
                  rowKey="skuId"
                  size={listState.tableSize}
                  columns={agingColumns}
                  dataSource={data?.rows ?? []}
                  loading={loading}
                  locale={{ emptyText: loadError ? "数据未加载" : "当前条件下无在库成品" }}
                  scroll={{ x: "max-content" }}
                  pagination={pagination}
                />
              </>
            ),
          },
          {
            key: "turnover",
            label: "周转指标",
            children: (
              <>
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="⚠ 口径局限：周转指标的「平均库存」用当前在库近似"
                  description={
                    <Typography.Text type="secondary">
                      {data?.avgOnHandNote ??
                        "系统无历史每日库存快照，无法还原窗口内日均库存；补货前后水位波动大的 SKU 会失真，仅供横向排序与量级判断，不可用于财务对账。"}
                      {" "}计算式：周转次数 = 窗口出库量 ÷ 平均在库 × (365 ÷ {windowDays})；DIO = 365 ÷ 周转次数。
                      顶部「平均周转次数」为各 SKU 周转次数的算术平均（不做跨 SKU 数量直加，避免量纲混装），平均 DIO 由其反算。
                    </Typography.Text>
                  }
                />
                <Table<Row>
                  rowKey="skuId"
                  size={listState.tableSize}
                  columns={turnoverColumns}
                  dataSource={data?.rows ?? []}
                  loading={loading}
                  locale={{ emptyText: loadError ? "数据未加载" : "当前条件下无库存周转数据" }}
                  scroll={{ x: "max-content" }}
                  pagination={pagination}
                />
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
