"use client";

/**
 * 驾驶舱四屏（D50）。每屏一个视口、例外优先；每块显示来源·时点·覆盖·限制；
 * 无数据/无权限/待接入/样本不足各有空态，绝不显示 0。
 *
 * UX 走查（2026-09-04）落地：
 * - 所有数字格式走 components/format（OTIF 比例由服务端折成百分数，前端只拼 %）；
 * - 加载失败用 LoadErrorAlert 持久显示、可重试；首屏用 Skeleton 而不是空 Tab；
 * - 截断的表一律「显示前 N / 共 M，查看全部 →」；计数一律是链接，落到预筛选的行清单；
 * - 队列子查询失败显示「—」+ 错误 chip，不显示 0。
 */
import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Alert, Button, Card, Col, Collapse, Row, Skeleton, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useDocumentRead } from "@/components/useDocumentRead";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { formatAsOf, formatCount, formatPct, formatQty, formatYuan } from "@/components/format";
import { inventoryCoverMetricHref, todoCohortHref } from "@/lib/cockpit-navigation";
import { GOAL_SOURCE, goalSourceKey, roleLabel, sourceStateColor, sourceStateLabel } from "@/components/dictionary";
import type { Block, CockpitData, RedlineItem, SourceStatusRow } from "@/server/modules/report/cockpit";
import type { MonthEndPoint, WarehouseBlock } from "@/server/modules/report/inventory-position";
import type { RatioMonthRow } from "@/server/modules/report/inventory-sales-ratio";
import type { InventoryAlertRow } from "@/server/modules/report/inventory-alerts";
import type { SpikeHit } from "@/server/modules/report/sales-spike";
import type { TransferAnomalyRow, TransferLaneRow } from "@/server/modules/report/transfer-routes";
import type { WarehouseInventoryRow } from "@/server/modules/report/warehouse-inventory";
import type { GoalRow } from "@/server/modules/goals/service";
import CockpitTrends from "./trends/CockpitTrends";
import styles from "./cockpit.module.css";

const TABS = [
  { key: "sources", label: "数据来源与总量" },
  { key: "alerts", label: "预警" },
  { key: "inventory", label: "库存管控" },
  { key: "ops", label: "日常事务" },
  { key: "channels", label: "渠道观察" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const asOfText = formatAsOf;

/** 块壳：统一处理五态 + 来源/时点/限制文案 */
function BlockCard({ title, block, children, extra }: { title: string; block: Block<unknown>; children?: React.ReactNode; extra?: React.ReactNode }) {
  const stateTag = block.state === "ready" ? <Tag color="success">有数</Tag>
    : block.state === "pending_domain" ? <Tag>待接入</Tag>
    : block.state === "no_access" ? <Tag color="default">无权限</Tag>
    : block.state === "insufficient" ? <Tag color="warning">缺流</Tag>
    : <Tag color="error">出错</Tag>;
  return (
    <Card size="small" title={<Space size={6}><span>{title}</span>{stateTag}</Space>} extra={extra}>
      {block.state === "ready" ? children : (
        <Typography.Paragraph className={styles.blockMessage} role="status" type={block.state === "error" ? "danger" : "secondary"}>
          {
          block.state === "pending_domain" ? `待接入：${block.note}`
            : block.state === "no_access" ? block.note
            : block.state === "insufficient" ? `暂无可用数据：${block.note}`
            : `读取失败：${block.note}`
          }
        </Typography.Paragraph>
      )}
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
        来源：{block.source.source}{block.source.asOf ? ` · 时点 ${asOfText(block.source.asOf)}` : ""}{block.state === "ready" && block.note ? ` · ${block.note}` : ""}
      </Typography.Paragraph>
    </Card>
  );
}

/** 截断说明：只显示了前 shown 行时提示总数并给全量链接（审计 #14） */
function TruncNote({ shown, total, href, unit = "行" }: { shown: number; total: number; href: string; unit?: string }) {
  if (total <= shown) return null;
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 6 }}>
      显示前 {shown} / 共 {total} {unit}，<a href={href}>查看全部 →</a>
    </Typography.Text>
  );
}

/** 计数即链接：落到预筛选的行清单（审计 #14） */
function CountLink({ label, value, href }: { label: string; value: number | string; href: string }) {
  return <a href={href}><Typography.Text type="secondary">{label} </Typography.Text><Typography.Text strong>{value}</Typography.Text></a>;
}

/** 队列数：null = 子查询失败，显示 — 与错误 chip，绝不显示 0（审计 #4） */
function QueueStat({ title, value, error, href }: { title: string; value: number | null; error: string | null; href: string }) {
  return (
    <Space direction="vertical" size={2}>
      <a href={href}><Statistic title={title} value={value == null ? "—" : value} /></a>
      {error ? <Tooltip title={error}><Tag color="error">读取失败</Tag></Tooltip> : null}
    </Space>
  );
}

