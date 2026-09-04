"use client";

/**
 * B4 历史交期观察（记分卡页第五页签）：把简道云历史采购订单 → 入库观察算出来的
 * 「下单 → 收货」交期分布，与本系统自己学出来的 rollup_supplier_lead **并排**摆出来。
 *
 * 只消费读模型 supplier-lead-history/v1（authority=observation_only）。
 * 页面不提供任何「采纳」按钮——这条线只观察、不改主数据、不改预警阈值（对照见「阈值依据」列）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Card, Col, Row, Segmented, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { exportCsv } from "@/components/exportCsv";
import CaliberNote from "@/components/CaliberNote";
import { fetchJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import SearchInput from "@/components/SearchInput";
import { useListState } from "@/components/useListState";
import type {
  SupplierLeadHistory, SupplierLeadHistoryRow, SupplierSkuLeadHistoryRow,
} from "@/server/modules/report/supplier-lead-history";

const days = (v: number | null | undefined): string => (v == null ? "—" : `${v} 天`);
const pct = (v: number | null | undefined): string => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

/** 观察值统一挂「观察」标，避免与系统学习值混读 */
function Observed({ value, samples, min }: { value: number | null; samples: number; min: number }) {
  if (value == null) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Space size={4}>
      <span>{value} 天</span>
      <Tag color={samples >= min ? "blue" : "default"}>n={samples}{samples >= min ? "" : "·样本不足"}</Tag>
    </Space>
  );
}

