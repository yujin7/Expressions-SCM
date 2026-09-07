"use client";

/**
 * 周期主数据补录工作台（IAL-06 / FS-R6）：加工 / 采购 / 在途周期、MOQ、成本有无，按分层筛缺失维度，行内补录。
 * 写规则：只允许填空；覆盖非空值须 pmc/admin（采购只能补空）。每次保存留审计。
 * 可编辑列以服务端下发的 row.leadFields 为准（master/sku-supply-params-fill.leadFieldsFor 唯一口径：
 * 成品/半成品 = 加工 + 在途；原料/包材 = 采购），前端不另行按类型判定。
 */
import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Drawer, InputNumber, Progress, Select, Space, Statistic, Switch, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import CaliberNote from "@/components/CaliberNote";
import { exportCsv } from "@/components/exportCsv";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import RemoteSelect from "@/components/RemoteSelect";
import SearchInput from "@/components/SearchInput";
import SkuHoverCard from "@/components/SkuHoverCard";
import { useListState } from "@/components/useListState";
import { useDocumentRead } from "@/components/useDocumentRead";
import { clearSavedSupplyDraft, editSupplyDraft, restoreSupplyDrafts, serializeSupplyDrafts, supplyDraftConflicts, type SupplyDrafts } from "@/lib/supply-param-drafts";
import { SUPPLY_PARAMS_CSV_HEADERS } from "@/lib/supply-params-csv";
import BulkFillModal, { type BulkScope } from "./bulk-fill-modal";
import styles from "./supply-params.module.css";

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
const FIELD_LABELS: Record<LeadField, string> = { normalLeadDays: "加工周期", logisticsLeadDays: "在途周期", purchaseLeadDays: "采购周期" };

