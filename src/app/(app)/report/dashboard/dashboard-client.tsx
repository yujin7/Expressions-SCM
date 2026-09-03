"use client";

/**
 * 经营驾驶舱：销量 / 库存 / 效期 / 可销天数 / 委外执行 / 数据健康 一屏总览。
 * 口径提示常驻：数量跨 SKU 直加仅参考；快照仓带数据日期；金额仅限授权角色。
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Segmented,
  Space,
  Table,
  Tag,
  Tooltip as AntTooltip,
  Typography,
} from "antd";
import {
  AlertOutlined,
  BulbOutlined,
  ClockCircleOutlined,
  FallOutlined,
  ReloadOutlined,
  RiseOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import CaliberNote from "@/components/CaliberNote";
import DecisionMetric from "@/components/DecisionMetric";
import DecisionVisual, { type DecisionVisualSource } from "@/components/DecisionVisual";
import { SERIES_COLORS, VISUAL_COLOR } from "@/components/decision-visuals";
import { exportCsv } from "@/components/exportCsv";
import { DOC_STATUS_LABELS } from "@/components/labels";
import { useListState } from "@/components/useListState";
import type { DashboardData } from "@/server/modules/report/dashboard";
import RemoteSelect from "@/components/RemoteSelect";

const PALETTE = SERIES_COLORS;
const EXP_COLORS: Record<string, string> = {
  已到期: "#cf1322",
  "0-3月": "#fa541c",
  "3-6月": "#fa8c16",
  "6-12月": "#fadb14",
  "12-18月": "#d3f261",
  "18-24月": "#a0d911",
  ">24月": "#52c41a",
};
const STATUS_LABELS: Record<string, string> = {
  ...DOC_STATUS_LABELS, // 唯一源（components/labels）
  rejected: "已驳回", cancelled: "已作废", reversed: "已冲销", // 本页额外历史态
};
const STATUS_COLORS: Record<string, string> = {
  draft: "#d9d9d9",
  pending: "#faad14",
  approved: "#1677ff",
  in_progress: "#13c2c2",
  completed: "#52c41a",
  rejected: "#ff4d4f",
  cancelled: "#8c8c8c",
  reversed: "#722ed1",
};

/** 试销打标（CURRENT.md 词汇表承诺：试销=新品观察期，报表打标） */
const LifeTag = ({ v }: { v?: string }) =>
  v === "trial" ? <Tag color="purple">试销</Tag> : v === "halted" ? <Tag>停售</Tag> : v === "retired" ? <Tag color="default">淘汰</Tag> : null;

const fmt = (v: number | string | undefined | null): string =>
  v == null ? "—" : Number(v).toLocaleString("zh-CN");

