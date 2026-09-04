"use client";

/**
 * 周期主数据补录工作台（IAL-06 / FS-R6）：加工 / 采购 / 在途周期、MOQ、成本有无，按分层筛缺失维度，行内补录。
 * 写规则：只允许填空；覆盖非空值须 pmc/admin（采购只能补空）。每次保存留审计。
 * 可编辑列以服务端下发的 row.leadFields 为准（master/sku-supply-params-fill.leadFieldsFor 唯一口径：
 * 成品/半成品 = 加工 + 在途；原料/包材 = 采购），前端不另行按类型判定。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Col, InputNumber, Progress, Row, Select, Space, Statistic, Switch, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import CaliberNote from "@/components/CaliberNote";
import { exportCsv } from "@/components/exportCsv";
import { fetchJson, patchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import RemoteSelect from "@/components/RemoteSelect";
import SearchInput from "@/components/SearchInput";
import SkuHoverCard from "@/components/SkuHoverCard";
import { useListState } from "@/components/useListState";
import { SUPPLY_PARAMS_CSV_HEADERS } from "@/lib/supply-params-csv";
import BulkFillModal, { type BulkScope } from "./bulk-fill-modal";

type Tier = "S" | "A" | "B" | "C";
type Dim = "production" | "logistics" | "purchase" | "moq" | "cost";
type LeadField = "normalLeadDays" | "logisticsLeadDays" | "purchaseLeadDays";

interface Row {
  skuId: number;
  code: string;
  name: string;
  skuType: string;
  brand: string | null;
  brandId: number | null;
  tier: Tier | null;
  normalLeadDays: number | null;
  logisticsLeadDays: number | null;
  purchaseLeadDays: number | null;
  /** 该类型适用/可编辑的周期字段（服务端唯一口径） */
  leadFields: LeadField[];
  moq: string | null;
  hasCost: boolean;
  missing: Dim[];
  blocked: boolean;
}

interface Data {
  rows: Row[];
  total: number;
  policyPeriod: string | null;
  /** 运行参数里的缺省周期（D57）——「套用默认」预填它，页面不另写字面量 */
  defaults: { production: number; logistics: number };
  summary: {
    scanned: number;
    complete: number;
    byDimension: Record<Dim, number>;
    blocked: number;
    byTier: Record<Tier | "unclassified", { total: number; complete: number; blocked: number }>;
  };
  dimLabels: Record<Dim, string>;
}

const TYPE_LABELS: Record<string, string> = { finished: "成品", semi: "半成品", raw: "原料", packaging: "包材" };
const TIER_COLORS: Record<Tier, string> = { S: "magenta", A: "red", B: "orange", C: "default" };

