"use client";

/**
 * 驾驶舱四屏（D50）。每屏一个视口、例外优先；每块显示来源·时点·覆盖·限制；
 * 无数据/无权限/待接入/样本不足各有空态，绝不显示 0。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, App, Button, Card, Col, Empty, Row, Space, Statistic, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import type { Block, CockpitData, RedlineItem, SourceStatusRow } from "@/server/modules/report/cockpit";
import type { MonthEndPoint, WarehouseBlock } from "@/server/modules/report/inventory-position";
import type { RatioMonthRow } from "@/server/modules/report/inventory-sales-ratio";
import type { InventoryAlertRow } from "@/server/modules/report/inventory-alerts";
import type { SpikeHit } from "@/server/modules/report/sales-spike";
import type { TransferAnomalyRow, TransferLaneRow } from "@/server/modules/report/transfer-routes";
import type { WarehouseInventoryRow } from "@/server/modules/report/warehouse-inventory";
import type { GoalRow } from "@/server/modules/goals/service";

const TABS = [
  { key: "sources", label: "数据来源与总量" },
  { key: "alerts", label: "预警" },
  { key: "inventory", label: "库存管控" },
  { key: "ops", label: "日常事务" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

function yuan(v: string | null | undefined): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 10_000) return `¥${(n / 10_000).toFixed(1)}万`;
  return `¥${n.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`;
}
function qty(v: string | null | undefined): string {
  if (v == null) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("zh-CN", { maximumFractionDigits: 0 }) : "—";
}
function pct(v: number | null | undefined, suffix = "%"): string {
  return v == null ? "—" : `${v}${suffix}`;
}

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
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={
          block.state === "pending_domain" ? `待接入：${block.note}`
            : block.state === "no_access" ? block.note
            : block.state === "insufficient" ? `暂无可用数据：${block.note}`
            : `读取失败：${block.note}`
        } />
      )}
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
        来源：{block.source.source}{block.source.asOf ? ` · 时点 ${String(block.source.asOf).replace("T", " ").slice(0, 16)}` : ""}{block.state === "ready" && block.note ? ` · ${block.note}` : ""}
      </Typography.Paragraph>
    </Card>
  );
}

export default function CockpitClient() {
  const { message } = App.useApp();
  const router = useRouter();
  const sp = useSearchParams();
  const tab = (TABS.some((t) => t.key === sp.get("tab")) ? sp.get("tab") : "sources") as TabKey;
  const [data, setData] = useState<CockpitData | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await fetchJson<CockpitData>("/api/report/cockpit")); }
    catch (e) { message.error((e as Error).message); }
    finally { setLoading(false); }
  }, [message]);
  useEffect(() => { if (!data) void load(); }, [data, load]);

  const setTab = (key: string) => {
    const q = new URLSearchParams(sp.toString()); q.set("tab", key);
    router.replace(`/cockpit?${q.toString()}`);
  };

  const monthEndCols: ColumnsType<MonthEndPoint> = useMemo(() => [
    { title: "月份", dataIndex: "yearMonth", width: 90, render: (v: string, r) => <span>{v}{r.isCurrent ? <Tag style={{ marginLeft: 6 }}>当月</Tag> : null}</span> },
    { title: "月末在库", key: "q", align: "right", render: (_, r) => r.total ? qty(r.total.qty) : <Typography.Text type="secondary">未补录</Typography.Text> },
    { title: "环比", dataIndex: "momQtyPct", align: "right", width: 90, render: (v: number | null) => v == null ? "—" : <Typography.Text type={v < 0 ? "danger" : "success"}>{v > 0 ? "+" : ""}{v}%</Typography.Text> },
    { title: "月末金额", key: "v", align: "right", render: (_, r) => r.total ? <span>{yuan(r.total.value.amount)}{r.total.value.incomplete ? <Tag color="warning" style={{ marginLeft: 6 }}>覆盖 {pct(r.total.value.coveragePct)}</Tag> : null}</span> : "—" },
    { title: "环比", dataIndex: "momValuePct", align: "right", width: 90, render: (v: number | null) => v == null ? "—" : `${v > 0 ? "+" : ""}${v}%` },
    { title: "口径", key: "parts", render: (_, r) => r.total ? (r.total.parts.length < 2 ? <Tag color="warning">部分口径（{r.total.parts.join("+")}）</Tag> : "实时仓+快照仓") : "—" },
  ], []);

  const ratioCols: ColumnsType<RatioMonthRow> = useMemo(() => [
    { title: "月份", dataIndex: "yearMonth", width: 90 },
    { title: "月末库存金额", key: "inv", align: "right", render: (_, r) => r.inventoryMonthEnd ? yuan(r.inventoryMonthEnd.amount) : "—" },
    { title: "销售金额", key: "s", align: "right", render: (_, r) => r.salesAmount == null ? <Typography.Text type="secondary">未录入</Typography.Text> : <span>{yuan(r.salesAmount)} {r.salesSource === "prefill_observation" ? <Tag color="blue">观察预填</Tag> : <Tag>手工</Tag>}</span> },
    { title: "占比", dataIndex: "ratioMonthEndPct", align: "right", render: (v: number | null, r) => v == null ? "—" : <Tag color={r.band === "green" ? "success" : r.band === "red" ? "error" : r.band === "yellow" ? "warning" : "blue"}>{v}%</Tag> },
    { title: "月均版", dataIndex: "ratioAvgPct", align: "right", render: (v: number | null) => pct(v) },
    { title: "环比(pp)", dataIndex: "momPoints", align: "right", render: (v: number | null) => v == null ? "—" : `${v > 0 ? "+" : ""}${v}` },
    { title: "说明", dataIndex: "gate", ellipsis: true },
  ], []);

  const srcCols: ColumnsType<SourceStatusRow> = [
    { title: "来源", dataIndex: "label", width: 110 },
    { title: "状态", dataIndex: "state", width: 110, render: (v: string) => <Tag color={v === "operational" ? "success" : v === "observation" ? "blue" : v === "blocked" ? "error" : "default"}>{v === "operational" ? "正式" : v === "observation" ? "观察" : v === "blocked" ? "阻断" : "仅契约"}</Tag> },
    { title: "最近成功", dataIndex: "lastSuccessAt", width: 150, render: (v: string | null) => v ? String(v).replace("T", " ").slice(0, 16) : "—" },
    { title: "业务截止", dataIndex: "sourceAsOfEnd", width: 110, render: (v: string | null) => v ?? "—" },
    { title: "源行 / 落库", key: "rows", width: 130, align: "right", render: (_, r) => r.sourceRows == null ? "—" : `${qty(String(r.sourceRows))} / ${qty(String(r.stagedRows ?? 0))}` },
    { title: "流", key: "streams", width: 90, align: "right", render: (_, r) => `${r.successfulStreams ?? 0} / ${r.selectedContractCount}` },
    { title: "阻断 / 下一步", key: "gate", ellipsis: true, render: (_, r) => r.gate ?? r.nextAction ?? "—" },
  ];

  const whCols: ColumnsType<WarehouseBlock> = [
    { title: "地区", dataIndex: "regionCode", width: 70 },
    { title: "仓库", dataIndex: "name", ellipsis: true },
    { title: "类型", dataIndex: "mode", width: 80, render: (v: string) => v === "realtime" ? "实时" : "快照" },
    { title: "在库", dataIndex: "qty", align: "right", render: (v: string) => qty(v) },
    { title: "SKU", dataIndex: "skus", align: "right", width: 70 },
    { title: "金额", key: "v", align: "right", render: (_, r) => r.value ? <span>{yuan(r.value.amount)}{r.value.incomplete ? <Tag color="warning" style={{ marginLeft: 4 }}>{pct(r.value.coveragePct)}</Tag> : null}</span> : <Typography.Text type="secondary">无权限</Typography.Text> },
    { title: "周转", key: "t", width: 90, render: (_, r) => r.mode === "snapshot" ? <Typography.Text type="secondary">无流水</Typography.Text> : <Tag>待接入</Tag> },
    { title: "数据截止", key: "d", width: 110, render: (_, r) => r.mode === "realtime" ? "即时" : (r.bizDate ?? "—") },
  ];

  const s = data?.screens;
  const topbar = data?.topbar;

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Card size="small" bodyStyle={{ padding: "8px 12px" }}>
        <Space wrap size={[16, 4]}>
          <Typography.Text strong>驾驶舱四屏</Typography.Text>
          <Typography.Text type="secondary">角色：{topbar?.roleLabel ?? "—"}</Typography.Text>
          <Typography.Text type="secondary">{topbar?.scopeLabel ?? ""}</Typography.Text>
          <Typography.Text type="secondary">数据截止 {topbar?.dataAsOf ? String(topbar.dataAsOf).replace("T", " ").slice(0, 16) : "—"}</Typography.Text>
          <Typography.Text type="secondary">覆盖 成本 {pct(topbar?.valuationCoveragePct)} / 身份 {pct(topbar?.identityCoveragePct)}</Typography.Text>
          <Typography.Text type="secondary">口径 {topbar?.calibreVersion ?? "—"}</Typography.Text>
          <Button size="small" onClick={() => void load()} loading={loading}>刷新</Button>
          <a href="/admin/params">参数页 ↗</a>
        </Space>
      </Card>

      <Tabs activeKey={tab} onChange={setTab} items={TABS.map((t) => ({ key: t.key, label: t.label }))} />

      {tab === "sources" && s ? (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Row gutter={[12, 12]}>
            <Col xs={24} md={12} xl={6}>
              <BlockCard title="当月库存数量" block={s.sources.position} extra={<a href="/inventory/position?tab=daily">逐日 →</a>}>
                {s.sources.position.data ? (<>
                  <Statistic value={qty(s.sources.position.data.current.total.qty)} suffix="件" />
                  <Typography.Text type="secondary">本月入 +{qty(s.sources.position.data.monthToDate.inQty)} · 出 −{qty(s.sources.position.data.monthToDate.outQty)} · {s.sources.position.data.monthToDate.days} 天有账</Typography.Text>
                </>) : null}
              </BlockCard>
            </Col>
            <Col xs={24} md={12} xl={6}>
              <BlockCard title="当月库存金额" block={s.sources.position} extra={<a href="/inventory/position?tab=warehouses">各仓 →</a>}>
                {s.sources.position.data ? (<>
                  <Statistic value={yuan(s.sources.position.data.current.total.value.amount)} />
                  <Space size={6}>
                    {s.sources.position.data.current.total.value.incomplete ? <Tag color="warning">覆盖 {pct(s.sources.position.data.current.total.value.coveragePct)} 不完整</Tag> : <Tag color="success">覆盖 {pct(s.sources.position.data.current.total.value.coveragePct)}</Tag>}
                    <Typography.Text type="secondary">未计价 SKU {s.sources.position.data.current.total.value.uncoveredSkus}</Typography.Text>
                  </Space>
                </>) : null}
              </BlockCard>
            </Col>
            <Col xs={24} md={12} xl={6}>
              <BlockCard title="当月销售金额" block={s.sources.salesAmount} extra={s.sources.salesAmount.state !== "no_access" ? <a href="/inventory/position?tab=monthly">录入/修正 →</a> : null}>
                {s.sources.salesAmount.data ? (<>
                  <Statistic value={yuan(s.sources.salesAmount.data.salesAmount)} />
                  <Typography.Text type="secondary">{s.sources.salesAmount.data.yearMonth} · {s.sources.salesAmount.data.salesSource === "prefill_observation" ? "观察预填，待财务确认" : "财务手工值"}</Typography.Text>
                </>) : null}
              </BlockCard>
            </Col>
            <Col xs={24} md={12} xl={6}>
              <BlockCard title="库存占比" block={s.sources.ratio} extra={<a href="/admin/params">目标 →</a>}>
                {s.sources.ratio.data ? (<>
                  <Statistic value={pct(s.sources.ratio.data.current.ratioMonthEndPct)} valueStyle={{ color: s.sources.ratio.data.current.band === "green" ? "#0E6B4A" : s.sources.ratio.data.current.band === "red" ? "#B23A2E" : undefined }} />
                  <Typography.Text type="secondary">目标 {s.sources.ratio.data.target.low}–{s.sources.ratio.data.target.high}% · 基线 {s.sources.ratio.data.target.baseline}% · 月均版 {pct(s.sources.ratio.data.current.ratioAvgPct)} · 环比 {s.sources.ratio.data.current.momPoints == null ? "—" : `${s.sources.ratio.data.current.momPoints}pp`}</Typography.Text>
                </>) : null}
              </BlockCard>
            </Col>
          </Row>
          <BlockCard title="历史按月与环比" block={s.sources.position}>
            {s.sources.position.data ? <Table<MonthEndPoint> rowKey="yearMonth" size="small" pagination={false} columns={monthEndCols} dataSource={s.sources.position.data.monthEnd} scroll={{ x: 800 }} /> : null}
          </BlockCard>
          {s.sources.ratio.state === "ready" || s.sources.ratio.state === "insufficient" ? (
            <BlockCard title="库存占比按月" block={s.sources.ratio}>
              {s.sources.ratio.data ? <Table<RatioMonthRow> rowKey="yearMonth" size="small" pagination={false} columns={ratioCols} dataSource={s.sources.ratio.data.rows} scroll={{ x: 900 }} /> : null}
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
            <Space wrap>
              {s.alerts.redline.map((r: RedlineItem) => (
                <a key={r.key} href={r.href}>
                  <Tag color={r.count === 0 ? "default" : r.severity === "critical" ? "error" : r.severity === "high" ? "warning" : "processing"} style={{ padding: "4px 10px", fontSize: 13 }}>
                    {r.label} {r.count > 0 ? r.count : ""}
                  </Tag>
                </a>
              ))}
            </Space>
          </Card>
          <Row gutter={[12, 12]}>
            <Col xs={24} xl={14}>
              <BlockCard title="库存预警表（≤20 行，按主预警优先级）" block={s.alerts.inventoryAlerts} extra={<a href="/inventory/alerts?tab=cover">全部 →</a>}>
                {s.alerts.inventoryAlerts.data ? <Table<InventoryAlertRow> rowKey="skuId" size="small" pagination={false} scroll={{ x: 900 }} dataSource={s.alerts.inventoryAlerts.data.rows} columns={[
                  { title: "等级", dataIndex: "tier", width: 56, render: (v: string | null) => v ? <Tag color={v === "S" ? "red" : v === "A" ? "orange" : v === "B" ? "gold" : "default"}>{v}</Tag> : "—" },
                  { title: "SKU", dataIndex: "code", width: 130 },
                  { title: "日销", dataIndex: "primaryDaily", align: "right", width: 70, render: (v: number | null, r) => v == null ? "—" : `${v}${r.primaryDailySource === "external" ? "*" : ""}` },
                  { title: "在库", dataIndex: "onHand", align: "right", width: 80, render: (v: string) => qty(v) },
                  { title: "可销", dataIndex: "coverDays", align: "right", width: 70, render: (v: number | null) => v == null ? "—" : `${v}d` },
                  { title: "阈值", dataIndex: "alertDays", align: "right", width: 60, render: (v: number) => `${v}d` },
                  { title: "主预警", dataIndex: "primary", width: 90, render: (v: string | null) => v ? <Tag color={v === "out_of_stock" ? "error" : v === "spike" ? "magenta" : "warning"}>{v === "out_of_stock" ? "断货" : v === "spike" ? "爆单" : "低于阈值"}</Tag> : "—" },
                  { title: "动作", key: "a", width: 100, render: (_, r) => <Space size={6}><a href={r.actions.transfer}>调拨</a><a href={r.actions.replenish}>补货</a></Space> },
                ]} /> : null}
              </BlockCard>
            </Col>
            <Col xs={24} xl={10}>
              <BlockCard title="爆单预警" block={s.alerts.salesSpike} extra={<a href="/inventory/alerts?tab=spike">全部 →</a>}>
                {s.alerts.salesSpike.data ? (<>
                  <Typography.Text type="secondary">已映射 {s.alerts.salesSpike.data.hits.length} · 未映射 {s.alerts.salesSpike.data.unmappedHits.length} · 未知悉 {s.alerts.salesSpike.data.unacked}</Typography.Text>
                  <Table<SpikeHit> rowKey={(r) => `${r.kind}:${r.skuId ?? r.platformSkuId}:${r.shopName}`} size="small" pagination={false} dataSource={[...s.alerts.salesSpike.data.hits, ...s.alerts.salesSpike.data.unmappedHits].slice(0, 10)} columns={[
                    { title: "SKU / 平台 SKU", key: "k", render: (_, r) => r.kind === "sku" ? r.code : <span><Tag color="blue">未映射</Tag>{r.platformSkuId}</span> },
                    { title: "近 3 日", key: "d", render: (_, r) => r.days.map((d) => d.qty).join("/") },
                    { title: "涨幅", dataIndex: "risePct", align: "right", width: 80, render: (v: string | null) => v == null ? "—" : `+${v}%` },
                  ]} />
                </>) : null}
              </BlockCard>
            </Col>
          </Row>
          <BlockCard title="订单系统（已下单 / 金额 / 订单至交付 / 成本下降）" block={s.alerts.orders} extra={<a href="/report/purchase-orders">采购订单指标 →</a>}>
            {s.alerts.orders.data ? (
              <Row gutter={[12, 12]}>
                <Col xs={12} lg={6}><Statistic title="本月已下单" value={s.alerts.orders.data.orderSystem.monthPoCount} suffix="单" /><Typography.Text type="secondary">{qty(s.alerts.orders.data.orderSystem.monthOrderedBaseQty)} 件</Typography.Text></Col>
                <Col xs={12} lg={6}><Statistic title="已下单金额（未税）" value={s.alerts.orders.data.orderSystem.monthNetAmount == null ? "无权限 / 无数据" : yuan(s.alerts.orders.data.orderSystem.monthNetAmount)} /><Typography.Text type="secondary">含税 {s.alerts.orders.data.orderSystem.monthGrossAmount == null ? "—" : yuan(s.alerts.orders.data.orderSystem.monthGrossAmount)}</Typography.Text></Col>
                <Col xs={12} lg={6}><Statistic title="订单 → 首批交付 P50" value={s.alerts.orders.data.orderSystem.cycleFirstP50 == null ? "样本不足" : `${s.alerts.orders.data.orderSystem.cycleFirstP50}d`} /><Typography.Text type="secondary">P90 {s.alerts.orders.data.orderSystem.cycleFirstP90 ?? "—"}d · n={s.alerts.orders.data.orderSystem.cycleSamples} · OTIF {pct(s.alerts.orders.data.orderSystem.otifRate)}</Typography.Text></Col>
                <Col xs={12} lg={6}><Statistic title="成本下降 YTD" value={s.alerts.orders.data.costDown.savingYtd == null ? "无权限 / 无数据" : yuan(s.alerts.orders.data.costDown.savingYtd)} /><Typography.Text type="secondary">涨本另列 {s.alerts.orders.data.costDown.increaseYtd == null ? "—" : yuan(s.alerts.orders.data.costDown.increaseYtd)} · 可比行 {s.alerts.orders.data.costDown.comparableLines}</Typography.Text></Col>
              </Row>
            ) : null}
          </BlockCard>
        </Space>
      ) : null}

      {tab === "inventory" && s ? (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <BlockCard title="各地各仓库存明细" block={s.inventory.warehouses} extra={<a href="/inventory/position?tab=warehouses">全部 →</a>}>
            {s.inventory.warehouses.data ? (<>
              <Space size={16} style={{ marginBottom: 8 }}>
                <Typography.Text type="secondary">启用仓 {s.inventory.warehouses.data.activeCount}</Typography.Text>
                <Typography.Text type="secondary">实时仓 {s.inventory.warehouses.data.realtimeCount} · 快照仓 {s.inventory.warehouses.data.snapshotCount}</Typography.Text>
              </Space>
              <Table<WarehouseBlock> rowKey="warehouseId" size="small" pagination={false} columns={whCols} dataSource={s.inventory.warehouses.data.rows.slice(0, 20)} scroll={{ x: 900 }} />
            </>) : null}
          </BlockCard>
          <Row gutter={[12, 12]}>
            <Col xs={24} xl={8}>
              <BlockCard title="各仓周转 / 仓库数" block={s.inventory.turnover} extra={<a href="/inventory/warehouses">全部 →</a>}>
                {s.inventory.turnover.data ? (<>
                  <Space size={16} wrap><Statistic title="仓库" value={s.inventory.turnover.data.summary.warehouseCount} /><Statistic title="实时仓" value={s.inventory.turnover.data.summary.realtimeCount} /><Statistic title="实体启用仓" value={s.inventory.turnover.data.summary.physicalActiveCount} /></Space>
                  <Table<WarehouseInventoryRow> rowKey="warehouseId" size="small" pagination={false} dataSource={s.inventory.turnover.data.rows.filter((r) => r.accountingMode === "realtime").slice(0, 8)} columns={[
                    { title: "仓库", dataIndex: "name", ellipsis: true },
                    { title: "在库", dataIndex: "onHand", align: "right", width: 90, render: (v: string) => qty(v) },
                    { title: "周转", dataIndex: "turns", align: "right", width: 70, render: (v: number | null) => v == null ? "—" : v.toFixed(1) },
                    { title: "DIO", dataIndex: "dio", align: "right", width: 70, render: (v: number | null) => v == null ? "—" : `${Math.round(v)}d` },
                  ]} />
                </>) : null}
              </BlockCard>
            </Col>
            <Col xs={24} xl={16}>
              <BlockCard title="调拨线路（批次与均价）" block={s.inventory.transferLanes} extra={<a href="/inventory/transfer-routes">全部 →</a>}>
                {s.inventory.transferLanes.data ? <Table<TransferLaneRow> rowKey="laneKey" size="small" pagination={false} scroll={{ x: 800 }} dataSource={s.inventory.transferLanes.data.lanes} columns={[
                  { title: "线路", key: "l", render: (_, r) => `${r.fromWarehouse} → ${r.toWarehouse}` },
                  { title: "类型", dataIndex: "transferTypeLabel", width: 90 },
                  { title: "30 天单数", dataIndex: "docCount30", align: "right", width: 90 },
                  { title: "Σ 件", dataIndex: "totalQty", align: "right", width: 90, render: (v: string) => qty(v) },
                  { title: "元 / 件", dataIndex: "avgUnitFee", align: "right", width: 90, render: (v: string | null) => v == null ? "—" : v },
                  { title: "n", dataIndex: "samples", align: "right", width: 50 },
                ]} /> : null}
              </BlockCard>
            </Col>
          </Row>
          <BlockCard title="调拨异常 · 启动调拨计算" block={s.inventory.transferAnomalies} extra={<a href="/report/transfer-suggest">启动调拨计算 →</a>}>
            {s.inventory.transferAnomalies.data ? (<>
              <Typography.Text type="secondary">异常 {s.inventory.transferAnomalies.data.anomalyCount} · 告警 {s.inventory.transferAnomalies.data.alertCount} · 零散线路 {s.inventory.transferAnomalies.data.scatteredLaneCount}</Typography.Text>
              <Table<TransferAnomalyRow> rowKey="docId" size="small" pagination={false} dataSource={s.inventory.transferAnomalies.data.rows} columns={[
                { title: "单号", dataIndex: "docNo", width: 130 },
                { title: "线路", key: "l", render: (_, r) => `${r.fromWarehouse} → ${r.toWarehouse}（${r.transferTypeLabel}）` },
                { title: "日期", dataIndex: "date", width: 100 },
                { title: "数量", dataIndex: "qty", align: "right", width: 90, render: (v: string) => qty(v) },
                { title: "元 / 件", dataIndex: "unitFee", align: "right", width: 90, render: (v: string | null) => v == null ? "—" : v },
              ]} />
            </>) : null}
          </BlockCard>
        </Space>
      ) : null}

      {tab === "ops" && s ? (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Row gutter={[12, 12]}>
            <Col xs={24} xl={14}>
              <BlockCard title="待办跟进进度" block={s.ops.todo} extra={<a href="/todo">全部待办 →</a>}>
                {s.ops.todo.data ? (<>
                  <Row gutter={12}>
                    <Col span={6}><Statistic title="我的未完成" value={s.ops.todo.data.mine.open} /></Col>
                    <Col span={6}><Statistic title="我的逾期" value={s.ops.todo.data.mine.overdue} valueStyle={{ color: s.ops.todo.data.mine.overdue ? "#B23A2E" : undefined }} /></Col>
                    <Col span={6}><Statistic title="本月完成" value={s.ops.todo.data.totals.doneThisMonth} /></Col>
                    <Col span={6}><Statistic title="完成率" value={pct(s.ops.todo.data.totals.completionRate)} /></Col>
                  </Row>
                  <div style={{ marginTop: 8 }}>{s.ops.todo.data.byRole.map((r) => <div key={r.role} style={{ fontSize: 12 }}>{r.role}：未完成 {r.open} · 逾期 {r.overdue} · 完成率 {pct(r.completionRate)}</div>)}</div>
                </>) : null}
              </BlockCard>
            </Col>
            <Col xs={24} xl={10}>
              <BlockCard title="等我处理" block={s.ops.queues}>
                {s.ops.queues.data ? (
                  <Row gutter={12}>
                    <Col span={12}><a href="/inbox"><Statistic title="待我审批" value={s.ops.queues.data.inboxPending} /></a></Col>
                    <Col span={12}><a href="/review/checklist"><Statistic title="复核清单" value={s.ops.queues.data.reviewOpen} /></a></Col>
                  </Row>
                ) : null}
              </BlockCard>
            </Col>
          </Row>
          <BlockCard title="供应链目标（按部门）" block={s.ops.goals} extra={<a href="/goals">设置目标 →</a>}>
            {s.ops.goals.data ? <Table<GoalRow> rowKey="id" size="small" pagination={false} dataSource={s.ops.goals.data.rows.slice(0, 12)} columns={[
              { title: "部门", dataIndex: "deptKey", width: 90 },
              { title: "指标", dataIndex: "metricLabel" },
              { title: "期间", dataIndex: "period", width: 90 },
              { title: "目标", dataIndex: "targetValue", align: "right", width: 90, render: (v: string, r) => `${v}${r.unit ?? ""}` },
              { title: "实际", dataIndex: "actualValue", align: "right", width: 90, render: (v: string | null, r) => v == null ? <Typography.Text type="secondary">{r.autoStatus === "unavailable" ? "来源未就绪" : "未填"}</Typography.Text> : `${v}${r.unit ?? ""}` },
              { title: "达成", dataIndex: "attained", width: 80, render: (v: boolean | null, r) => v == null ? "—" : <Tag color={v ? "success" : "warning"}>{v ? "达成" : "未达"}{r.attainment ? ` ${r.attainment}` : ""}</Tag> },
              { title: "来源", dataIndex: "actualSource", width: 70, render: (v: string | null) => v ?? "—" },
            ]} /> : null}
          </BlockCard>
          <Row gutter={[12, 12]}>
            <Col xs={24} xl={12}>
              <Card size="small" title="调研数据 / 结论">
                {s.ops.conclusions.map((c, i) => (
                  <div key={i} style={{ padding: "4px 0" }}>{i + 1}. {c.text} <a href={c.evidenceHref}>{c.evidenceLabel} →</a></div>
                ))}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>措辞以 CURRENT.md 决议登记为准，待业务确认</Typography.Text>
              </Card>
            </Col>
            <Col xs={24} xl={12}>
              <BlockCard title="数据质量（本周）" block={s.ops.dataQuality} extra={<a href="/import/data-quality">核对清单 →</a>}>
                {s.ops.dataQuality.data ? (<>
                  {s.ops.dataQuality.data.sources.map((src) => (
                    <div key={src.sourceClass} style={{ fontSize: 12, padding: "2px 0" }}>
                      <Typography.Text strong>{src.label}</Typography.Text>：覆盖至 {src.coverage.through ?? "—"} · 通过 {src.completeness.ok} / 拒收 {src.completeness.rejected} · 重复 {src.uniqueness.duplicates}
                    </div>
                  ))}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>对账一致率 {pct(s.ops.dataQuality.data.recon.rate)}（{s.ops.dataQuality.data.recon.matched}/{s.ops.dataQuality.data.recon.total}）· 快照跳变告警 {s.ops.dataQuality.data.snapshotQuality.alerts} · 销量一致性 {pct(s.ops.dataQuality.data.salesConsistency.consistencyPct)}</Typography.Text>
                </>) : null}
              </BlockCard>
            </Col>
          </Row>
        </Space>
      ) : null}

      {data ? <Alert type="info" showIcon message={<div>{data.limitations.map((l) => <div key={l}>· {l}</div>)}</div>} /> : null}
    </Space>
  );
}