function DataTable({
  columns,
  rows,
}: {
  columns: { key: string; label: string; align?: "left" | "right" }[];
  rows: Record<string, React.ReactNode>[];
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={{ padding: "7px 8px", textAlign: column.align ?? "left", borderBottom: "1px solid #e2e8f0" }}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={String(row.key ?? index)}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  style={{ padding: "7px 8px", textAlign: column.align ?? "left", borderBottom: "1px solid #f1f5f9" }}
                >
                  {row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DashboardClient({ initialData }: { initialData: DashboardData }) {
  const router = useRouter();
  const data = initialData;
  const viewState = useListState({
    key: "executive-dashboard",
    defaults: { trend: "brand" },
    paginated: false,
  });
  const trendMode = viewState.filters.trend === "total" ? "总量" : "按品牌";
  /** D62：受限用户的渠道范围由服务端强制施加——选择器变只读标签，横幅如实说明 */
  const scopeForced = data.scope.forced === true;
  const scopeActive = Boolean(data.scope.brand || data.scope.channel || scopeForced);
  const channelScopeText = scopeForced ? data.scope.scopeLabel ?? "本渠道" : "全渠道";
  /** 筛选写进 URL：本页服务端取数，链接即口径，复制给别人看到的是同一份结果 */
  const pushScope = (next: { brand?: string; channel?: string }) => {
    const params = new URLSearchParams();
    const brand = "brand" in next ? next.brand : data.scope.brand ?? undefined;
    const channel = "channel" in next ? next.channel : data.scope.channel ?? undefined;
    if (brand) params.set("brand", brand);
    if (channel) params.set("channel", channel);
    const qs = params.toString();
    router.push(qs ? `/report/dashboard?${qs}` : "/report/dashboard");
  };

  const { kpi } = data;
  const channelTotal = data.channelMix.reduce((a, c) => a + c.qty, 0);
  const channelShare = data.channelMix.map((row) => ({
    ...row,
    share: channelTotal > 0 ? Math.round((row.qty / channelTotal) * 1000) / 10 : 0,
  }));
  const generatedDate = new Date(data.generatedAt).toLocaleString("zh-CN", { hour12: false });
  const salesSource: DecisionVisualSource = {
    tier: "snapshot",
    source: "sales_monthly 销售月事实",
    asOf: data.salesWindow.months6.at(-1) ?? null,
    note: "当前为月粒度数量口径",
  };
  const inventorySource: DecisionVisualSource = {
    tier: "derived",
    source: "库存过账台账 + 最新仓库快照",
    asOf: kpi.snapDate,
    note: "实时账与快照分层展示，不混作同一时点事实",
  };
  const stockByUomDetail =
    (kpi.stockByUom ?? [])
      .map((row) => `${row.uom}：${row.qty.toLocaleString("zh-CN")}`)
      .join("；") || "暂无单位明细";

  const riskCols: ColumnsType<DashboardData["expiryRiskTop"][number]> = [
    { title: "编码", dataIndex: "code", width: 130, render: (v: string, r) => <><Link href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</Link><LifeTag v={(r as { lifecycle?: string }).lifecycle} /></> },
    { title: "名称", dataIndex: "name", ellipsis: true },
    { title: "仓库", dataIndex: "warehouse", width: 110, ellipsis: true },
    {
      title: "剩余",
      dataIndex: "daysLeft",
      width: 90,
      align: "right",
      render: (v: number) => <Tag color={v < 0 ? "red" : v < 92 ? "volcano" : "orange"}>{v < 0 ? `逾期${-v}天` : `${v}天`}</Tag>,
    },
    { title: "数量", dataIndex: "qty", width: 90, align: "right", render: fmt },
  ];

  const slowCols: ColumnsType<DashboardData["slowTop"][number]> = [
    { title: "编码", dataIndex: "code", width: 130, render: (v: string, r) => <><Link href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</Link><LifeTag v={(r as { lifecycle?: string }).lifecycle} /></> },
    { title: "名称", dataIndex: "name", ellipsis: true },
    { title: "在库", dataIndex: "onHand", width: 90, align: "right", render: fmt },
    { title: "近3月销", dataIndex: "sales3m", width: 90, align: "right", render: fmt },
    {
      title: "可销天数",
      dataIndex: "daysCover",
      width: 100,
      align: "right",
      render: (v: number | null) => (v == null ? <Tag color="red">无动销</Tag> : <Tag color="orange">{fmt(v)}天</Tag>),
    },
    {
      title: "外部近30天净需求",
      dataIndex: "externalNet30",
      width: 150,
      align: "right",
      render: (v: number | null, r) => v == null
        ? <Typography.Text type="secondary">未映射</Typography.Text>
        : (
          <AntTooltip title={`简道云天猫观察，最近售出 ${r.externalLastSold ?? "—"}；近 90 天净需求 ${fmt(r.externalNet90)}`}>
            <Tag color={v > 0 && r.daysCover == null ? "volcano" : v > 0 ? "blue" : "default"}>{fmt(v)}</Tag>
          </AntTooltip>
        ),
    },
  ];

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <div className="dashboard-header__copy">
          <Typography.Title level={4} className="dashboard-header__title">
            经营驾驶舱
          </Typography.Title>
          {/*
            跨维筛选：只作用于销售类聚合。哪些跟随、哪些不跟随必须写在明面上——
            只筛一半却不说明，同一页会自相矛盾（顶上"品牌=NING"，下面库存 KPI 仍全量）。
          */}
          <Space wrap style={{ marginBottom: 8 }}>
            <RemoteSelect
              api="/api/master/brand"
              getLabel={(r) => String(r.nameCn ?? r.code)}
              getValue={(r) => String(r.code)}
              allowClear
              placeholder="全部品牌"
              style={{ width: 160 }}
              value={data.scope.brand ?? undefined}
              onChange={(v) => pushScope({ brand: v == null ? undefined : String(v) })}
            />
            {scopeForced ? (
              <AntTooltip title="渠道范围由管理员在「用户管理 → 数据范围」设置，本页不可更改；销售类卡片只含本范围渠道。">
                <Tag color="blue" style={{ height: 32, lineHeight: "30px", fontSize: 13, marginInlineEnd: 0 }} data-testid="channel-scope-tag">
                  范围：{data.scope.scopeLabel ?? "本渠道"}
                </Tag>
              </AntTooltip>
            ) : (
              <RemoteSelect
                api="/api/master/channel"
                getLabel={(r) => String(r.name ?? r.code)}
                getValue={(r) => String(r.code)}
                allowClear
                placeholder="全部渠道"
                style={{ width: 160 }}
                value={data.scope.channel ?? undefined}
                onChange={(v) => pushScope({ channel: v == null ? undefined : String(v) })}
              />
            )}
          </Space>
          {scopeActive ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 8 }}
              message={
                scopeForced
                  ? `已按您的数据范围限定 渠道=${data.scope.scopeLabel ?? "本渠道"}${data.scope.brand ? `，并按 品牌=${data.scope.brand} 筛选` : ""}`
                  : `已按${data.scope.brand ? ` 品牌=${data.scope.brand}` : ""}${data.scope.channel ? ` 渠道=${data.scope.channel}` : ""} 筛选`
              }
              description={
                <>
                  跟随筛选：{data.scope.appliesTo.join("、")}。
                  <b>不随筛选变化</b>：{data.scope.notAppliedTo.join("、")}
                  —— 这些不是按品牌/渠道记账的事实，按销售维度切会得到似是而非的数字。
                  {scopeForced ? "（库存/临期为公开口径，全公司总量；销售金额对本账号不下发。）" : null}
                </>
              }
            />
          ) : null}
          {data.externalDemand.state === "ready" ? (
            <Alert
              type={data.externalDemand.internalNoMoveButExternalSelling > 0 ? "warning" : "info"}
              showIcon
              style={{ marginBottom: 8 }}
              message={`内部销量事实到 ${data.externalDemand.internalThroughMonth ?? "—"}，简道云外部平台观察到 ${data.externalDemand.anchorDate ?? "—"}${data.externalDemand.lagDays != null ? `（内部晚 ${data.externalDemand.lagDays} 天）` : ""}`}
              description={
                <>
                  已映射 {data.externalDemand.mappedSkus.toLocaleString("zh-CN")} 个系统 SKU 的外部近 30/90 天净需求作为影子列显示；
                  <b>{data.externalDemand.internalNoMoveButExternalSelling}</b> 个 SKU 内部判「无动销」但外部近 30 天仍在售——处置或打折前先核对。
                  观察口径，不改销速与补货。
                </>
              }
            />
          ) : null}
          <CaliberNote
            summary={`最后生成 ${generatedDate}。先看异常与覆盖，再下钻到责任工作台；数量跨 SKU 汇总只反映规模。`}
            detail={
              <>
                销售事实当前只有月粒度数量；库存由实时记账仓和最新快照仓组成，两者时点不同。
                所有推导指标均保留来源、截至时点、覆盖与限制，缺数据时不以 0 代替。
              </>
            }
          />
        </div>
        <div className="dashboard-header__meta">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            数量为跨 SKU 直加参考口径；快照仓数据日期 {kpi.snapDate ?? "—"}
          </Typography.Text>
          <Button type="link" size="small" onClick={() => router.refresh()}>
            <ReloadOutlined /> 刷新
          </Button>
        </div>
      </header>

      {/* KPI 行 */}
      <section className="dashboard-kpi-grid" aria-label="经营关键指标">
        <div className="dashboard-kpi-grid__item">
          <DecisionMetric
            metricId="activeSkuSpu"
            value={kpi.skuActive}
            suffix={`/ ${kpi.spuCount}`}
            source={{ tier: "ledger", name: "SKU/SPU 主数据" }}
          />
        </div>
        <div className="dashboard-kpi-grid__item">
          <DecisionMetric
            metricId="salesQty"
            value={kpi.salesLastMonth}
            prefix={<RiseOutlined />}
            source={{ tier: "snapshot", name: "sales_monthly 销售月事实" }}
            asOf={kpi.lastMonth}
          />
        </div>
        <div className="dashboard-kpi-grid__item">
          <DecisionMetric
            metricId="onHandSystem"
            value={kpi.ownStockQty}
            source={{ tier: "ledger", name: "stock_balances 过账台账" }}
            actionHref="/inventory/balance"
            actionLabel="核对库存"
            detail={<>按基础单位拆分：{stockByUomDetail}</>}
          />
        </div>
        <div className="dashboard-kpi-grid__item">
          <DecisionMetric
            metricId="onHandExternal"
            value={kpi.snapStockQty}
            source={{ tier: "snapshot", name: "电商部库存明细快照" }}
            asOf={kpi.snapDate}
            actionHref="/report/demand?tab=stock_summary"
            actionLabel="核对外部登记"
          />
        </div>
        <div className="dashboard-kpi-grid__item">
          <DecisionMetric
            metricId="expiryRiskQty"
            value={kpi.expiryRiskQty}
            prefix={<ClockCircleOutlined />}
            status={kpi.expiryRiskQty > 0 ? "critical" : "positive"}
            source={{ tier: "derived", name: "批次库存与效期规则" }}
            asOf={generatedDate}
            actionHref="/inventory/expiry"
            actionLabel="查看风险批次"
          />
        </div>
        <div className="dashboard-kpi-grid__item">
          <DecisionMetric
            metricId="riskActionCount"
            value={kpi.riskActionCount}
            prefix={<ClockCircleOutlined />}
            status={kpi.riskActionCount > 0 ? "critical" : "positive"}
            source={{ tier: "derived", name: "效期 × 货盘注记 × 销速" }}
            actionHref="/report/risk"
            actionLabel="进入处置工作台"
          />
        </div>
        <div className="dashboard-kpi-grid__item">
          <DecisionMetric
            metricId="slowMoverCount"
            value={kpi.slowMoverCount}
            suffix={`/ ${kpi.pendingApprovals + kpi.reviewBacklog} 待办`}
            prefix={<FallOutlined />}
            status={kpi.slowMoverCount > 0 ? "warning" : "positive"}
            source={{ tier: "derived", name: "库存与近 3 月销速" }}
            actionHref="/workbench"
            actionLabel="分派与处理"
            detail={<>正常销售口径已分开样品；有库存样品 {kpi.sampleStockSkuCount} 个，未分类 {kpi.unclassifiedStockSkuCount} 个（未分类暂保留在滞销统计，待业务确认）。</>}
          />
        </div>
      </section>

      {/* 智能洞察 */}
      {data.insights.length > 0 && (
        <Alert
          className="dashboard-insights"
          style={{ marginTop: 16 }}
          type="info"
          showIcon
          icon={<BulbOutlined />}
          message="智能洞察（纯报表口径自动归纳，不代决策）"
          description={
            <>
              <ul className="dashboard-insights__list">
                {data.insights.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              <Space wrap size={[16, 6]} className="dashboard-insights__actions">
                <Link href="/workbench">→ 工作台待办</Link>
                <Link href="/import/release">→ 放行工作台</Link>
                <Link href="/import/exceptions">→ 别名认领</Link>
                <Link href="/inventory/balance">→ 库存余额</Link>
              </Space>
            </>
          }
        />
      )}

      {/* 销售趋势 + 渠道结构 */}
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} xl={16}>
          <DecisionVisual
            title={`销售趋势（${data.salesWindow.months6[0] ?? ""} ~ ${data.salesWindow.months6.at(-1) ?? ""}，${channelScopeText}）`}
            question="销量规模在加速还是减速，变化来自哪些品牌？"
            metricId="salesQty"
            grain="月 × 品牌"
            unit="基础单位数量"
            source={salesSource}
            coverage={{ covered: data.salesWindow.months6.length, total: 6, label: "目标窗口月份" }}
            activeFilters={[trendMode]}
            caveat="仅有 6 个月月度数量，不能据此判断同比、季节性或日内波动。"
            summary={`覆盖 ${data.salesWindow.months6.length} 个月；最近月销量 ${fmt(kpi.salesLastMonth)}。折线为每月合计，堆叠柱为品牌构成。`}
            extra={
              <Segmented
                size="small"
                options={[
                  { label: "按品牌", value: "brand" },
                  { label: "总量", value: "total" },
                ]}
                value={viewState.filters.trend}
                onChange={(value) => viewState.setFilter({ trend: String(value) })}
              />
            }
            dataView={
              <DataTable
                columns={[
                  { key: "month", label: "月份" },
                  ...data.trendBrands.map((brand) => ({ key: brand, label: brand, align: "right" as const })),
                  { key: "total", label: "合计", align: "right" },
                ]}
                rows={data.salesTrend.map((row) => ({ key: row.month, ...row }))}
              />
            }
            onExport={() =>
              exportCsv(
                "经营驾驶舱-销售趋势",
                ["月份", ...data.trendBrands, "合计"],
                data.salesTrend.map((row) => [
                  row.month,
                  ...data.trendBrands.map((brand) => row[brand]),
                  row.total,
                ]),
              )
            }
          >
            <ResponsiveContainer>
              <ComposedChart data={data.salesTrend} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis tickFormatter={(v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} />
                <Tooltip formatter={(v) => fmt(v as number)} />
                <Legend />
                {trendMode === "按品牌" ? (
                  data.trendBrands.map((b, i) => <Bar key={b} dataKey={b} stackId="s" fill={PALETTE[i % PALETTE.length]} />)
                ) : (
                  <Bar dataKey="total" name="总量" fill={VISUAL_COLOR.primary} />
                )}
                <Line type="monotone" dataKey="total" name="合计" stroke={VISUAL_COLOR.critical} strokeWidth={2} dot />
              </ComposedChart>
            </ResponsiveContainer>
          </DecisionVisual>
        </Col>
        <Col xs={24} xl={8}>
          <DecisionVisual
            title={`渠道结构（近${data.salesWindow.months6.length}个月）`}
            question="销量集中在哪些渠道，单一渠道依赖有多高？"
            metricId="salesQty"
            grain="渠道"
            unit="销量占比"
            source={salesSource}
            coverage={{ covered: data.salesWindow.months6.length, total: 6, label: "目标窗口月份" }}
            caveat={scopeForced ? "只含您的数据范围内的渠道，占比在范围内计算，不代表全公司结构。" : "当前缺少销售额、毛利与促销信息，结构只代表数量贡献。"}
            summary={`共 ${data.channelMix.length} 个渠道；最大渠道占比 ${channelShare[0]?.share ?? 0}%。`}
            dataView={
              <DataTable
                columns={[
                  { key: "name", label: "渠道" },
                  { key: "qty", label: "销量", align: "right" },
                  { key: "shareText", label: "占比", align: "right" },
                ]}
                rows={channelShare.map((row) => ({ key: row.name, ...row, shareText: `${row.share}%` }))}
              />
            }
            onExport={() =>
              exportCsv(
                "经营驾驶舱-渠道结构",
                ["渠道", "销量", "占比"],
                channelShare.map((row) => [row.name, row.qty, `${row.share}%`]),
              )
            }
          >
            <ResponsiveContainer>
              <BarChart data={channelShare} layout="vertical" margin={{ left: 16, right: 28 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" unit="%" domain={[0, "dataMax"]} />
                <YAxis type="category" dataKey="name" width={76} />
                <Tooltip
                  formatter={(value, name, item) => [
                    name === "share" ? `${value}%（${fmt(item.payload.qty)}）` : fmt(value as number),
                    "占比",
                  ]}
                />
                <Bar dataKey="share" name="占比" fill={VISUAL_COLOR.compare} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </DecisionVisual>
        </Col>
      </Row>

      {/* 品牌 + TOP SKU */}
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} xl={8}>
          <DecisionVisual
            title={`品牌销量结构（近${data.salesWindow.months6.length}个月）`}
            question="当前销量由哪些品牌贡献，品牌组合是否过度集中？"
            metricId="salesQty"
            grain="品牌"
            unit="基础单位数量"
            source={salesSource}
            summary={`共 ${data.brandSales.length} 个有销量品牌，按近 ${data.salesWindow.months6.length} 个月销量从高到低排列。`}
            caveat="数量不能替代收入或毛利贡献。"
            dataView={
              <DataTable
                columns={[
                  { key: "name", label: "品牌" },
                  { key: "qty", label: "销量", align: "right" },
                ]}
                rows={data.brandSales.map((row) => ({ key: row.name, ...row }))}
              />
            }
          >
            <ResponsiveContainer>
              <BarChart data={data.brandSales} layout="vertical" margin={{ left: 24, right: 24 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tickFormatter={(v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} />
                <YAxis type="category" dataKey="name" width={88} />
                <Tooltip formatter={(v) => fmt(v as number)} />
                <Bar dataKey="qty" name="销量">
                  {data.brandSales.map((_, i) => (
                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </DecisionVisual>
        </Col>
        <Col xs={24} xl={16}>
          <DecisionVisual
            title={`TOP 10 SKU（近${data.salesWindow.months6.length}个月销量）`}
            question="哪些单品贡献最大，需要优先保障供给与效期？"
            metricId="salesQty"
            grain="SKU"
            unit="基础单位数量"
            source={salesSource}
            summary={`展示销量最高的 ${data.topSkus.length} 个 SKU；点击编码可进入 SKU 360 继续判断供给与风险。`}
            caveat="TOP 10 是聚焦视图，不代表长尾 SKU 没有缺货或效期风险。"
            dataView={
              <DataTable
                columns={[
                  { key: "code", label: "SKU" },
                  { key: "name", label: "名称" },
                  { key: "qty", label: "销量", align: "right" },
                ]}
                rows={data.topSkus.map((row) => ({
                  key: row.code,
                  ...row,
                  code: <Link href={`/report/sku-360?q=${encodeURIComponent(row.code)}`}>{row.code}</Link>,
                }))}
              />
            }
          >
            <ResponsiveContainer>
              <BarChart data={data.topSkus} layout="vertical" margin={{ left: 24, right: 24 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tickFormatter={(v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} />
                <YAxis type="category" dataKey="code" width={100} />
                <Tooltip
                  formatter={(v) => fmt(v as number)}
                  labelFormatter={(label) => {
                    const r = data.topSkus.find((x) => x.code === label);
                    return r ? `${r.code} ${r.name}` : String(label);
                  }}
                />
                <Bar dataKey="qty" name="销量" fill={VISUAL_COLOR.compare} />
              </BarChart>
            </ResponsiveContainer>
          </DecisionVisual>
        </Col>
      </Row>

      {/* 库存分布 + 可销天数 */}
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} xl={14}>
          <DecisionVisual
            title="库存分布（TOP 仓库）"
            question="库存压在哪些仓，哪些数字是实时账、哪些只是快照？"
            metricId="onHandSystem"
            grain="仓库"
            unit="基础单位数量"
            source={inventorySource}
            summary={`展示 ${data.warehouseStock.length} 个主要仓库；蓝色为实时记账仓，灰色为快照仓。`}
            caveat="不同基础单位不能解释为一种实物总量；快照仓应结合时点判断新鲜度。"
            extra={
              <Space size={4}>
                <Tag color="blue">实时账</Tag>
                <Tag>快照参考</Tag>
              </Space>
            }
            dataView={
              <DataTable
                columns={[
                  { key: "name", label: "仓库" },
                  { key: "modeText", label: "口径" },
                  { key: "bizDate", label: "截至" },
                  { key: "qty", label: "在库", align: "right" },
                ]}
                rows={data.warehouseStock.map((row) => ({
                  key: row.name,
                  ...row,
                  modeText: row.mode === "realtime" ? "实时记账" : "快照",
                  bizDate: row.bizDate ?? "实时",
                }))}
              />
            }
          >
            <ResponsiveContainer>
              <BarChart data={data.warehouseStock} margin={{ bottom: 48, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" interval={0} angle={-30} textAnchor="end" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} />
                <Tooltip
                  formatter={(v) => fmt(v as number)}
                  labelFormatter={(label) => {
                    const r = data.warehouseStock.find((x) => x.name === label);
                    return r?.mode === "snapshot" ? `${label}（快照 ${r.bizDate}）` : `${label}（实时账）`;
                  }}
                />
                <Bar dataKey="qty" name="在库量">
                  {data.warehouseStock.map((r, i) => (
                    <Cell key={i} fill={r.mode === "realtime" ? VISUAL_COLOR.primary : VISUAL_COLOR.muted} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </DecisionVisual>
        </Col>
        <Col xs={24} xl={10}>
          <DecisionVisual
            title="可销天数分布（系统库存）"
            question="多少 SKU 面临短缺，多少 SKU 正在积压或无动销？"
            metricId="daysCover"
            grain="可销天数区间"
            unit="SKU 数"
            source={inventorySource}
            summary={`${data.coverBuckets.map((row) => `${row.bucket} ${row.count} 个`).join("；")}。`}
            caveat="日均销使用近 3 月月度事实折算；无动销单独呈现，不显示为 0 或无穷。"
            dataView={
              <DataTable
                columns={[
                  { key: "bucket", label: "覆盖区间" },
                  { key: "count", label: "SKU 数", align: "right" },
                ]}
                rows={data.coverBuckets.map((row) => ({ key: row.bucket, ...row }))}
              />
            }
          >
            <ResponsiveContainer>
              <BarChart data={data.coverBuckets} margin={{ right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="count" name="SKU 数">
                  {data.coverBuckets.map((r, i) => (
                    <Cell
                      key={i}
                      fill={r.bucket === "<30天" ? VISUAL_COLOR.critical : r.bucket === ">180天" || r.bucket === "无动销" ? VISUAL_COLOR.warning : VISUAL_COLOR.positive}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </DecisionVisual>
        </Col>
      </Row>

      {/* 效期 */}
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} xl={10}>
          <DecisionVisual
            title="效期七段位（批次覆盖）"
            question="有批次信息的库存集中在哪个剩余效期区间？"
            metricId="expiryRiskQty"
            grain="效期区间"
            unit="批次数量"
            source={{
              tier: "derived",
              source: "批次库存 × 有效期",
              asOf: generatedDate,
              note: "只覆盖已维护批次与过期日的库存",
            }}
            summary={`${data.expiryBuckets.map((row) => `${row.bucket} ${fmt(row.qty)}`).join("；")}。`}
            caveat="缺少批次或过期日的库存不进入分布，不能将未显示部分理解为安全。"
            dataView={
              <DataTable
                columns={[
                  { key: "bucket", label: "剩余效期" },
                  { key: "batches", label: "批次数", align: "right" },
                  { key: "qty", label: "数量", align: "right" },
                ]}
                rows={data.expiryBuckets.map((row) => ({ key: row.bucket, ...row }))}
              />
            }
          >
            <ResponsiveContainer>
              <BarChart data={data.expiryBuckets} margin={{ right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} />
                <Tooltip formatter={(v, n) => [fmt(v as number), n === "qty" ? "数量" : n]} />
                <Bar dataKey="qty" name="数量">
                  {data.expiryBuckets.map((r, i) => (
                    <Cell key={i} fill={EXP_COLORS[r.bucket] ?? "#8c8c8c"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </DecisionVisual>
        </Col>
        <Col xs={24} xl={14}>
          <Card
            size="small"
            title={
              <Space>
                <AlertOutlined style={{ color: "#cf1322" }} />
                近效期风险 TOP 10（≤6 月）
              </Space>
            }
          >
            <Table<DashboardData["expiryRiskTop"][number]>
              rowKey={(r) => `${r.code}-${r.warehouse}-${r.expiryDate}-${data.expiryRiskTop.indexOf(r)}`}
              size="small"
              columns={riskCols}
              dataSource={data.expiryRiskTop}
              pagination={false}
              locale={{ emptyText: "无 180 天内到期批次" }}
            />
          </Card>
        </Col>
      </Row>

      {/* 滞销 + 委外执行 */}
      <Row gutter={[12, 12]} style={{ marginTop: 12, marginBottom: 12 }}>
        <Col xs={24} xl={14}>
          <Card size="small" title="滞销压库 TOP 10（可销天数 > 180 或无动销，按在库量排序）">
            <Table<DashboardData["slowTop"][number]>
              rowKey="code"
              size="small"
              columns={slowCols}
              dataSource={data.slowTop}
              pagination={false}
              locale={{ emptyText: "无滞销 SKU" }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card size="small" title="委外执行 / 数据健康" styles={{ body: { paddingTop: 8 } }}>
            {data.outsource.map((d) => (
              <div key={d.docType} style={{ marginBottom: 8 }}>
                <Typography.Text style={{ fontSize: 12 }}>
                  {d.label}（{d.total}）
                </Typography.Text>
                <div style={{ display: "flex", gap: 2, marginTop: 2 }}>
                  {d.total === 0 ? (
                    <div style={{ flex: 1, height: 10, background: "#f0f0f0", borderRadius: 4 }} />
                  ) : (
                    Object.entries(d.byStatus).map(([st, c]) => (
                      <AntTooltip key={st} title={`${STATUS_LABELS[st] ?? st}: ${c}`}>
                        <div
                          style={{
                            flex: c,
                            height: 10,
                            background: STATUS_COLORS[st] ?? "#d9d9d9",
                            borderRadius: 4,
                            minWidth: 6,
                          }}
                        />
                      </AntTooltip>
                    ))
                  )}
                </div>
              </div>
            ))}
            <Space direction="vertical" size={4} style={{ marginTop: 8 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                待审批 {kpi.pendingApprovals} · 别名/导入待处理 {kpi.reviewBacklog}
              </Typography.Text>
              {data.settlement && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  结算单 {data.settlement.docs} 张，累计净额 ¥{fmt(data.settlement.amountSum)}（仅财务/管理员可见）
                </Typography.Text>
              )}
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