export default function SupplyParamsClient({ canOverride }: { canOverride: boolean }) {
  const { message } = App.useApp();
  const listState = useListState({
    key: "master-supply-params",
    defaults: { q: "", skuType: "", missing: "any", tier: "", brandId: "", blockedOnly: "" },
    defaultPageSize: 50,
  });
  const { filters, page, pageSize } = listState;
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, number | null>>({});
  const [saving, setSaving] = useState<number | null>(null);
  /* 批量补录（#1）：勾选行 → 批量填写；当前筛选 → 按分层/品牌套用默认 */
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulk, setBulk] = useState<{ scope: BulkScope; label: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ q: filters.q, page: String(page), pageSize: String(pageSize) });
      if (filters.skuType) params.set("skuType", filters.skuType);
      if (filters.missing) params.set("missing", filters.missing);
      if (filters.tier) params.set("tier", filters.tier);
      if (filters.brandId) params.set("brandId", filters.brandId);
      if (filters.blockedOnly === "1") params.set("blockedOnly", "1");
      setData(await fetchJson<Data>(`/api/master/supply-params?${params.toString()}`));
      setEdits({});
      setSelectedIds([]);
    } catch (e) {
      setData(null);
      setLoadError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [filters.q, filters.skuType, filters.missing, filters.tier, filters.brandId, filters.blockedOnly, page, pageSize]);
  useEffect(() => { void load(); }, [load]);

  const editKey = (skuId: number, f: LeadField) => `${skuId}:${f}`;

  const save = async (r: Row) => {
    const body: Partial<Record<LeadField, number | null>> = {};
    for (const f of r.leadFields) {
      const k = editKey(r.skuId, f);
      if (k in edits && edits[k] !== r[f]) body[f] = edits[k];
    }
    if (Object.keys(body).length === 0) return;
    setSaving(r.skuId);
    try {
      const res = await patchJson<{ action: "fill" | "override" }>(`/api/master/sku/${r.skuId}/supply-params`, body);
      message.success(`${r.code} 已${res.action === "override" ? "覆盖" : "补录"}`);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const cell = (r: Row, f: LeadField, applicable: boolean) => {
    if (!applicable) return <Typography.Text type="secondary">不适用</Typography.Text>;
    const k = editKey(r.skuId, f);
    const current = r[f];
    const locked = current != null && !canOverride;
    return (
      <Tooltip title={locked ? "已有值，只有生产计划/管理员可覆盖" : current == null ? "空值：可直接补录" : "覆盖已有值将留审计"}>
        <InputNumber
          size="small"
          min={0}
          max={365}
          precision={0}
          value={k in edits ? edits[k] : current}
          disabled={locked}
          status={current == null && !(k in edits) ? "warning" : undefined}
          onChange={(v) => setEdits((e) => ({ ...e, [k]: v == null ? null : Number(v) }))}
          style={{ width: 90 }}
        />
      </Tooltip>
    );
  };


  /**
   * 导出当前筛选（#2 的上半段）：业务要线下补一批周期，先得拿到一张按现有口径填好的表。
   * 列与 `@/lib/supply-params-csv` 的导入表头**同一份常量**——导出的表原样填完就能导回来。
   * 服务端单页上限 500，这里按页取完整个筛选集；超过 EXPORT_MAX_ROWS 的部分显式写明截断，
   * 绝不给出一份「看起来完整」的残缺 CSV。
   */
  const EXPORT_MAX_ROWS = 5000;
  const blockedReason = (r: Row): string => {
    if (!r.blocked) return "";
    const miss = r.missing.filter((d) => d === "production" || d === "logistics").map((d) => data?.dimLabels[d] ?? d);
    return `S/A/B 缺${miss.join("、")}`;
  };
  const doExport = async () => {
    setExporting(true);
    try {
      const collected: Row[] = [];
      let total = 0;
      for (let p = 1; ; p++) {
        const params = new URLSearchParams({ q: filters.q, page: String(p), pageSize: "500" });
        if (filters.skuType) params.set("skuType", filters.skuType);
        if (filters.missing) params.set("missing", filters.missing);
        if (filters.tier) params.set("tier", filters.tier);
        if (filters.brandId) params.set("brandId", filters.brandId);
        if (filters.blockedOnly === "1") params.set("blockedOnly", "1");
        const chunk = await fetchJson<Data>(`/api/master/supply-params?${params.toString()}`);
        total = chunk.total;
        collected.push(...chunk.rows);
        if (collected.length >= chunk.total || chunk.rows.length === 0 || collected.length >= EXPORT_MAX_ROWS) break;
      }
      exportCsv(
        `周期主数据-${new Date().toISOString().slice(0, 10)}.csv`,
        [...SUPPLY_PARAMS_CSV_HEADERS],
        collected.map((r) => [
          r.code, r.name, r.tier ?? "", r.brand ?? "",
          r.normalLeadDays ?? "", r.logisticsLeadDays ?? "", r.purchaseLeadDays ?? "",
          blockedReason(r),
        ]),
        collected.length < total ? `仅导出前 ${collected.length} 行（共 ${total} 行）——请收窄筛选后分批导出` : undefined,
      );
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const filterScope = (): BulkScope => ({
    kind: "filter",
    tier: filters.tier || undefined,
    brandId: filters.brandId ? Number(filters.brandId) : undefined,
    skuType: filters.skuType || undefined,
    blockedOnly: filters.blockedOnly === "1",
  });

  const dirty = (r: Row) => r.leadFields.some((f) => {
    const k = editKey(r.skuId, f);
    return k in edits && edits[k] !== r[f];
  });

  const columns: ColumnsType<Row> = useMemo(() => [
    { title: "SKU 编码", dataIndex: "code", width: 140, fixed: "left", render: (v: string) => <SkuHoverCard code={v} /> },
    { title: "名称", dataIndex: "name", width: 220, ellipsis: true },
    { title: "类型", dataIndex: "skuType", width: 80, render: (v: string) => TYPE_LABELS[v] ?? v },
    {
      title: "分层", dataIndex: "tier", width: 80,
      render: (v: Tier | null, r) => v ? <Tag color={TIER_COLORS[v]}>{v}</Tag> : r.skuType === "finished" ? <Typography.Text type="secondary">未固化</Typography.Text> : "—",
    },
    { title: "阻塞", dataIndex: "blocked", width: 80, render: (v: boolean) => (v ? <Tooltip title="S/A/B 缺加工或在途周期：直出/试点/预警阈值都建立在默认周期上"><Tag color="red">阻塞</Tag></Tooltip> : "—") },
    // 可编辑列 = 服务端 leadFields（成品/半成品：加工+在途；原料/包材：采购）
    { title: "加工周期(天)", key: "normalLeadDays", width: 120, render: (_, r) => cell(r, "normalLeadDays", r.leadFields.includes("normalLeadDays")) },
    { title: "在途周期(天)", key: "logisticsLeadDays", width: 120, render: (_, r) => cell(r, "logisticsLeadDays", r.leadFields.includes("logisticsLeadDays")) },
    { title: "采购周期(天)", key: "purchaseLeadDays", width: 120, render: (_, r) => cell(r, "purchaseLeadDays", r.leadFields.includes("purchaseLeadDays")) },
    { title: "MOQ", dataIndex: "moq", width: 100, align: "right", render: (v: string | null) => (v == null ? <Typography.Text type="warning">缺</Typography.Text> : formatQty(v)) },
    { title: "成本", dataIndex: "hasCost", width: 70, render: (v: boolean) => (v ? <Tag color="green">有</Tag> : <Tag color="orange">无</Tag>) },
    { title: "缺失", dataIndex: "missing", width: 200, render: (v: Dim[]) => (v.length ? v.map((d) => <Tag key={d}>{data?.dimLabels[d] ?? d}</Tag>) : <Tag color="green">齐全</Tag>) },
    {
      title: "", key: "save", width: 80, fixed: "right",
      render: (_, r) => <Button size="small" type="primary" disabled={!dirty(r)} loading={saving === r.skuId} onClick={() => void save(r)}>保存</Button>,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cell/dirty/save 读取最新 edits/saving 闭包，列定义随其变化重建即可
  ], [edits, saving, data?.dimLabels, canOverride]);

  const s = data?.summary;
  const tierCell = (k: Tier | "unclassified") => {
    const b = s?.byTier[k];
    if (!b || b.total === 0) return "—";
    return `${b.complete}/${b.total}${b.blocked ? `（阻塞 ${b.blocked}）` : ""}`;
  };

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>周期主数据补录</Typography.Title>
      <CaliberNote
        summary={<>成品/半成品：加工周期 + 在途周期；原料/包材：采购周期（可编辑列由服务端按类型下发）。S/A/B 缺任一周期即阻塞直出/试点，预警阈值只能按默认周期（D57）。{data?.policyPeriod ? <>　分层取 {data.policyPeriod} 期固化值。</> : "　分层尚未固化。"}</>}
        detail={<div><p>只允许填空；覆盖已有值须生产计划或管理员（采购只能补空值），每次保存留审计（sku_params）。MOQ 走 uom_convs（基础单位换算），成本走 sku_costs，本页只显示有无，不给金额。</p><p>缺省周期：加工 default_production_lead_days、在途 default_logistics_lead_days（运行参数）。</p></div>}
      />
      {s ? (
        <Alert
          type={s.blocked > 0 ? "warning" : "success"}
          showIcon
          style={{ marginBottom: 12 }}
          message={
            <Space wrap size={16}>
              <span>
                周期覆盖 <b>{s.complete}</b> / {s.scanned}
              </span>
              <Progress
                percent={s.scanned > 0 ? Math.round((s.complete / s.scanned) * 1000) / 10 : 0}
                size="small"
                style={{ width: 200 }}
                status={s.blocked > 0 ? "active" : "success"}
              />
              <span>
                仍阻塞试点候选 <b style={{ color: s.blocked > 0 ? "#cf1322" : undefined }}>{s.blocked}</b> 个
              </span>
              {s.blocked > 0 ? (
                <Button size="small" onClick={() => listState.setFilter({ blockedOnly: "1", missing: "any" })}>
                  只看阻塞试点的
                </Button>
              ) : null}
            </Space>
          }
        />
      ) : null}
      <Row gutter={16} style={{ marginBottom: 12 }}>
        <Col span={4}><Statistic title="扫描 SKU" value={s?.scanned ?? "—"} /></Col>
        <Col span={4}><Statistic title="周期齐全" value={s?.complete ?? "—"} /></Col>
        <Col span={4}><Statistic title="S/A/B 阻塞" value={s?.blocked ?? "—"} valueStyle={{ color: s && s.blocked > 0 ? "#cf1322" : undefined }} /></Col>
        <Col span={3}><Statistic title="S 级齐全" value={tierCell("S")} /></Col>
        <Col span={3}><Statistic title="A 级齐全" value={tierCell("A")} /></Col>
        <Col span={3}><Statistic title="B 级齐全" value={tierCell("B")} /></Col>
        <Col span={3}><Statistic title="C/未分层" value={`${tierCell("C")} / ${tierCell("unclassified")}`} /></Col>
      </Row>
      <ListToolbar
        state={listState}
        extra={
          <>
            <Select placeholder="类型" allowClear style={{ width: 100 }} value={filters.skuType || undefined}
              options={Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }))}
              onChange={(v) => listState.setFilter({ skuType: v ?? "" })} />
            <Select placeholder="缺失维度" allowClear style={{ width: 130 }} value={filters.missing || undefined}
              options={[{ value: "any", label: "任一缺失" }, ...Object.entries(data?.dimLabels ?? {}).map(([value, label]) => ({ value, label: `缺${label}` }))]}
              onChange={(v) => listState.setFilter({ missing: v ?? "" })} />
            <Select placeholder="分层" allowClear style={{ width: 100 }} value={filters.tier || undefined}
              options={[{ value: "S", label: "S 级" }, { value: "A", label: "A 级" }, { value: "B", label: "B 级" }, { value: "C", label: "C 级" }, { value: "NONE", label: "未固化" }]}
              onChange={(v) => listState.setFilter({ tier: v ?? "" })} />
            <RemoteSelect
              api="/api/master/brand"
              getLabel={(r) => `${String(r.code)} ${String(r.nameCn ?? "")}`}
              placeholder="品牌"
              allowClear
              showSearch
              style={{ width: 160 }}
              value={filters.brandId ? Number(filters.brandId) : undefined}
              onChange={(v) => listState.setFilter({ brandId: v == null ? "" : String(v) })}
            />
            <span>只看阻塞 <Switch size="small" checked={filters.blockedOnly === "1"} onChange={(v) => listState.setFilter({ blockedOnly: v ? "1" : "" })} /></span>
            <SearchInput allowClear placeholder="搜索 SKU 编码/名称" style={{ width: 200 }} onSearch={(v) => listState.setFilter({ q: v.trim() })} />
          </>
        }
        onExport={data ? () => void doExport() : undefined}
        exportText={exporting ? "导出中…" : "导出 CSV（当前筛选）"}
        primaryActions={(
          <Space wrap>
            <Button
              type="primary"
              disabled={selectedIds.length === 0}
              onClick={() => setBulk({ scope: { kind: "ids", ids: selectedIds }, label: `已选 ${selectedIds.length} 个 SKU` })}
            >
              批量填写{selectedIds.length > 0 ? `（${selectedIds.length}）` : ""}
            </Button>
            <Button
              icon={<DownloadOutlined rotate={180} />}
              disabled={!data}
              onClick={() => setBulk({ scope: filterScope(), label: `当前筛选${filters.tier ? ` · ${filters.tier} 级` : ""}${filters.blockedOnly === "1" ? " · 只看阻塞" : ""}` })}
            >
              按分层/品牌套用默认
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
          </Space>
        )}
      />
      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="周期主数据" />
      <Table<Row>
        rowKey="skuId"
        size={listState.tableSize}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys.map(Number)),
          // 无可编辑周期字段的类型（如服务类）不进批量：勾了也写不进去
          getCheckboxProps: (r) => ({ disabled: r.leadFields.length === 0 }),
        }}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: data?.total ?? 0 })}
        locale={{ emptyText: loadError ? "数据未加载" : "当前条件下没有 SKU" }}
      />
      <BulkFillModal
        open={bulk != null}
        scope={bulk?.scope ?? null}
        scopeLabel={bulk?.label ?? ""}
        defaults={data?.defaults ?? null}
        canOverride={canOverride}
        onClose={() => setBulk(null)}
        onDone={() => void load()}
      />
    </div>
  );
}