export default function SupplyParamsClient({ canOverride, userId }: { canOverride: boolean; userId: number }) {
  const { message } = App.useApp();
  const listState = useListState({
    key: "master-supply-params",
    defaults: { q: "", skuType: "", missing: "any", tier: "", brandId: "", blockedOnly: "" },
    defaultPageSize: 50,
  });
  const { filters, page, pageSize } = listState;
  const [searchText, setSearchText] = useState(filters.q);
  useEffect(() => setSearchText(filters.q), [filters.q]);
  const [edits, setEdits] = useState<SupplyDrafts>({});
  const [draftsReady, setDraftsReady] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const writeBusy = useRef(false);
  const mounted = useRef(false);
  /* 批量补录（#1）：勾选行 → 批量填写；当前筛选 → 按分层/品牌套用默认 */
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulk, setBulk] = useState<{ scope: BulkScope; label: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportRequest = useRef<AbortController | null>(null);
  const params = new URLSearchParams({ q: filters.q, page: String(page), pageSize: String(pageSize) });
  for (const key of ["skuType", "missing", "tier", "brandId", "blockedOnly"] as const) {
    if (filters[key] && !(key === "missing" && filters[key] === "all")) params.set(key, filters[key]);
  }
  const query = params.toString();
  useEffect(() => () => { exportRequest.current?.abort(); }, [query]);
  const read = useDocumentRead<Data>(`/api/master/supply-params?${query}`);
  const { data, error: loadError, retry: load } = read;
  const loading = read.phase === "loading";
  const storageKey = `scm:supply-drafts:v1:${userId}`;
  useEffect(() => {
    mounted.current = true;
    try { setEdits(restoreSupplyDrafts(sessionStorage.getItem(storageKey))); }
    catch { setStorageWarning(true); }
    setDraftsReady(true);
    return () => { mounted.current = false; };
  }, [storageKey]);
  useEffect(() => {
    if (!draftsReady) return;
    try {
      if (Object.keys(edits).length) sessionStorage.setItem(storageKey, serializeSupplyDrafts(edits));
      else sessionStorage.removeItem(storageKey);
    } catch { setStorageWarning(true); }
  }, [edits, draftsReady, storageKey]);
  useEffect(() => { setSelectedIds([]); }, [query]);
  useEffect(() => {
    if (!Object.keys(edits).length && saving == null) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [edits, saving]);

  const discard = (skuId: number) => setEdits(old => { const next = { ...old }; delete next[skuId]; return next; });

  const save = async (r: Row) => {
    const draft = edits[r.skuId];
    if (!draft || writeBusy.current || !data || supplyDraftConflicts(draft, r).length) return;
    if (Object.keys(draft.values).some(f => !r.leadFields.includes(f as LeadField))) return void message.warning("SKU类型已变化，请放弃该草稿后重新编辑");
    writeBusy.current = true;
    setSaving(r.skuId);
    setSaveError(null);
    const request = new AbortController();
    const timeout = setTimeout(() => request.abort(), 20_000);
    try {
      const res = await fetchJson<{ skuId: number; action: "fill" | "override" }>(`/api/master/sku/${r.skuId}/supply-params`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft.values, expected: draft.base }), signal: request.signal,
      });
      if (!mounted.current) return;
      if (res?.skuId !== r.skuId || !["fill", "override"].includes(res.action)) throw new Error("保存回执与当前SKU不一致，请先核对服务器结果");
      setEdits(old => clearSavedSupplyDraft(old, draft));
      message.success(`${r.code} 已${res.action === "override" ? "覆盖" : "补录"}`);
      load();
    } catch (e) {
      if (mounted.current) setSaveError(`${r.code}：${request.signal.aborted ? "等待保存回执超时，操作可能已完成。草稿已保留，请刷新核对，不要直接重复提交" : (e as Error).message}`);
    } finally {
      clearTimeout(timeout);
      writeBusy.current = false;
      if (mounted.current) setSaving(null);
    }
  };

  const cell = (r: Row, f: LeadField, applicable: boolean) => {
    if (!applicable) return <Typography.Text type="secondary">不适用</Typography.Text>;
    const draft = edits[r.skuId];
    const current = r[f];
    const locked = current != null && !canOverride;
    return (
      <Tooltip title={locked ? "已有值，只有生产计划/管理员可覆盖" : current == null ? "空值：可直接补录" : "覆盖已有值将留审计"}>
        <InputNumber
          size="small"
          min={0}
          max={365}
          precision={0}
          aria-label={`${r.code} ${FIELD_LABELS[f]}（天）`}
          value={draft && f in draft.values ? draft.values[f] : current}
          disabled={locked || saving === r.skuId || !draftsReady || bulk != null}
          status={draft && supplyDraftConflicts(draft, r).includes(f) ? "error" : current == null && !(draft && f in draft.values) ? "warning" : undefined}
          onChange={(v) => setEdits(e => Object.keys(e).length >= 500 && !e[r.skuId] ? e : editSupplyDraft(e, r, f, v == null ? null : Number(v)))}
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
    if (exportRequest.current) return;
    const request = new AbortController();
    exportRequest.current = request;
    const timeout = setTimeout(() => request.abort(), 20_000);
    setExporting(true);
    try {
      const collected: Row[] = [];
      let total = 0;
      for (let p = 1; ; p++) {
        const params = new URLSearchParams({ q: filters.q, page: String(p), pageSize: "500" });
        if (filters.skuType) params.set("skuType", filters.skuType);
        if (filters.missing && filters.missing !== "all") params.set("missing", filters.missing);
        if (filters.tier) params.set("tier", filters.tier);
        if (filters.brandId) params.set("brandId", filters.brandId);
        if (filters.blockedOnly === "1") params.set("blockedOnly", "1");
        const chunk = await fetchJson<Data>(`/api/master/supply-params?${params.toString()}`, { signal: request.signal });
        if (request.signal.aborted || !mounted.current) return;
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
      if (mounted.current) message.error(request.signal.aborted ? "导出已取消或超时，请在当前筛选下重新导出" : (e as Error).message);
    } finally {
      clearTimeout(timeout); exportRequest.current = null;
      if (mounted.current) setExporting(false);
    }
  };

  const filterScope = (): BulkScope => ({
    kind: "filter",
    tier: filters.tier || undefined,
    brandId: filters.brandId ? Number(filters.brandId) : undefined,
    skuType: filters.skuType || undefined,
    blockedOnly: filters.blockedOnly === "1",
    q: filters.q,
    missing: (filters.missing === "all" ? "" : filters.missing) as "" | "any" | Dim,
    onlyMissing: false,
  });

  const dirty = (r: Row) => Boolean(edits[r.skuId]);
  const rowActions = (r: Row) => {
    const draft = edits[r.skuId];
    const conflicts = draft ? supplyDraftConflicts(draft, r) : [];
    return <Space direction="vertical" size={4}>
      <Space size={4}>
        <Button size="small" type="primary" disabled={!draft || saving != null || conflicts.length > 0} loading={saving === r.skuId} onClick={() => void save(r)}>保存</Button>
        {draft && <Button size="small" disabled={saving === r.skuId} onClick={() => discard(r.skuId)}>放弃</Button>}
      </Space>
      {conflicts.length > 0 && <div className={styles.conflict}>
        {conflicts.map(f => <div key={f}>{FIELD_LABELS[f]}：原{draft.base[f] ?? "空"} → 现{r[f] ?? "空"}；拟填{draft.values[f] ?? "空"}</div>)}
        {canOverride && <Button type="link" size="small" disabled={saving != null} onClick={() => setEdits(old => ({ ...old, [r.skuId]: { ...old[r.skuId], base: { ...old[r.skuId].base, ...Object.fromEntries(Object.keys(old[r.skuId].values).map(f => [f, r[f as LeadField]])) } } }))}>核对后以现值为基准</Button>}
      </div>}
    </Space>;
  };

  const columns: ColumnsType<Row> = [
    { title: "SKU / 名称", key: "identity", width: 240, render: (_, r) => <div className={styles.identity}><SkuHoverCard code={r.code} /><div>{r.name}</div></div> },
    { title: "类型 / 分层", key: "type", width: 100, render: (_, r) => <Space direction="vertical" size={4}>
      <span>{TYPE_LABELS[r.skuType]}</span>{r.tier ? <Tag color={TIER_COLORS[r.tier]}>{r.tier}</Tag> : r.skuType === "finished" ? <Typography.Text type="secondary">未固化</Typography.Text> : null}
      {r.blocked && <Tag color="red">阻塞试点</Tag>}
    </Space> },
    // Only applicable inputs: no empty type-specific columns between the fact and save action.
    { title: "周期（天）", key: "leads", width: 220, render: (_, r) => <div className={styles.mobileFields}>{r.leadFields.map(f => <label key={f}>{FIELD_LABELS[f]}{cell(r, f, true)}</label>)}</div> },
    { title: "缺失 / 基础约束", key: "missing", width: 180, render: (_, r) => <div>
      <div className={styles.tiers}>{r.missing.length ? r.missing.map(d => <Tag key={d}>{data?.dimLabels[d] ?? d}</Tag>) : <Tag color="green">齐全</Tag>}</div>
      <Typography.Text type="secondary">MOQ：{r.moq == null ? "缺失" : formatQty(r.moq)} · 成本：{r.hasCost ? "已填" : "缺失"}</Typography.Text>
    </div> },
    { title: "编辑", key: "save", width: 180, render: (_, r) => rowActions(r) },
  ];

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
          type={s.blocked > 0 ? "warning" : s.scanned > 0 && s.complete === s.scanned ? "success" : "info"}
          showIcon
          style={{ marginBottom: 12 }}
          message={
            <Space wrap size={16}>
              <span>
                全库周期 / MOQ / 成本齐全 <b>{s.complete}</b> / {s.scanned}
              </span>
              <Progress
                percent={s.scanned > 0 ? Math.round((s.complete / s.scanned) * 1000) / 10 : 0}
                size="small"
                style={{ width: 200 }}
                status={s.scanned > 0 && s.complete === s.scanned ? "success" : "normal"}
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
      <div className={styles.summary}>
        <Statistic title="全库扫描 SKU" value={s?.scanned ?? "—"} />
        <Statistic title="当前筛选 SKU" value={data?.total ?? "—"} />
        <Statistic title="全库 S/A/B 阻塞" value={s?.blocked ?? "—"} valueStyle={{ color: s && s.blocked > 0 ? "#cf1322" : undefined }} />
      </div>
      <div className={styles.tiers}>成品周期齐全 / 总数：{(["S", "A", "B", "C", "unclassified"] as const).map(t => <Tag key={t}>{t === "unclassified" ? "未分层" : `${t}级`} {tierCell(t)}</Tag>)}</div>
      {storageWarning && <Alert type="warning" showIcon message="浏览器无法保留草稿；本页切换筛选仍保留编辑，离开或刷新前请先保存。" />}
      {Object.keys(edits).length > 0 && <Alert className={styles.draftNotice} type="info" showIcon
        message={<Space wrap><span>{Object.keys(edits).length} 个SKU有未保存编辑；筛选/翻页/刷新读取不会清空。</span><Button size="small" onClick={() => setDraftOpen(true)}>查看未保存</Button></Space>}
        description={Object.keys(edits).length >= 500 ? "已达500个草稿上限，请先保存或放弃部分草稿。" : "草稿按账号保留在本标签页，8小时内可刷新恢复；批量操作前先保存或放弃行内编辑。"} />}
      <ListToolbar
        state={listState}
        extra={
          <>
            <Select placeholder="类型" allowClear style={{ width: 100 }} value={filters.skuType || undefined}
              options={Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }))}
              onChange={(v) => listState.setFilter({ skuType: v ?? "" })} />
            <Select placeholder="缺失维度" allowClear style={{ width: 130 }} value={filters.missing || undefined}
              options={[{ value: "all", label: "全部（不限缺失）" }, { value: "any", label: "任一缺失" }, ...Object.entries(data?.dimLabels ?? {}).map(([value, label]) => ({ value, label: `缺${label}` }))]}
              onChange={(v) => listState.setFilter({ missing: v ?? "all" })} />
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
            <SearchInput allowClear placeholder="搜索 SKU 编码/名称" style={{ width: 200 }}
              value={searchText} onChange={(event) => setSearchText(event.target.value)}
              onSearch={(v) => listState.setFilter({ q: v.trim() })} />
          </>
        }
        onExport={data && !exporting ? () => void doExport() : undefined}
        exportText={exporting ? "导出中…" : "导出 CSV（当前筛选）"}
        primaryActions={(
          <Space wrap>
            <Button
              type="primary"
              disabled={selectedIds.length === 0 || !data || !draftsReady || Object.keys(edits).length > 0 || saving != null}
              onClick={() => setBulk({ scope: { kind: "ids", ids: selectedIds }, label: `已选 ${selectedIds.length} 个 SKU` })}
            >
              批量填写{selectedIds.length > 0 ? `（${selectedIds.length}）` : ""}
            </Button>
            <Button
              icon={<DownloadOutlined rotate={180} />}
              disabled={!data || !draftsReady || Object.keys(edits).length > 0 || saving != null}
              onClick={() => setBulk({ scope: filterScope(), label: `当前筛选${filters.tier ? ` · ${filters.tier} 级` : ""}${filters.blockedOnly === "1" ? " · 只看阻塞" : ""}` })}
            >
              当前筛选批量填写
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
          </Space>
        )}
      />
      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="周期主数据" />
      {saveError && <Alert className={styles.draftNotice} type="error" showIcon closable onClose={() => setSaveError(null)} message="保存未确认，编辑已保留" description={saveError} action={<Button size="small" onClick={load}>刷新核对</Button>} />}
      <div className={styles.desktopTable}>
      <Table<Row>
        rowKey="skuId"
        size={listState.tableSize}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys.map(Number)),
          // 无可编辑周期字段的类型（如服务类）不进批量：勾了也写不进去
          getCheckboxProps: (r) => ({ disabled: r.leadFields.length === 0 || saving != null || Object.keys(edits).length > 0 }),
        }}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: 960 }}
        pagination={listState.paginationProps({ total: data?.total ?? 0 })}
        locale={{ emptyText: loadError ? "数据未加载" : "当前条件下没有 SKU" }}
      />
      </div>
      <div className={styles.mobileRows}>
        {loading ? <Typography.Text type="secondary">正在读取周期主数据…</Typography.Text> : data?.rows.length === 0 ? <Typography.Text type="secondary">当前条件下没有SKU</Typography.Text> : null}
        {data?.rows.map(r => <section key={r.skuId} className={styles.mobileRow} aria-label={`${r.code} 周期编辑`}>
          <div className={styles.mobileHeading}><Checkbox aria-label={`选择 ${r.code}`} checked={selectedIds.includes(r.skuId)} disabled={r.leadFields.length === 0 || saving != null || Object.keys(edits).length > 0}
            onChange={event => setSelectedIds(ids => event.target.checked ? [...new Set([...ids, r.skuId])] : ids.filter(id => id !== r.skuId))} /><SkuHoverCard code={r.code} /><Tag>{TYPE_LABELS[r.skuType]}</Tag>{dirty(r) && <Tag color="blue">未保存</Tag>}</div>
          <div>{r.name}</div>
          <div className={styles.mobileFields}>{r.leadFields.map(f => <label key={f}>{FIELD_LABELS[f]}（天）{cell(r, f, true)}</label>)}</div>
          <div className={styles.tiers}>{r.missing.length ? `缺失：${r.missing.map(d => data.dimLabels[d]).join("、")}` : "主数据齐全"}{r.blocked ? " · 阻塞试点" : ""}</div>
          {rowActions(r)}
        </section>)}
        <Space wrap className={styles.mobilePagination}>
          <Button disabled={page <= 1 || loading} onClick={() => listState.paginationProps({ total: data?.total ?? 0 }).onChange?.(page - 1, pageSize)}>上一页</Button>
          <span>第{page}页 · 共{data?.total ?? "—"}个</span>
          <Button disabled={!data || page * pageSize >= data.total || loading} onClick={() => listState.paginationProps({ total: data?.total ?? 0 }).onChange?.(page + 1, pageSize)}>下一页</Button>
        </Space>
      </div>
      <Drawer open={draftOpen} onClose={() => setDraftOpen(false)} title="未保存的周期编辑" width={480}>
        <Typography.Paragraph type="secondary">包含其他筛选或分页下的编辑。定位后先核对服务器现值，再保存；这里不会自动写入。</Typography.Paragraph>
        {Object.values(edits).map(d => <section key={d.skuId} className={styles.mobileRow}>
          <Typography.Text strong>{d.code}</Typography.Text>
          {Object.entries(d.values).map(([f, value]) => <div key={f}>{FIELD_LABELS[f as LeadField]}：{d.base[f as LeadField] ?? "空"} → {value ?? "清空"} 天</div>)}
          <Space><Button size="small" onClick={() => { listState.setFilter({ q: d.code, missing: "all", tier: "", skuType: "", brandId: "", blockedOnly: "" }); setDraftOpen(false); }}>定位并核对</Button><Button size="small" disabled={saving === d.skuId} onClick={() => discard(d.skuId)}>放弃此项</Button></Space>
        </section>)}
      </Drawer>
      {bulk && <BulkFillModal
        open
        scope={bulk.scope}
        scopeLabel={bulk.label}
        defaults={data?.defaults ?? null}
        canOverride={canOverride}
        onClose={() => setBulk(null)}
        onDone={() => { setSelectedIds([]); load(); }}
      />}
    </div>
  );
}