export default function LeadHistoryTab() {
  const [model, setModel] = useState<SupplierLeadHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 本页签独立列表状态：URL 参数命名空间 lh_*（与 sc_/qc_/pv_/pt_ 互不干扰）
  const listState = useListState({
    key: "supplier-lead-history",
    paramPrefix: "lh",
    defaults: { q: "", grain: "supplier", mappedOnly: "" },
    defaultPageSize: 20,
  });
  const { filters, page, pageSize } = listState;
  const grain = filters.grain === "sku" ? "sku" : "supplier";
  const q = (filters.q ?? "").trim().toLowerCase();

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setLoadError(null);
    try {
      setModel(await fetchJson<SupplierLeadHistory>(`/api/report/supplier-lead-history${refresh ? "?refresh=1" : ""}`));
    } catch (e) {
      setModel(null);
      setLoadError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const supplierRows = useMemo(() => {
    const rows = model?.bySupplier ?? [];
    return q ? rows.filter((r) => r.supplierName.toLowerCase().includes(q) || (r.supplierCode ?? "").toLowerCase().includes(q)) : rows;
  }, [model, q]);
  const skuRows = useMemo(() => {
    const rows = model?.bySupplierSku ?? [];
    const mapped = filters.mappedOnly === "1" ? rows.filter((r) => r.skuId != null) : rows;
    return q
      ? mapped.filter((r) => r.productCode.toLowerCase().includes(q)
        || (r.skuCode ?? "").toLowerCase().includes(q)
        || (r.productName ?? "").toLowerCase().includes(q)
        || r.supplierName.toLowerCase().includes(q))
      : mapped;
  }, [model, q, filters.mappedOnly]);

  const total = grain === "supplier" ? supplierRows.length : skuRows.length;
  const pageSlice = <T,>(rows: T[]): T[] => rows.slice((page - 1) * pageSize, page * pageSize);
  const min = model?.minSamples ?? 3;

  const supplierColumns: ColumnsType<SupplierLeadHistoryRow> = [
    {
      title: "供应商", dataIndex: "supplierName", width: 220, fixed: "left",
      render: (v: string, r) => (
        <Space size={4}>
          <span>{v}</span>
          {r.supplierId == null ? <Tooltip title="源名称未解析到系统供应商主档；外部身份不自动认领"><Tag>未映射</Tag></Tooltip> : null}
        </Space>
      ),
    },
    { title: "供应商编码", dataIndex: "supplierCode", width: 130, render: (v: string | null) => v ?? "—" },
    { title: "观察订单", key: "orders", width: 120, align: "right", render: (_, r) => `${r.ordersWithReceipt} / ${r.orders}` },
    { title: "历史观察 P50", key: "p50", width: 150, render: (_, r) => <Observed value={r.observed.p50} samples={r.observed.samples} min={min} /> },
    { title: "历史观察 P90", key: "p90", width: 120, render: (_, r) => days(r.observed.p90) },
    { title: "历史观察 σ", key: "sd", width: 100, render: (_, r) => (r.observed.stdev == null ? "—" : `${r.observed.stdev}`) },
    {
      title: "历史准时率", key: "otr", width: 130,
      render: (_, r) => <Tooltip title={`仅统计有交货日期的 ${r.observed.promisedSamples} 个样本`}>{pct(r.observed.onTimeRate)}</Tooltip>,
    },
    { title: "平均延误", key: "delay", width: 110, align: "right", render: (_, r) => (r.observed.avgDelayDays == null ? "—" : `${r.observed.avgDelayDays} 天`) },
    {
      title: "系统学习（并列，不合并）", key: "sys", width: 220,
      render: (_, r) => (r.system
        ? <Tooltip title="rollup_supplier_lead 是（供应商 × SKU）粒度，分位数无法向上聚合，故供应商行只给对数/样本/加权准时率">
          <span>{r.system.pairs} 对 · n={r.system.samples} · 准时 {pct(r.system.onTimeRate)}</span>
        </Tooltip>
        : <Typography.Text type="secondary">系统无样本</Typography.Text>),
    },
    { title: "观察窗口", key: "win", width: 200, render: (_, r) => (r.firstReceiptDate ? `${r.firstReceiptDate} ~ ${r.lastReceiptDate}` : "—") },
  ];

  const skuColumns: ColumnsType<SupplierSkuLeadHistoryRow> = [
    { title: "供应商", dataIndex: "supplierName", width: 180, fixed: "left", ellipsis: true },
    {
      title: "商品编码", dataIndex: "productCode", width: 160,
      render: (v: string, r) => (
        <Space size={4}>
          <span>{r.skuCode ?? v}</span>
          {r.skuId == null ? <Tooltip title="源商品编码与 skus.code 不精确相等，未映射系统 SKU（不按名称猜）"><Tag>未映射</Tag></Tooltip> : null}
        </Space>
      ),
    },
    { title: "品名", key: "name", width: 200, ellipsis: true, render: (_, r) => r.skuName ?? r.productName ?? "—" },
    { title: "档案加工周期", dataIndex: "archiveLeadDays", width: 130, render: (v: number | null) => days(v) },
    {
      title: "系统学习 P90（rollup）", key: "sysp90", width: 180,
      render: (_, r) => (r.system ? <Observed value={r.system.p90} samples={r.system.samples} min={min} /> : <Typography.Text type="secondary">系统无样本</Typography.Text>),
    },
    { title: "历史观察 P50", key: "p50", width: 150, render: (_, r) => <Observed value={r.observed.p50} samples={r.observed.samples} min={min} /> },
    { title: "历史观察 P90", key: "p90", width: 120, render: (_, r) => days(r.observed.p90) },
    { title: "历史准时率", key: "otr", width: 110, render: (_, r) => pct(r.observed.onTimeRate) },
    {
      title: "阈值依据（阈值未因观察改变）", key: "basis", width: 340,
      render: (_, r) => (
        <span>
          {r.alertDays == null ? "—" : `${r.alertDays}d`}
          <br />
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>{r.alertBasis ?? "未映射系统 SKU，无阈值"}</Typography.Text>
        </span>
      ),
    },
    { title: "观察窗口", key: "win", width: 200, render: (_, r) => (r.firstReceiptDate ? `${r.firstReceiptDate} ~ ${r.lastReceiptDate}` : "—") },
  ];

  return (
    <div>
      <CaliberNote
        summary={<>
          历史采购订单 → 采购入库的<b>只读观察</b>交期（简道云归档）：与系统自己学到的交期<b>并列展示、绝不合并</b>，
          也<b>不改预警阈值、不写档案</b>。
          {model ? <>　配对 <b>{model.totals.ordersWithReceipt}</b>/{model.totals.orders} 单（{model.totals.matchRatePct ?? "—"}%），
            {model.totals.suppliers} 家供应商、{model.totals.skuPairs} 个供应商×商品组合（已映射 {model.totals.skuPairsMapped}）。</> : null}
        </>}
        detail={<div>{(model?.limitations ?? []).map((n, i) => <p key={i}>{n}</p>)}{model ? <p>{model.gate}</p> : null}</div>}
      />
      {model && model.state !== "ready" ? (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="历史交期观察不可用" description={model.gate} />
      ) : null}
      <Row gutter={[10, 10]} style={{ marginBottom: 12 }}>
        <Col xs={12} xl={5}><Card size="small"><Statistic title="交期样本" value={model?.totals.samples ?? "—"} suffix={model ? `/ ${model.totals.orders} 单` : undefined} /></Card></Col>
        <Col xs={12} xl={5}><Card size="small"><Statistic title="覆盖供应商" value={model?.totals.suppliers ?? "—"} suffix={model ? `（已映射 ${model.totals.suppliersMapped}）` : undefined} /></Card></Col>
        <Col xs={12} xl={5}><Card size="small"><Statistic title="供应商×商品组合" value={model?.totals.skuPairs ?? "—"} suffix={model ? `（已映射 ${model.totals.skuPairsMapped}）` : undefined} /></Card></Col>
        <Col xs={12} xl={9}>
          <Card size="small">
            <Typography.Text type="secondary">
              观察窗口 {model?.sourceAsOf ? `源数据截至 ${model.sourceAsOf}` : "源数据日期未知"}；
              authority = observation_only，只作对照，不进补货数量（D55）。
            </Typography.Text>
          </Card>
        </Col>
      </Row>
      <ListToolbar
        state={listState}
        onExport={model ? () => (grain === "supplier"
          ? exportCsv("历史交期观察-供应商", ["供应商", "供应商编码", "已映射", "配对订单", "订单数", "观察P50", "观察P90", "观察σ", "观察准时率", "平均延误", "系统对数", "系统样本", "系统准时率", "最早收货", "最晚收货"],
            supplierRows.map((r) => [r.supplierName, r.supplierCode, r.supplierId != null ? "是" : "否", r.ordersWithReceipt, r.orders, r.observed.p50, r.observed.p90, r.observed.stdev, r.observed.onTimeRate, r.observed.avgDelayDays, r.system?.pairs ?? null, r.system?.samples ?? null, r.system?.onTimeRate ?? null, r.firstReceiptDate, r.lastReceiptDate]))
          : exportCsv("历史交期观察-供应商x商品", ["供应商", "商品编码", "系统SKU", "品名", "档案加工周期", "系统学习P50", "系统学习P90", "系统样本", "观察P50", "观察P90", "观察样本", "观察准时率", "阈值", "阈值依据", "最早收货", "最晚收货"],
            skuRows.map((r) => [r.supplierName, r.productCode, r.skuCode, r.skuName ?? r.productName, r.archiveLeadDays, r.system?.p50 ?? null, r.system?.p90 ?? null, r.system?.samples ?? null, r.observed.p50, r.observed.p90, r.observed.samples, r.observed.onTimeRate, r.alertDays, r.alertBasis, r.firstReceiptDate, r.lastReceiptDate]))) : undefined}
        extra={
          <>
            <Segmented
              size="small"
              value={grain}
              onChange={(v) => listState.setFilter({ grain: String(v) })}
              options={[{ label: "按供应商", value: "supplier" }, { label: "按供应商 × 商品", value: "sku" }]}
            />
            {grain === "sku" ? (
              <Segmented
                size="small"
                value={filters.mappedOnly === "1" ? "1" : ""}
                onChange={(v) => listState.setFilter({ mappedOnly: String(v) })}
                options={[{ label: "全部", value: "" }, { label: "只看已映射 SKU", value: "1" }]}
              />
            ) : null}
            <SearchInput
              allowClear
              size="small"
              placeholder={grain === "supplier" ? "搜索供应商" : "搜索商品编码/品名/供应商"}
              style={{ width: 220 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
          </>
        }
      />
      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="历史交期观察" />
      {grain === "supplier" ? (
        <Table<SupplierLeadHistoryRow>
          rowKey="supplierKey"
          size={listState.tableSize}
          columns={supplierColumns}
          dataSource={pageSlice(supplierRows)}
          loading={loading}
          scroll={{ x: "max-content" }}
          pagination={listState.paginationProps({ total, showTotal: (t) => `共 ${t} 家供应商` })}
          locale={{ emptyText: loadError ? "数据未加载" : "历史采购观察里没有可配对的交期样本" }}
        />
      ) : (
        <Table<SupplierSkuLeadHistoryRow>
          rowKey="key"
          size={listState.tableSize}
          columns={skuColumns}
          dataSource={pageSlice(skuRows)}
          loading={loading}
          scroll={{ x: "max-content" }}
          pagination={listState.paginationProps({ total, showTotal: (t) => `共 ${t} 个组合` })}
          locale={{ emptyText: loadError ? "数据未加载" : "没有可配对到商品编码的交期样本" }}
        />
      )}
    </div>
  );
}
