"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Radio,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CopyOutlined } from "@ant-design/icons";

import DecisionReadinessPanel from "@/components/DecisionReadinessPanel";
import DecisionVisual from "@/components/DecisionVisual";
import { VISUAL_COLOR } from "@/components/decision-visuals";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import { useListState } from "@/components/useListState";
import RemoteSelect from "@/components/RemoteSelect";
import type {
  DecisionStudioResult,
  StudioDimension,
} from "@/server/modules/report/decision-studio";

const DIMENSION_LABEL: Record<StudioDimension, string> = {
  brand: "品牌",
  channel: "渠道",
  sku: "SKU",
  month: "月份",
};

function pctLabel(value: number | null): string {
  if (value == null) return "数据不足";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function shortQty(value: number): string {
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return formatQty(value);
}

function heatColor(value: number, max: number): string {
  if (value <= 0 || max <= 0) return "#f1f5f9";
  const ratio = Math.min(1, value / max);
  if (ratio > 0.75) return "#1d4ed8";
  if (ratio > 0.5) return "#3b82f6";
  if (ratio > 0.25) return "#93c5fd";
  return "#dbeafe";
}

export default function DecisionStudioClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<DecisionStudioResult | null>(null);
  const [loading, setLoading] = useState(true);
  const view = useListState({
    key: "decision-studio",
    defaults: { dimension: "brand", key: "", tab: "focus", brand: "", channel: "" },
    paginated: false,
  });
  const dimension = (["brand", "channel", "sku", "month"].includes(view.filters.dimension)
    ? view.filters.dimension
    : "brand") as StudioDimension;
  const selectedKey = view.filters.key;
  // 跨维筛选：与分组维度正交，可同时收窄品牌与渠道（0727 会议的「NING × 天猫」）
  const scopeBrand = view.filters.brand;
  const scopeChannel = view.filters.channel;
  const activeTab = view.filters.tab || "focus";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ dimension });
      if (selectedKey) query.set("key", selectedKey);
      if (scopeBrand) query.set("brand", scopeBrand);
      if (scopeChannel) query.set("channel", scopeChannel);
      setData(await fetchJson<DecisionStudioResult>(
        `/api/report/decision-studio?${query.toString()}`,
      ));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [dimension, selectedKey, scopeBrand, scopeChannel, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const groupOptions = useMemo(
    () => (data?.groups ?? []).map((item) => ({
      value: item.key,
      label: `${item.label} · ${shortQty(item.total)}`,
    })),
    [data],
  );
  const scope = data?.selectedLabel ?? "全部";
  const filters = [
    `维度：${DIMENSION_LABEL[dimension]}`,
    `范围：${scope}`,
    ...(scopeBrand ? [`品牌：${scopeBrand}`] : []),
    ...(scopeChannel ? [`渠道：${scopeChannel}`] : []),
  ];
  const paretoRows = (data?.pareto ?? []).slice(0, 30);
  const heatMax = Math.max(0, ...(data?.daily.dates ?? []).map((item) => item.qty));
  const external = data?.externalDemand;
  const externalReady = external?.state === "ready";

  const pivotColumns = useMemo<ColumnsType<DecisionStudioResult["pivot"][number]>>(
    () => [
      {
        title: DIMENSION_LABEL[dimension],
        dataIndex: "label",
        key: "label",
        fixed: "left",
        width: 220,
        render: (value: string, row) => (
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            onClick={() => view.setFilter({ key: row.key, tab: "focus" })}
          >
            {value}
          </Button>
        ),
      },
      ...(data?.months ?? []).map((month) => ({
        title: month,
        key: month,
        width: 120,
        align: "right" as const,
        render: (_: unknown, row: DecisionStudioResult["pivot"][number]) =>
          formatQty(row.byMonth[month] ?? 0),
      })),
      {
        title: "合计",
        dataIndex: "total",
        key: "total",
        width: 130,
        fixed: "right",
        align: "right",
        render: (value: number) => <Typography.Text strong>{formatQty(value)}</Typography.Text>,
      },
    ],
    [data?.months, dimension, view],
  );

  const copyReview = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.review.markdown);
      message.success("月度经营回顾已复制");
    } catch {
      message.warning("浏览器未允许复制，请使用地址栏分享当前分析。");
    }
  };

  return (
    <div>
      <Space
        align="start"
        style={{ width: "100%", justifyContent: "space-between", marginBottom: 12 }}
        wrap
      >
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>决策工作室</Typography.Title>
          <Typography.Text type="secondary">
            用一套筛选联动结构、趋势、透视、日级节奏和月度回顾；缺数据的能力保持留白。
          </Typography.Text>
        </div>
        <Space wrap>
          <Radio.Group
            optionType="button"
            buttonStyle="solid"
            value={dimension}
            options={[
              { label: "品牌", value: "brand" },
              { label: "渠道", value: "channel" },
              { label: "SKU", value: "sku" },
              { label: "月份", value: "month" },
            ]}
            onChange={(event) => view.setFilter({
              dimension: event.target.value as StudioDimension,
              key: "",
            })}
          />
          {/*
            跨维筛选：与上面的分组维度**正交**。旧实现只有一个 dimension + 一个 key，
            品牌与渠道互斥单选，做不到「NING × 天猫」——0727 会议要的正是这种组合。
            这里走主数据接口取候选，选中后进 SQL（EXISTS），不是前端裁剪。
          */}
          <RemoteSelect
            api="/api/master/brand"
            getLabel={(r) => String(r.nameCn ?? r.code)}
            getValue={(r) => String(r.code)}
            allowClear
            placeholder="全部品牌"
            style={{ width: 160 }}
            value={scopeBrand || undefined}
            onChange={(v) => view.setFilter({ brand: v == null ? "" : String(v), key: "" })}
          />
          <RemoteSelect
            api="/api/master/channel"
            getLabel={(r) => String(r.name ?? r.code)}
            getValue={(r) => String(r.code)}
            allowClear
            placeholder="全部渠道"
            style={{ width: 160 }}
            value={scopeChannel || undefined}
            onChange={(v) => view.setFilter({ channel: v == null ? "" : String(v), key: "" })}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ minWidth: 260 }}
            placeholder={`筛选${DIMENSION_LABEL[dimension]}（全部）`}
            value={selectedKey || undefined}
            options={groupOptions}
            onChange={(key) => view.setFilter({ key: key ?? "" })}
          />
        </Space>
      </Space>

      <Alert
        showIcon
        type="info"
        style={{ marginBottom: 12 }}
        message="联动筛选已进入 URL：刷新、分享、前进后退都保留现场。点击帕累托柱或透视表成员可继续下钻。"
        description={data?.limitations[0]}
      />

      <Row gutter={[10, 10]} className="compact-kpi-row">
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title={`${data?.latestMonth ?? "最新月"}销量`}
              value={data?.comparison.current ?? 0}
              formatter={(value) => formatQty(Number(value))}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="环比"
              value={pctLabel(data?.comparison.momPct ?? null)}
              valueStyle={{
                color: (data?.comparison.momPct ?? 0) < 0
                  ? VISUAL_COLOR.critical
                  : VISUAL_COLOR.positive,
              }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="同比" value={pctLabel(data?.comparison.yoyPct ?? null)} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title={`贡献 80% 的${DIMENSION_LABEL[dimension]}数`}
              value={data?.pareto80Count ?? 0}
              suffix={`/ ${data?.pareto.length ?? 0}`}
            />
          </Card>
        </Col>
      </Row>

      <Tabs
        destroyOnHidden
        activeKey={activeTab}
        onChange={(tab) => view.setFilter({ tab })}
        items={[
          {
            key: "focus",
            label: "结构与基准",
            children: (
              <DecisionVisual
                title={`${DIMENSION_LABEL[dimension]}销量帕累托（TOP 30）`}
                question={`哪些${DIMENSION_LABEL[dimension]}贡献了约 80% 的最新月销量，谁显著高于同组中位数？`}
                metricId="salesQty"
                grain={`${data?.latestMonth ?? "最新月"} × ${DIMENSION_LABEL[dimension]}`}
                unit="基础单位数量 / 累计占比"
                source={{
                  tier: "snapshot",
                  source: "sales_monthly 销售月事实",
                  asOf: data?.latestMonth,
                }}
                coverage={{
                  covered: paretoRows.length,
                  total: data?.pareto.length ?? 0,
                  label: "图中成员",
                }}
                activeFilters={filters}
                summary={
                  data?.pareto[0]
                    ? `${data.pareto80Count} 个成员贡献约 80%；第一位 ${data.pareto[0].label} 占 ${data.pareto[0].sharePct.toFixed(1)}%。`
                    : "当前范围没有可排名的销量事实。"
                }
                caveat="柱形为销量，折线为累计占比；基准线是当前成员销量中位数，不是经营目标。图中仅画 TOP 30，数据表保留当前透视 TOP 20。"
                state={loading && !data ? "loading" : paretoRows.length ? "ready" : "empty"}
                height={430}
                dataView={
                  <Table
                    rowKey="key"
                    size="small"
                    pagination={false}
                    dataSource={data?.pareto ?? []}
                    columns={[
                      { title: DIMENSION_LABEL[dimension], dataIndex: "label" },
                      { title: "销量", dataIndex: "qty", align: "right", render: formatQty },
                      { title: "份额", dataIndex: "sharePct", align: "right", render: (v: number) => `${v.toFixed(1)}%` },
                      { title: "累计", dataIndex: "cumulativePct", align: "right", render: (v: number) => `${v.toFixed(1)}%` },
                    ]}
                  />
                }
              >
                <ResponsiveContainer minWidth={0} minHeight={1}>
                  <ComposedChart data={paretoRows} margin={{ top: 8, right: 22, left: 8, bottom: 86 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="label"
                      interval={0}
                      angle={-38}
                      textAnchor="end"
                      height={96}
                      tick={{ fontSize: 11 }}
                    />
                    <YAxis yAxisId="qty" tickFormatter={shortQty} />
                    <YAxis yAxisId="pct" orientation="right" domain={[0, 100]} unit="%" />
                    <RechartsTooltip
                      formatter={(value, name) => [
                        name === "累计占比" ? `${Number(value).toFixed(1)}%` : formatQty(Number(value)),
                        name,
                      ]}
                    />
                    {data?.medianQty != null ? (
                      <ReferenceLine
                        yAxisId="qty"
                        y={data.medianQty}
                        stroke={VISUAL_COLOR.warning}
                        strokeDasharray="5 4"
                        label="中位数"
                      />
                    ) : null}
                    <ReferenceLine
                      yAxisId="pct"
                      y={80}
                      stroke={VISUAL_COLOR.critical}
                      strokeDasharray="5 4"
                      label="80%"
                    />
                    <Bar
                      yAxisId="qty"
                      dataKey="qty"
                      name="销量"
                      fill={VISUAL_COLOR.primary}
                      onClick={(row) => {
                        const key = (row as unknown as { key?: string }).key;
                        if (key) view.setFilter({ key });
                      }}
                    >
                      {paretoRows.map((row) => (
                        <Cell
                          key={row.key}
                          fill={row.key === data?.selectedKey
                            ? VISUAL_COLOR.positive
                            : VISUAL_COLOR.primary}
                        />
                      ))}
                    </Bar>
                    <Line
                      yAxisId="pct"
                      type="monotone"
                      dataKey="cumulativePct"
                      name="累计占比"
                      stroke={VISUAL_COLOR.critical}
                      strokeWidth={2}
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </DecisionVisual>
            ),
          },
          {
            key: "trend",
            label: "趋势与异常",
            children: (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                {data?.comparison.yoyGate ? (
                  <Alert showIcon type="warning" message="同比暂未解锁" description={data.comparison.yoyGate} />
                ) : null}
                {data && !data.spc.bands ? (
                  <Alert showIcon type="warning" message="统计控制带暂未解锁" description={data.spc.note} />
                ) : null}
                <DecisionVisual
                  title="月销量趋势、环比与统计控制带"
                  question="销量变化是普通波动、连续偏移，还是值得介入的统计异常？"
                  metricId="salesQty"
                  grain={`月 × ${scope}`}
                  unit="基础单位数量"
                  source={{
                    tier: "snapshot",
                    source: "sales_monthly 销售月事实",
                    asOf: data?.latestMonth,
                  }}
                  coverage={{
                    covered: data?.months.length ?? 0,
                    total: Math.max(12, data?.months.length ?? 0),
                    label: "可用月份（统计门槛 12）",
                  }}
                  activeFilters={filters}
                  summary={data
                    ? `${data.review.bullets[0]} ${data.review.bullets[3]}`
                    : "正在读取月销量趋势。"}
                  caveat="环比只比较相邻可用月份；同比必须有真实去年同期。控制带使用中位数/MAD，至少 12 个一致月份才显示。"
                  state={loading && !data ? "loading" : data?.monthly.length ? "ready" : "empty"}
                  height={390}
                  dataView={
                    <Table
                      rowKey="month"
                      size="small"
                      pagination={false}
                      dataSource={data?.monthly ?? []}
                      columns={[
                        { title: "月份", dataIndex: "month" },
                        { title: "销量", dataIndex: "qty", align: "right", render: formatQty },
                        { title: "上控制限", dataIndex: "upper3", align: "right", render: (v: number | null) => v == null ? "未解锁" : formatQty(v) },
                        { title: "下控制限", dataIndex: "lower3", align: "right", render: (v: number | null) => v == null ? "未解锁" : formatQty(v) },
                      ]}
                    />
                  }
                >
                  <ResponsiveContainer minWidth={0} minHeight={1}>
                    <LineChart data={data?.monthly ?? []} margin={{ top: 8, right: 18, left: 8, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" />
                      <YAxis tickFormatter={shortQty} />
                      <RechartsTooltip formatter={(value) => formatQty(Number(value))} />
                      {data?.spc.bands ? (
                        <>
                          <Area
                            dataKey="upper3"
                            stroke="none"
                            fill={VISUAL_COLOR.warning}
                            fillOpacity={0.08}
                            isAnimationActive={false}
                          />
                          <Line
                            dataKey="upper3"
                            name="+3σ"
                            dot={false}
                            stroke={VISUAL_COLOR.warning}
                            strokeDasharray="4 4"
                          />
                          <Line
                            dataKey="lower3"
                            name="-3σ"
                            dot={false}
                            stroke={VISUAL_COLOR.warning}
                            strokeDasharray="4 4"
                          />
                        </>
                      ) : null}
                      <Line
                        type="monotone"
                        dataKey="qty"
                        name="销量"
                        stroke={VISUAL_COLOR.primary}
                        strokeWidth={3}
                        activeDot={{ r: 6 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </DecisionVisual>
              </Space>
            ),
          },
          {
            key: "pivot",
            label: "自助透视",
            children: (
              <DecisionVisual
                title={`${DIMENSION_LABEL[dimension]} × 月份透视`}
                question={`哪些${DIMENSION_LABEL[dimension]}在什么月份贡献、增长或回落？`}
                metricId="salesQty"
                grain={`${DIMENSION_LABEL[dimension]} × 月`}
                unit="基础单位数量"
                source={{
                  tier: "snapshot",
                  source: "sales_monthly 销售月事实",
                  asOf: data?.latestMonth,
                }}
                coverage={{
                  covered: data?.pivot.length ?? 0,
                  total: data?.groups.length ?? 0,
                  label: "透视成员（按全期销量 TOP 20）",
                }}
                activeFilters={[`维度：${DIMENSION_LABEL[dimension]}`]}
                summary={`展示全期销量最高的 ${data?.pivot.length ?? 0} 个成员；点击成员可联动结构与趋势。`}
                caveat="为保持交互轻量，透视表展示全期销量 TOP 20；服务端先基于全量事实聚合，再排序，不使用当前表格页冒充全量。"
                state={loading && !data ? "loading" : data?.pivot.length ? "ready" : "empty"}
                height={380}
                dataView={null}
                contentIsTable
              >
                <Table
                  rowKey="key"
                  size="small"
                  pagination={false}
                  columns={pivotColumns}
                  dataSource={data?.pivot ?? []}
                  scroll={{ x: "max-content", y: 320 }}
                />
              </DecisionVisual>
            ),
          },
          {
            key: "daily",
            label: "日级节奏",
            children: (
              <DecisionVisual
                title="JST 日销量热力日历"
                question="日级销量集中在哪些日期，是否存在需要继续解释的峰谷？"
                metricId="salesQty"
                grain={selectedKey && dimension === "sku" ? `日 × SKU ${scope}` : "日 × 全部 JST 导入"}
                unit="出库数量"
                source={{
                  tier: "reference",
                  source: "JST 日销量受控 staging（每个日期取最新导入批次）",
                  asOf: data?.daily.latestDate,
                }}
                coverage={{
                  covered: data?.daily.coveredRows ?? 0,
                  total: data?.daily.totalRows ?? 0,
                  label: "已解析 SKU 行",
                }}
                activeFilters={selectedKey ? filters : ["范围：全部 JST 导入"]}
                summary={data?.daily.state === "ready"
                  ? `已覆盖 ${data.daily.dates.length} 个日期；颜色越深表示当日出库量越高。`
                  : data?.daily.gate ?? "等待 JST 日销量。"}
                caveat="该来源没有渠道、促销、退款和可售状态。热力只显示日级节奏，不能据此计算促销提升或断货损失。"
                state={loading && !data ? "loading" : data?.daily.state ?? "insufficient"}
                stateDetail={data?.daily.gate}
                height={360}
                dataView={
                  <Table
                    rowKey="date"
                    size="small"
                    pagination={false}
                    dataSource={data?.daily.dates ?? []}
                    columns={[
                      { title: "日期", dataIndex: "date" },
                      { title: "出库数量", dataIndex: "qty", align: "right", render: formatQty },
                    ]}
                  />
                }
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(92px, 1fr))",
                    gap: 6,
                    alignContent: "start",
                    height: "100%",
                    overflow: "auto",
                  }}
                >
                  {(data?.daily.dates ?? []).map((item) => {
                    const background = heatColor(item.qty, heatMax);
                    const dark = background === "#1d4ed8" || background === "#3b82f6";
                    return (
                      <div
                        key={item.date}
                        title={`${item.date}：${formatQty(item.qty)}`}
                        style={{
                          padding: "10px 8px",
                          borderRadius: 6,
                          background,
                          color: dark ? "white" : "#0f172a",
                          minHeight: 56,
                        }}
                      >
                        <div style={{ fontSize: 11, opacity: 0.8 }}>{item.date.slice(5)}</div>
                        <div style={{ fontWeight: 700 }}>{shortQty(item.qty)}</div>
                      </div>
                    );
                  })}
                </div>
              </DecisionVisual>
            ),
          },
          {
            key: "external",
            label: "外部需求信号",
            children: (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <Alert
                  showIcon
                  type={external?.state === "ready" ? "warning" : "error"}
                  message="观察口径：可用于发现趋势与身份缺口，不可直接驱动正式销量、库存、财务或补货"
                  description={external?.gate}
                  action={(
                    <Button href="/import/exceptions?status=open&scope=JIANDAOYUN">
                      处理简道云身份认领
                    </Button>
                  )}
                />
                <Row gutter={[10, 10]} className="compact-kpi-row">
                  <Col xs={12} lg={6}>
                    <Card size="small">
                      <Statistic
                        title="支付件数"
                        value={externalReady ? external.totals.paidQty : "数据不足"}
                        formatter={externalReady ? (v) => formatQty(Number(v)) : undefined}
                      />
                    </Card>
                  </Col>
                  <Col xs={12} lg={6}>
                    <Card size="small">
                      <Statistic
                        title="成功退款件数 / 退款率"
                        value={externalReady ? external.totals.refundQty : "数据不足"}
                        formatter={externalReady ? (v) => formatQty(Number(v)) : undefined}
                        suffix={externalReady && external.totals.paidQty > 0
                          ? ` / ${(external.totals.refundQty / external.totals.paidQty * 100).toFixed(1)}%`
                          : undefined}
                      />
                    </Card>
                  </Col>
                  <Col xs={12} lg={6}>
                    <Card size="small">
                      <Statistic
                        title="净需求信号"
                        value={externalReady ? external.totals.netQty : "数据不足"}
                        formatter={externalReady ? (v) => formatQty(Number(v)) : undefined}
                      />
                    </Card>
                  </Col>
                  <Col xs={12} lg={6}>
                    <Card size="small">
                      <Statistic
                        title="平台 SKU 身份覆盖"
                        value={externalReady && external.coverage.identityPct != null
                          ? external.coverage.identityPct
                          : "数据不足"}
                        precision={externalReady ? 1 : undefined}
                        suffix={externalReady && external.coverage.identityPct != null ? "%" : undefined}
                        valueStyle={{ color: externalReady && (external.coverage.identityPct ?? 0) >= 80
                          ? VISUAL_COLOR.positive
                          : VISUAL_COLOR.warning }}
                      />
                    </Card>
                  </Col>
                </Row>
                <DecisionVisual
                  title="简道云 · 天猫支付、退款与净需求趋势"
                  question="扣除成功退款后，外部需求信号如何变化；其中多少已经能安全归属系统 SKU？"
                  metricId="externalNetDemand"
                  grain="日 × 天猫平台 SKU"
                  unit="件"
                  source={{
                    tier: "reference",
                    source: "简道云天猫日销量 + 退款 + SKU 对照（各取最新成功批次）",
                    asOf: external?.sourceAsOf,
                  }}
                  coverage={{
                    covered: external?.coverage.mappedIdentities ?? 0,
                    total: external?.coverage.platformIdentities ?? 0,
                    label: "已映射平台 SKU 身份",
                  }}
                  activeFilters={["来源：简道云", "平台：天猫", "权限：只读观察", "当前经营筛选不作用于未映射平台身份"]}
                  summary={external?.state === "ready"
                    ? `观察净需求 ${formatQty(external.totals.netQty)}；已映射净需求 ${formatQty(external.totals.mappedNetQty)}；支付件数覆盖 ${external.coverage.paidQtyPct?.toFixed(1) ?? "—"}%。`
                    : external?.gate ?? "正在读取简道云外部需求证据。"}
                  caveat={external?.limitations.join(" ")}
                  state={loading && !data ? "loading" : external?.state ?? "insufficient"}
                  stateDetail={external?.gate}
                  height={390}
                  dataView={(
                    <Table
                      rowKey="date"
                      size="small"
                      pagination={false}
                      dataSource={external?.daily ?? []}
                      columns={[
                        { title: "日期", dataIndex: "date", sorter: (a, b) => a.date.localeCompare(b.date) },
                        { title: "支付件数", dataIndex: "paidQty", align: "right", sorter: (a, b) => a.paidQty - b.paidQty, render: formatQty },
                        { title: "成功退款", dataIndex: "refundQty", align: "right", sorter: (a, b) => a.refundQty - b.refundQty, render: formatQty },
                        { title: "净需求", dataIndex: "netQty", align: "right", sorter: (a, b) => a.netQty - b.netQty, render: formatQty },
                        { title: "已映射净需求", dataIndex: "mappedNetQty", align: "right", sorter: (a, b) => a.mappedNetQty - b.mappedNetQty, render: formatQty },
                      ]}
                    />
                  )}
                >
                  <ResponsiveContainer minWidth={0} minHeight={1}>
                    <LineChart data={external?.daily ?? []} margin={{ top: 8, right: 18, left: 8, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" minTickGap={28} />
                      <YAxis tickFormatter={shortQty} />
                      <RechartsTooltip formatter={(value) => formatQty(Number(value))} />
                      <Line type="monotone" dataKey="paidQty" name="支付件数" stroke={VISUAL_COLOR.primary} dot={false} />
                      <Line type="monotone" dataKey="refundQty" name="成功退款" stroke={VISUAL_COLOR.critical} dot={false} />
                      <Line type="monotone" dataKey="netQty" name="净需求信号" stroke={VISUAL_COLOR.positive} strokeWidth={3} dot={false} />
                      <Line type="monotone" dataKey="mappedNetQty" name="已映射净需求" stroke={VISUAL_COLOR.warning} strokeDasharray="5 4" dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </DecisionVisual>
                <Card
                  size="small"
                  title="优先处理：高销量未映射平台 SKU"
                  extra={<Tag color="gold">TOP {external?.topUnmapped.length ?? 0}</Tag>}
                >
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="先认领条码，再重新同步“天猫 SKU 对照”"
                    description="认领只建立简道云作用域身份；旧证据批次保持不可变，新同步批次才会取得系统 SKU 归属。"
                  />
                  <Table
                    rowKey={(row) => `${row.shopName}\u0000${row.platformSkuId}`}
                    size="small"
                    pagination={{ pageSize: 10, showSizeChanger: false }}
                    dataSource={external?.topUnmapped ?? []}
                    scroll={{ x: 1180 }}
                    columns={[
                      { title: "店铺", dataIndex: "shopName", width: 160, sorter: (a, b) => a.shopName.localeCompare(b.shopName, "zh-CN") },
                      { title: "平台 SKU", dataIndex: "platformSkuId", width: 180, sorter: (a, b) => a.platformSkuId.localeCompare(b.platformSkuId) },
                      { title: "条码", dataIndex: "barcode", width: 170, render: (value) => value || <Typography.Text type="secondary">未提供</Typography.Text> },
                      { title: "商品 / 规格", key: "name", ellipsis: true, render: (_, row) => row.skuName || row.productName || "（未提供）" },
                      { title: "支付件数", dataIndex: "paidQty", width: 130, align: "right", defaultSortOrder: "descend", sorter: (a, b) => a.paidQty - b.paidQty, render: formatQty },
                      { title: "退款", dataIndex: "refundQty", width: 110, align: "right", sorter: (a, b) => a.refundQty - b.refundQty, render: formatQty },
                      { title: "净需求", dataIndex: "netQty", width: 120, align: "right", sorter: (a, b) => a.netQty - b.netQty, render: formatQty },
                      {
                        title: "身份动作",
                        key: "identityAction",
                        width: 150,
                        fixed: "right",
                        render: (_, row) => {
                          if (!row.barcode) return <Tag color="error">回源补对照/条码</Tag>;
                          if (row.exceptionStatus === "open") {
                            const query = new URLSearchParams({
                              status: "open",
                              scope: "JIANDAOYUN",
                              aliasType: "sku_barcode",
                              rawValue: row.barcode,
                            });
                            return <Button type="link" size="small" href={`/import/exceptions?${query.toString()}`}>去认领</Button>;
                          }
                          if (row.exceptionStatus === "resolved") return <Tag color="processing">已认领·待同步</Tag>;
                          if (row.exceptionStatus === "ignored") return <Tag>已忽略·回源核对</Tag>;
                          return <Tag color="warning">待同步核对</Tag>;
                        },
                      },
                    ]}
                  />
                </Card>
              </Space>
            ),
          },
          {
            key: "review",
            label: "经营回顾",
            children: (
              <Row gutter={[12, 12]}>
                <Col xs={24} lg={14}>
                  <Card
                    title={data?.review.headline ?? "月度经营回顾"}
                    extra={
                      <Button icon={<CopyOutlined />} onClick={() => void copyReview()}>
                        复制成稿
                      </Button>
                    }
                  >
                    <Space direction="vertical" size={12} style={{ width: "100%" }}>
                      {(data?.review.bullets ?? []).map((bullet) => (
                        <Alert key={bullet} type="info" showIcon message={bullet} />
                      ))}
                      <Typography.Text type="secondary">
                        这是确定性事实成稿，不调用 LLM，不添加数据库中不存在的原因。负责人可在会议中补充判断。
                      </Typography.Text>
                    </Space>
                  </Card>
                </Col>
                <Col xs={24} lg={10}>
                  <Card title="未解锁分析" style={{ height: "100%" }}>
                    <Space direction="vertical" size={8}>
                      {data?.limitations.slice(1).map((item) => (
                        <Tag key={item} color="gold" style={{ whiteSpace: "normal", padding: "6px 8px" }}>
                          {item}
                        </Tag>
                      ))}
                    </Space>
                  </Card>
                </Col>
              </Row>
            ),
          },
          {
            key: "readiness",
            label: "能力解锁",
            children: <DecisionReadinessPanel />,
          },
        ]}
      />
    </div>
  );
}