export default function CockpitClient() {
  const sp = useSearchParams();
  const tab = (TABS.some((t) => t.key === sp.get("tab")) ? sp.get("tab") : "sources") as TabKey;
  const { data, error, phase, retry: load } = useDocumentRead<CockpitData>("/api/report/cockpit");
  const loading = phase === "loading";

  const viewHref = (key: string) => {
    const q = new URLSearchParams(sp.toString()); q.set("tab", key);
    return `/cockpit?${q.toString()}`;
  };

  const monthEndCols: ColumnsType<MonthEndPoint> = useMemo(() => [
    { title: "月份", dataIndex: "yearMonth", width: 90, fixed: "left", render: (v: string, r) => <span>{v}{r.isCurrent ? <Tag style={{ marginLeft: 6 }}>当月</Tag> : null}</span> },
    { title: "月末在库", key: "q", align: "right", render: (_, r) => r.total ? formatCount(r.total.qty) : <Typography.Text type="secondary">未补录</Typography.Text> },
    { title: "环比", dataIndex: "momQtyPct", align: "right", width: 90, render: (v: number | null) => v == null ? "—" : <Typography.Text type={v < 0 ? "danger" : "success"}>{v > 0 ? "+" : ""}{v}%</Typography.Text> },
    { title: "月末金额", key: "v", align: "right", render: (_, r) => r.total ? <span>{formatYuan(r.total.value.amount)}{r.total.value.incomplete ? <Tag color="warning" style={{ marginLeft: 6 }}>覆盖 {formatPct(r.total.value.coveragePct)}</Tag> : null}</span> : "—" },
    { title: "环比", dataIndex: "momValuePct", align: "right", width: 90, render: (v: number | null) => v == null ? "—" : `${v > 0 ? "+" : ""}${v}%` },
    { title: "口径", key: "parts", render: (_, r) => r.total ? (r.total.parts.length < 2 ? <Tag color="warning">部分口径（{r.total.parts.join("+")}）</Tag> : "实时仓+快照仓") : "—" },
  ], []);

  const ratioCols: ColumnsType<RatioMonthRow> = useMemo(() => [
    { title: "月份", dataIndex: "yearMonth", width: 90, fixed: "left" },
    { title: "月末库存金额", key: "inv", align: "right", render: (_, r) => r.inventoryMonthEnd ? formatYuan(r.inventoryMonthEnd.amount) : "—" },
    { title: "销售金额", key: "s", align: "right", render: (_, r) => r.salesAmount == null ? <Typography.Text type="secondary">未录入</Typography.Text> : <span>{formatYuan(r.salesAmount)} {r.salesSource === "prefill_observation" ? <Tag color="blue">观察预填</Tag> : <Tag>手工</Tag>}</span> },
    { title: "占比", dataIndex: "ratioMonthEndPct", align: "right", render: (v: number | null, r) => v == null ? "—" : <Tag color={r.band === "green" ? "success" : r.band === "red" ? "error" : r.band === "yellow" ? "warning" : "blue"}>{v}%</Tag> },
    { title: "月均版", dataIndex: "ratioAvgPct", align: "right", render: (v: number | null) => formatPct(v) },
    { title: "环比(pp)", dataIndex: "momPoints", align: "right", render: (v: number | null) => v == null ? "—" : `${v > 0 ? "+" : ""}${v}` },
    { title: "说明", dataIndex: "gate", ellipsis: true },
  ], []);

  const srcCols: ColumnsType<SourceStatusRow> = [
    { title: "来源", dataIndex: "label", width: 110, fixed: "left" },
    { title: "状态", dataIndex: "state", width: 110, render: (v: string) => <Tag color={sourceStateColor(v)}>{sourceStateLabel(v)}</Tag> },
    { title: "最近成功", dataIndex: "lastSuccessAt", width: 150, render: (v: string | null) => asOfText(v) },
    { title: "业务截止", dataIndex: "sourceAsOfEnd", width: 110, render: (v: string | null) => v ?? "—" },
    { title: "源行 / 落库", key: "rows", width: 130, align: "right", render: (_, r) => r.sourceRows == null ? "—" : `${formatCount(r.sourceRows)} / ${formatCount(r.stagedRows ?? 0)}` },
    { title: "流", key: "streams", width: 90, align: "right", render: (_, r) => `${r.successfulStreams ?? 0} / ${r.selectedContractCount}` },
    { title: "阻断 / 下一步", key: "gate", ellipsis: true, render: (_, r) => r.gate ?? r.nextAction ?? "—" },
  ];

  const whCols: ColumnsType<WarehouseBlock> = [
    { title: "仓库", dataIndex: "name", ellipsis: true, width: 160, fixed: "left" },
    { title: "地区", dataIndex: "regionCode", width: 70 },
    { title: "类型", dataIndex: "mode", width: 80, render: (v: string) => v === "realtime" ? "实时" : "快照" },
    { title: "在库", dataIndex: "qty", align: "right", sorter: (a, b) => Number(a.qty) - Number(b.qty), render: (v: string) => formatCount(v) },
    { title: "SKU", dataIndex: "skus", align: "right", width: 70, sorter: (a, b) => Number(a.skus) - Number(b.skus) },
    { title: "金额", key: "v", align: "right", render: (_, r) => r.value ? <span>{formatYuan(r.value.amount)}{r.value.incomplete ? <Tag color="warning" style={{ marginLeft: 4 }}>{formatPct(r.value.coveragePct)}</Tag> : null}</span> : <Typography.Text type="secondary">无权限</Typography.Text> },
    { title: "周转", key: "t", width: 90, render: (_, r) => r.mode === "snapshot" ? <Typography.Text type="secondary">无流水</Typography.Text> : <Tag>待接入</Tag> },
    { title: "数据截止", key: "d", width: 110, render: (_, r) => r.mode === "realtime" ? "即时" : (r.bizDate ?? "—") },
  ];

  const s = data?.screens;
  const topbar = data?.topbar;
  const redline = (s?.alerts.redline ?? []).filter((r: RedlineItem) => r.count > 0);

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
        <Space wrap size={[16, 4]}>
          <Typography.Text strong>驾驶舱四屏</Typography.Text>
          <Typography.Text type="secondary">角色：{topbar?.roleLabel ?? "—"}</Typography.Text>
          <Typography.Text type="secondary">{topbar?.scopeLabel ?? ""}</Typography.Text>
          <Typography.Text type="secondary">读数生成 {asOfText(data?.generatedAt)}（北京时间）· 业务截止见各卡片</Typography.Text>
          <Typography.Text type="secondary">覆盖 成本 {formatPct(topbar?.valuationCoveragePct)} / 身份 {formatPct(topbar?.identityCoveragePct)}</Typography.Text>
          <Typography.Text type="secondary">口径 {topbar?.calibreVersion ?? "—"}</Typography.Text>
          <Button size="small" aria-label="刷新概览" aria-busy={loading} onClick={load} loading={loading}>刷新</Button>
          <a href="/admin/params">参数页 ↗</a>
          <a href="/report/dashboard">经营分析总览 →</a>
        </Space>
      </Card>

      <LoadErrorAlert error={error} onRetry={() => void load()} subject="驾驶舱" retrying={loading} />

      <nav className={styles.views} aria-label="驾驶舱视图">
        {TABS.map(t => <Link key={t.key} replace scroll={false} href={viewHref(t.key)} aria-current={tab === t.key ? "page" : undefined}>{t.label}</Link>)}
      </nav>

      {!s && !error && tab !== "channels" ? <div role="status" aria-label="正在加载驾驶舱概览"><Skeleton active paragraph={{ rows: 4 }} /></div> : null}

      {tab === "sources" && s ? (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Row gutter={[12, 12]}>
            <Col xs={24} md={12} xl={6}>
              <BlockCard title="当月库存数量" block={s.sources.position} extra={<a href="/inventory/position?tab=daily">逐日 →</a>}>
                {s.sources.position.data ? (<>
                  <Statistic value={formatCount(s.sources.position.data.current.total.qty)} suffix="件" />
                  <Typography.Text type="secondary">本月入 +{formatCount(s.sources.position.data.monthToDate.inQty)} · 出 −{formatCount(s.sources.position.data.monthToDate.outQty)} · {s.sources.position.data.monthToDate.days} 天有账</Typography.Text>
                </>) : null}
              </BlockCard>
            </Col>
            <Col xs={24} md={12} xl={6}>
              <BlockCard title="当月库存金额" block={s.sources.position} extra={<a href="/inventory/position?tab=warehouses">各仓 →</a>}>
                {s.sources.position.data ? (<>
                  <Statistic value={formatYuan(s.sources.position.data.current.total.value.amount)} />
                  <Space size={6}>
                    {s.sources.position.data.current.total.value.incomplete ? <Tag color="warning">覆盖 {formatPct(s.sources.position.data.current.total.value.coveragePct)} 不完整</Tag> : <Tag color="success">覆盖 {formatPct(s.sources.position.data.current.total.value.coveragePct)}</Tag>}
                    <Typography.Text type="secondary">未计价 SKU {s.sources.position.data.current.total.value.uncoveredSkus}</Typography.Text>
                  </Space>
                </>) : null}
              </BlockCard>
            </Col>
            <Col xs={24} md={12} xl={6}>
              <BlockCard title="当月销售金额" block={s.sources.monthlySalesBlock} extra={s.sources.monthlySalesBlock.state !== "no_access" ? <a href="/inventory/position?tab=monthly">录入/修正 →</a> : null}>
                {s.sources.monthlySalesBlock.data ? (<>
                  <Statistic value={formatYuan(s.sources.monthlySalesBlock.data.salesAmount)} />
                  <Typography.Text type="secondary">{s.sources.monthlySalesBlock.data.yearMonth} · {s.sources.monthlySalesBlock.data.salesSource === "prefill_observation" ? "观察预填，待财务确认" : "财务手工值"}</Typography.Text>
                </>) : null}
              </BlockCard>
            </Col>
            <Col xs={24} md={12} xl={6}>
              <BlockCard title="库存占比" block={s.sources.ratio} extra={<a href="/admin/params">目标 →</a>}>
                {s.sources.ratio.data ? (<>
                  <Statistic value={formatPct(s.sources.ratio.data.current.ratioMonthEndPct)} valueStyle={{ color: s.sources.ratio.data.current.band === "green" ? "#0E6B4A" : s.sources.ratio.data.current.band === "red" ? "#B23A2E" : undefined }} />
                  <Typography.Text type="secondary">目标 {s.sources.ratio.data.target.low}–{s.sources.ratio.data.target.high}% · 基线 {s.sources.ratio.data.target.baseline}% · 月均版 {formatPct(s.sources.ratio.data.current.ratioAvgPct)} · 环比 {s.sources.ratio.data.current.momPoints == null ? "—" : `${s.sources.ratio.data.current.momPoints}pp`}</Typography.Text>
                </>) : null}
              </BlockCard>
            </Col>
          </Row>
          <BlockCard title="历史按月与环比" block={s.sources.position} extra={<a href="/inventory/position?tab=monthly">全部月份 →</a>}>
            {s.sources.position.data ? <Table<MonthEndPoint> rowKey="yearMonth" size="small" pagination={{ pageSize: 6, showSizeChanger: false, hideOnSinglePage: true, showTotal: total => `共 ${total} 个月，按新到旧` }} columns={monthEndCols} dataSource={[...s.sources.position.data.monthEnd].reverse()} scroll={{ x: 800 }} /> : null}
          </BlockCard>
          {s.sources.ratio.state === "ready" || s.sources.ratio.state === "insufficient" ? (
            <BlockCard title="库存占比按月" block={s.sources.ratio}>
              {s.sources.ratio.data ? <Table<RatioMonthRow> rowKey="yearMonth" size="small" pagination={{ pageSize: 6, showSizeChanger: false, hideOnSinglePage: true, showTotal: total => `共 ${total} 个月，按新到旧` }} columns={ratioCols} dataSource={[...s.sources.ratio.data.rows].sort((a, b) => b.yearMonth.localeCompare(a.yearMonth))} scroll={{ x: 900 }} /> : null}
            </BlockCard>
          ) : null}
          <BlockCard title="数据来源状态" block={s.sources.dataSources} extra={<a href="/admin/health">运维面板 →</a>}>
            {s.sources.dataSources.data ? <Table<SourceStatusRow> rowKey="key" size="small" pagination={false} columns={srcCols} dataSource={s.sources.dataSources.data} scroll={{ x: 900 }} /> : null}
          </BlockCard>
        </Space>
      ) : null}

      {tab === "alerts" && s ? (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Card size="small" title="今天必须处理">
            {redline.length === 0 ? (
              <Typography.Text type="secondary">当前没有需要今天处理的例外。</Typography.Text>
            ) : (
              <Space wrap>
                {redline.map((r: RedlineItem) => (
                  <a key={r.key} href={r.href}>
                    <Tag color={r.severity === "critical" ? "error" : r.severity === "high" ? "warning" : "processing"} style={{ padding: "4px 10px", fontSize: 13 }}>
                      {r.label} {r.count}
                    </Tag>
                  </a>
                ))}
              </Space>
            )}
          </Card>
          <Row gutter={[12, 12]}>
            <Col xs={24} xl={14}>
              <BlockCard title="库存预警表（按主预警优先级）" block={s.alerts.inventoryAlerts} extra={<a href="/inventory/alerts?tab=cover">全部 →</a>}>
                {s.alerts.inventoryAlerts.data ? (<>
                  <Space size={12} wrap style={{ marginBottom: 6 }}>
                    <CountLink label="断货" value={s.alerts.inventoryAlerts.data.totals.outOfStock} href={inventoryCoverMetricHref("outOfStock")} />
                    <CountLink label="低于阈值" value={s.alerts.inventoryAlerts.data.totals.alert} href={inventoryCoverMetricHref("alert")} />
                    <CountLink label="关注" value={s.alerts.inventoryAlerts.data.totals.watch} href={inventoryCoverMetricHref("watch")} />
                  </Space>
                  <Table<InventoryAlertRow> rowKey="skuId" size="small" pagination={false} scroll={{ x: 900 }} dataSource={s.alerts.inventoryAlerts.data.rows} columns={[
                    { title: "SKU", dataIndex: "code", width: 130, fixed: "left" },
                    { title: "等级", dataIndex: "tier", width: 56, render: (v: string | null) => v ? <Tag color={v === "S" ? "red" : v === "A" ? "orange" : v === "B" ? "gold" : "default"}>{v}</Tag> : "—" },
                    { title: "日销", dataIndex: "primaryDaily", align: "right", width: 70, render: (v: number | null, r) => v == null ? "—" : `${v}${r.primaryDailySource === "external" ? "*" : ""}` },
                    { title: "在库", dataIndex: "onHand", align: "right", width: 80, render: (v: string) => formatCount(v) },
                    { title: "可销", dataIndex: "coverDays", align: "right", width: 70, sorter: (a, b) => (a.coverDays ?? Number.MAX_SAFE_INTEGER) - (b.coverDays ?? Number.MAX_SAFE_INTEGER), render: (v: number | null) => v == null ? "—" : `${v}d` },
                    { title: "阈值", dataIndex: "alertDays", align: "right", width: 60, render: (v: number) => `${v}d` },
                    { title: "主预警", dataIndex: "primary", width: 90, render: (v: string | null) => v ? <Tag color={v === "out_of_stock" ? "error" : v === "spike" ? "magenta" : "warning"}>{v === "out_of_stock" ? "断货" : v === "spike" ? "爆单" : "低于阈值"}</Tag> : "—" },
                    { title: "动作", key: "a", width: 100, render: (_, r) => <Space size={6}><a href={r.actions.transfer}>调拨</a><a href={r.actions.replenish}>补货</a></Space> },
                  ]} />
                  <TruncNote shown={s.alerts.inventoryAlerts.data.rows.length} total={s.alerts.inventoryAlerts.data.alertRowCount} href="/inventory/alerts?tab=cover" />
                </>) : null}
              </BlockCard>
            </Col>
            <Col xs={24} xl={10}>
              <BlockCard title="爆单预警" block={s.alerts.salesSpike} extra={<a href="/inventory/alerts?tab=spike">全部 →</a>}>
                {s.alerts.salesSpike.data ? (<>
                  <Typography.Text type="secondary">
                    已映射 <a href="/inventory/alerts?tab=spike">{s.alerts.salesSpike.data.hitCount}</a> · 未映射 <a href="/inventory/alerts?tab=spike">{s.alerts.salesSpike.data.unmappedCount}</a> · 未知悉 <a href="/alerts?category=sales_spike&acked=0">{s.alerts.salesSpike.data.unacked}</a>
                  </Typography.Text>
                  <Table<SpikeHit> rowKey={(r) => `${r.kind}:${r.skuId ?? r.platformSkuId}:${r.shopName}`} size="small" pagination={false} dataSource={[...s.alerts.salesSpike.data.hits, ...s.alerts.salesSpike.data.unmappedHits].slice(0, 10)} columns={[
                    { title: "SKU / 平台 SKU", key: "k", render: (_, r) => r.kind === "sku" ? r.code : <span><Tag color="blue">未映射</Tag>{r.platformSkuId}</span> },
                    { title: "近 3 日", key: "d", render: (_, r) => r.days.map((d) => formatQty(d.qty)).join("/") },
                    { title: "涨幅", dataIndex: "risePct", align: "right", width: 80, sorter: (a, b) => Number(a.risePct ?? 0) - Number(b.risePct ?? 0), render: (v: string | null) => v == null ? "—" : `+${v}%` },
                  ]} />
                  <TruncNote shown={Math.min(10, s.alerts.salesSpike.data.hitCount + s.alerts.salesSpike.data.unmappedCount)} total={s.alerts.salesSpike.data.hitCount + s.alerts.salesSpike.data.unmappedCount} href="/inventory/alerts?tab=spike" />
                </>) : null}
              </BlockCard>
            </Col>
          </Row>
          <BlockCard title="订单系统（已下单 / 金额 / 订单至交付 / 成本下降）" block={s.alerts.orders} extra={<a href="/report/purchase-orders">采购订单指标 →</a>}>
            {s.alerts.orders.data ? (
              <Row gutter={[12, 12]}>
                <Col xs={12} lg={6}><a href="/report/purchase-orders?dim=month"><Statistic title="本月已下单" value={s.alerts.orders.data.orderSystem.monthPoCount} suffix="单" /></a><Typography.Text type="secondary">{formatCount(s.alerts.orders.data.orderSystem.monthOrderedBaseQty)} 件</Typography.Text></Col>
                <Col xs={12} lg={6}><a href="/report/purchase-orders?dim=month"><Statistic title="已下单金额（未税）" value={s.alerts.orders.data.orderSystem.monthNetAmount == null ? "无权限 / 无数据" : formatYuan(s.alerts.orders.data.orderSystem.monthNetAmount)} /></a><Typography.Text type="secondary">含税 {s.alerts.orders.data.orderSystem.monthGrossAmount == null ? "—" : formatYuan(s.alerts.orders.data.orderSystem.monthGrossAmount)}</Typography.Text></Col>
                <Col xs={12} lg={6}><a href="/report/purchase-orders?dim=supplier"><Statistic title="订单 → 首批交付 P50" value={s.alerts.orders.data.orderSystem.cycleFirstP50 == null ? "样本不足" : `${s.alerts.orders.data.orderSystem.cycleFirstP50}d`} /></a><Typography.Text type="secondary">P90 {s.alerts.orders.data.orderSystem.cycleFirstP90 ?? "—"}d · n={s.alerts.orders.data.orderSystem.cycleSamples} · OTIF {s.alerts.orders.data.otifRatePct == null ? "不可评" : formatPct(s.alerts.orders.data.otifRatePct)}</Typography.Text></Col>
                <Col xs={12} lg={6}><a href="/report/purchase-orders?dim=supplier"><Statistic title="成本下降 YTD" value={s.alerts.orders.data.costDown.savingYtd == null ? "无权限 / 无数据" : formatYuan(s.alerts.orders.data.costDown.savingYtd)} /></a><Typography.Text type="secondary">涨本另列 {s.alerts.orders.data.costDown.increaseYtd == null ? "—" : formatYuan(s.alerts.orders.data.costDown.increaseYtd)} · 可比行 {s.alerts.orders.data.costDown.comparableLines}</Typography.Text></Col>
              </Row>
            ) : null}
          </BlockCard>
        </Space>
      ) : null}

      {tab === "inventory" && s ? (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <BlockCard title="各地各仓库存明细" block={s.inventory.warehouses} extra={<a href="/inventory/position?tab=warehouses">全部 →</a>}>
            {s.inventory.warehouses.data ? (<>
              <Space size={16} wrap style={{ marginBottom: 8 }}>
                <CountLink label="启用仓" value={s.inventory.warehouses.data.activeCount} href="/inventory/position?tab=warehouses" />
                <CountLink label="实时仓" value={s.inventory.warehouses.data.realtimeCount} href="/inventory/warehouses" />
                <CountLink label="快照仓" value={s.inventory.warehouses.data.snapshotCount} href="/inventory/position?tab=warehouses" />
              </Space>
              <Table<WarehouseBlock> rowKey="warehouseId" size="small" pagination={false} columns={whCols} dataSource={s.inventory.warehouses.data.rows} scroll={{ x: 900 }} />
              <TruncNote shown={s.inventory.warehouses.data.rows.length} total={s.inventory.warehouses.data.rowCount} href="/inventory/position?tab=warehouses" unit="仓" />
            </>) : null}
          </BlockCard>
          <Row gutter={[12, 12]}>
            <Col xs={24} xl={8}>
              <BlockCard title="各仓周转 / 仓库数" block={s.inventory.turnover} extra={<a href="/inventory/warehouses">全部 →</a>}>
                {s.inventory.turnover.data ? (<>
                  <Space size={16} wrap>
                    <a href="/inventory/warehouses"><Statistic title="仓库" value={s.inventory.turnover.data.summary.warehouseCount} /></a>
                    <a href="/inventory/warehouses"><Statistic title="实时仓" value={s.inventory.turnover.data.summary.realtimeCount} /></a>
                    <a href="/inventory/warehouses"><Statistic title="实体启用仓" value={s.inventory.turnover.data.summary.physicalActiveCount} /></a>
                  </Space>
                  <Table<WarehouseInventoryRow> rowKey="warehouseId" size="small" pagination={false} dataSource={s.inventory.turnover.data.rows} columns={[
                    { title: "仓库", dataIndex: "name", ellipsis: true, fixed: "left" },
                    { title: "在库", dataIndex: "onHand", align: "right", width: 90, render: (v: string) => formatCount(v) },
                    { title: "周转", dataIndex: "turns", align: "right", width: 70, sorter: (a, b) => (a.turns ?? -1) - (b.turns ?? -1), render: (v: number | null) => v == null ? "—" : v.toFixed(1) },
                    { title: "DIO", dataIndex: "dio", align: "right", width: 70, sorter: (a, b) => (a.dio ?? -1) - (b.dio ?? -1), render: (v: number | null) => v == null ? "—" : `${Math.round(v)}d` },
                  ]} />
                  <TruncNote shown={s.inventory.turnover.data.rows.length} total={s.inventory.turnover.data.rowCount} href="/inventory/warehouses" unit="个实时仓" />
                </>) : null}
              </BlockCard>
            </Col>
            <Col xs={24} xl={16}>
              <BlockCard title="调拨线路（批次与均价）" block={s.inventory.transferLanes} extra={<a href="/inventory/transfer-routes">全部 →</a>}>
                {s.inventory.transferLanes.data ? (<>
                  <Table<TransferLaneRow> rowKey="laneKey" size="small" pagination={false} scroll={{ x: 800 }} dataSource={s.inventory.transferLanes.data.lanes} columns={[
                    { title: "线路", key: "l", fixed: "left", width: 200, render: (_, r) => `${r.fromWarehouse} → ${r.toWarehouse}` },
                    { title: "类型", dataIndex: "transferTypeLabel", width: 90 },
                    { title: "30 天单数", dataIndex: "docCount30", align: "right", width: 90, sorter: (a, b) => a.docCount30 - b.docCount30 },
                    { title: "Σ 件", dataIndex: "totalQty", align: "right", width: 90, render: (v: string) => formatCount(v) },
                    { title: "元 / 件", dataIndex: "avgUnitFee", align: "right", width: 90, render: (v: string | null) => v == null ? "—" : formatQty(v) },
                    { title: "n", dataIndex: "samples", align: "right", width: 50 },
                  ]} />
                  <TruncNote shown={s.inventory.transferLanes.data.lanes.length} total={s.inventory.transferLanes.data.summary.laneCount} href="/inventory/transfer-routes" unit="条线路" />
                </>) : null}
              </BlockCard>
            </Col>
          </Row>
          <BlockCard title="调拨异常 · 启动调拨计算" block={s.inventory.transferAnomalies} extra={<a href="/report/transfer-suggest">启动调拨计算 →</a>}>
            {s.inventory.transferAnomalies.data ? (<>
              <Space size={16} wrap>
                <CountLink label="异常" value={s.inventory.transferAnomalies.data.anomalyCount} href="/inventory/transfer-routes?tr_tab=anomalies" />
                <CountLink label="告警" value={s.inventory.transferAnomalies.data.alertCount} href="/inventory/transfer-routes?tr_tab=anomalies&an_level=alert" />
                <CountLink label="零散线路" value={s.inventory.transferAnomalies.data.scatteredLaneCount} href="/inventory/transfer-routes?ln_scattered=1" />
              </Space>
              <Table<TransferAnomalyRow> rowKey="docId" size="small" pagination={false} dataSource={s.inventory.transferAnomalies.data.rows} columns={[
                { title: "单号", dataIndex: "docNo", width: 160, fixed: "left", render: (v: string, r) => <a href={`/inventory/docs?docId=${r.docId}`}>{v}</a> },
                { title: "线路", key: "l", render: (_, r) => `${r.fromWarehouse} → ${r.toWarehouse}（${r.transferTypeLabel}）` },
                { title: "日期", dataIndex: "date", width: 100 },
                { title: "数量", dataIndex: "qty", align: "right", width: 90, render: (v: string) => formatCount(v) },
                { title: "元 / 件", dataIndex: "unitFee", align: "right", width: 90, render: (v: string | null) => v == null ? "—" : formatQty(v) },
              ]} />
              <TruncNote shown={s.inventory.transferAnomalies.data.rows.length} total={s.inventory.transferAnomalies.data.anomalyCount} href="/inventory/transfer-routes?tr_tab=anomalies" unit="条异常" />
            </>) : null}
          </BlockCard>
        </Space>
      ) : null}

      {tab === "ops" && s ? (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Row gutter={[12, 12]}>
            <Col xs={24} xl={14}>
              <BlockCard title="待办跟进进度" block={s.ops.todo} extra={<a href="/todo">查看全部待办 →</a>}>
                {s.ops.todo.data ? (<>
                  <Row gutter={[12, 12]}>
                    <Col xs={12} md={6}><a href="/todo?mine_status=active"><Statistic title="我的未完成" value={s.ops.todo.data.mine.open} /></a></Col>
                    <Col xs={12} md={6}><a href="/todo?mine_status=active&mine_overdue=1"><Statistic title="我的逾期" value={s.ops.todo.data.mine.overdue} valueStyle={{ color: s.ops.todo.data.mine.overdue ? "#B23A2E" : undefined }} /></a></Col>
                    <Col xs={12} md={6}><a href={todoCohortHref(s.ops.todo.data.month)}><Statistic title="本月创建·已完成" value={s.ops.todo.data.totals.doneThisMonth} /></a></Col>
                    <Col xs={12} md={6}><Statistic title="完成率" value={formatPct(s.ops.todo.data.totals.completionRate)} /></Col>
                  </Row>
                  <div style={{ marginTop: 8 }}>
                    {s.ops.todo.data.byRole.map((r) => (
                      <div key={r.role} style={{ fontSize: 12 }}>
                        <a href={`/todo?all_ownerRole=${r.role}`}>{roleLabel(r.role)}</a>：未完成 <a href={`/todo?all_ownerRole=${r.role}&all_status=active`}>{r.open}</a> · 逾期 <a href={`/todo?all_ownerRole=${r.role}&all_status=active&all_overdue=1`}>{r.overdue}</a> · 完成率 {formatPct(r.completionRate)}
                      </div>
                    ))}
                  </div>
                </>) : null}
              </BlockCard>
            </Col>
            <Col xs={24} xl={10}>
              <BlockCard title="等我处理" block={s.ops.queues}>
                {s.ops.queues.data ? (
                  <Row gutter={[12, 12]}>
                    <Col xs={12}><QueueStat title="待我审批" value={s.ops.queues.data.inboxPending} error={s.ops.queues.data.errors.inbox} href="/inbox" /></Col>
                    <Col xs={12}><QueueStat title="复核清单" value={s.ops.queues.data.reviewOpen} error={s.ops.queues.data.errors.review} href="/review/checklist" /></Col>
                  </Row>
                ) : null}
              </BlockCard>
            </Col>
          </Row>
          <BlockCard title="供应链目标（按部门）" block={s.ops.goals} extra={<a href="/goals">设置目标 →</a>}>
            {s.ops.goals.data ? (<>
              <Table<GoalRow> rowKey="id" size="small" pagination={false} scroll={{ x: 800 }} dataSource={s.ops.goals.data.rows} columns={[
                { title: "部门", dataIndex: "deptKey", width: 90, fixed: "left", render: (v: string) => <a href={`/goals?g_dept=${v}`}>{roleLabel(v)}</a> },
                { title: "指标", dataIndex: "metricLabel" },
                { title: "期间", dataIndex: "period", width: 90 },
                { title: "目标", dataIndex: "targetValue", align: "right", width: 90, render: (v: string, r) => `${formatQty(v)}${r.unit ?? ""}` },
                { title: "实际", dataIndex: "actualValue", align: "right", width: 90, render: (v: string | null, r) => v == null ? <Typography.Text type="secondary">{r.autoStatus === "withheld" ? "无权限" : r.autoStatus === "unavailable" ? "来源未就绪" : "未填"}</Typography.Text> : `${formatQty(v)}${r.unit ?? ""}` },
                { title: "达成", dataIndex: "attained", width: 100, sorter: (a, b) => Number(a.attainment ?? -1) - Number(b.attainment ?? -1), render: (v: boolean | null, r) => v == null ? "—" : <Tag color={v ? "success" : "warning"}>{v ? "达成" : "未达"}{r.attainment ? ` ${r.attainment}%` : ""}</Tag> },
                { title: "来源", key: "src", width: 110, render: (_, r) => { const k = goalSourceKey(r.actualSource, r.autoStatus); return <Tag color={GOAL_SOURCE[k].color}>{GOAL_SOURCE[k].label}</Tag>; } },
              ]} />
              <TruncNote shown={s.ops.goals.data.rows.length} total={s.ops.goals.data.rowCount} href="/goals" unit="项目标" />
            </>) : null}
          </BlockCard>
          <Row gutter={[12, 12]}>
            <Col xs={24} xl={12}>
              <Collapse
                size="small"
                items={[{
                  key: "survey",
                  label: <Space size={8}><span>调研结论（草案，待业务确认）</span><Tag color="warning">草案</Tag></Space>,
                  children: (
                    <div>
                      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                        以下为调研阶段的口头结论草案，尚未经业务方确认，不是系统测得的结论；确认后再转为正式决议登记。
                      </Typography.Paragraph>
                      {s.ops.conclusions.map((c, i) => (
                        <div key={i} style={{ padding: "4px 0" }}>{i + 1}. {c.text} <a href={c.evidenceHref}>{c.evidenceLabel} →</a></div>
                      ))}
                    </div>
                  ),
                }]}
              />
            </Col>
            <Col xs={24} xl={12}>
              <BlockCard title="数据质量（本周）" block={s.ops.dataQuality} extra={<a href="/import/data-quality">核对清单 →</a>}>
                {s.ops.dataQuality.data ? (<>
                  {s.ops.dataQuality.data.sources.map((src) => (
                    <div key={src.sourceClass} style={{ fontSize: 12, padding: "2px 0" }}>
                      <a href="/import/data-quality"><Typography.Text strong>{src.label}</Typography.Text></a>：覆盖至 {src.coverage.through ?? "—"} · 通过 {src.completeness.ok} / 拒收 {src.completeness.rejected} · 重复 {src.uniqueness.duplicates}
                    </div>
                  ))}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    <a href="/jobs/recon">对账一致率 {formatPct(s.ops.dataQuality.data.recon.rate)}（{s.ops.dataQuality.data.recon.matched}/{s.ops.dataQuality.data.recon.total}）</a>
                    {" · "}
                    <a href="/import/data-quality">快照跳变告警 {s.ops.dataQuality.data.snapshotQuality.alerts}</a>
                    {" · "}
                    <a href="/import/data-quality">销量一致性 {formatPct(s.ops.dataQuality.data.salesConsistency.consistencyPct)}</a>
                  </Typography.Text>
                </>) : null}
              </BlockCard>
            </Col>
          </Row>
        </Space>
      ) : null}

      {/* One mounted reader: parallel to the overview, retained across tabs, cleared on leave. */}
      <CockpitTrends screen={tab === "sources" ? "s1" : tab === "alerts" ? "s2" : tab === "inventory" ? "s3" : tab === "ops" ? "s4" : "channels"} />

      {data ? <Alert type="info" showIcon message={<div>{data.limitations.map((l) => <div key={l}>· {l}</div>)}</div>} /> : null}
    </Space>
  );
}
