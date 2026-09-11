"use client";

/**
 * E2-04 交期学习与供应商准时率（记分卡页第六页签）——历史 PO 承诺交期 vs 实际收货，
 * 算分布并提议档案交期（人工采纳）。
 *
 * 2026-09-04：从「计划与补货」分组的独立页 `/report/leadtime-learning` 并入本页。
 * 理由：同一个「交期」有三套算法口径——记分卡的 OTIF（准时率）、本页的系统学习值、
 * 「历史交期观察」的简道云观察值。三者并排才看得出彼此是否打架；分散在两个菜单分组里，
 * 计划员只会看见其中一个，然后拿它当唯一事实。旧路径保留为跳转（page.tsx → ?tab=leadtime）。
 *
 * URL 参数命名空间 lt_*（与 sc_/qc_/pv_/pt_/lh_ 互不干扰）。
 */
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Col, Grid, Popconfirm, Row, Space, Statistic, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import { useDocumentRead } from "@/components/useDocumentRead";
import ContextHelp from "@/components/ContextHelp";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import SearchInput from "@/components/SearchInput";
import { useListState } from "@/components/useListState";

interface LtRow {
  supplierId: number;
  supplierName: string;
  skuId: number;
  code: string;
  name: string;
  samples: number;
  promiseSamples: number;
  targetField: "purchaseLeadDays" | null;
  evidenceKey: string;
  p50: number | null;
  p90: number | null;
  stdev: number | null;
  onTimeRate: number | null;
  avgDelayDays: number | null;
  currentLeadDays: number | null;
  suggestLeadDays: number | null;
  suggestReason: string;
}

interface LtData {
  rows: LtRow[];
  total: number;
  minSamples: number;
  leadDeviationTolerancePct: number;
  summary: { pairCount: number; withSuggestion: number; avgOnTimeRate: number | null };
  permissions: { canFill: boolean; canOverride: boolean };
}

export default function LeadTimeLearningTab() {
  const [applying, setApplying] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const write = useRef<AbortController | null>(null);
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { write.current?.abort(); if (writeTimer.current) clearTimeout(writeTimer.current); }, []);
  const compact = !Grid.useBreakpoint().md;
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ key: "leadtime-learning", paramPrefix: "lt", defaults: { q: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;

  const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
  const { data, phase, error: loadError, retry } = useDocumentRead<LtData>(`/api/report/leadtime-learning?${params}`);
  const loading = phase === "loading";
  const currentData = useRef(data);
  currentData.current = data;
  const allowed = (r: LtRow) => r.targetField === "purchaseLeadDays" && !!data?.permissions?.canFill
    && (r.currentLeadDays == null || !!data?.permissions?.canOverride);

  const apply = async (r: LtRow) => {
    if (write.current || r.suggestLeadDays == null || !allowed(r) ||
      !currentData.current?.rows.some(row => row.evidenceKey === r.evidenceKey)) return;
    const request = new AbortController();
    write.current = request;
    setApplying(`${r.supplierId}-${r.skuId}`);
    setReceipt(null);
    const timer = setTimeout(() => {
      request.abort();
      if (write.current === request) write.current = null;
      setReceipt({ type: "error", text: "采纳结果未确认，请先刷新核对采购周期，勿重复提交" });
      setApplying(null);
      retry();
    }, 15_000);
    writeTimer.current = timer;
    try {
      const result = await fetchJson<{ ok: boolean; skuId: number; leadDays: number }>("/api/report/leadtime-learning", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: request.signal,
        body: JSON.stringify({ skuId: r.skuId, supplierId: r.supplierId, leadDays: r.suggestLeadDays, evidenceKey: r.evidenceKey }),
      });
      if (request.signal.aborted) return;
      if (result?.ok !== true || result.skuId !== r.skuId || result.leadDays !== r.suggestLeadDays) {
        throw new Error("采纳回执不完整，请先刷新核对，勿重复提交");
      }
      setReceipt({ type: "success", text: `已采纳：${r.code} 采购周期更新为 ${r.suggestLeadDays} 天；加工及在途周期未改动。` });
      retry();
    } catch (e) {
      if (!request.signal.aborted) {
        setReceipt({ type: "error", text: e instanceof Error ? e.message : "结果未确认，请先刷新核对" });
        retry();
      }
    } finally {
      clearTimeout(timer);
      if (write.current === request) write.current = null;
      if (!request.signal.aborted) setApplying(null);
    }
  };

  const suggestion = (r: LtRow) => <Space direction="vertical" size={4} style={{ maxWidth: "100%" }}>
    <ContextHelp label={`${r.code} ${r.supplierName} 建议依据`} title="采购周期建议依据" content={r.suggestReason}>
      {r.suggestLeadDays == null ? "不建议改档" : `建议 ${r.suggestLeadDays} 天`}
    </ContextHelp>
    {r.suggestLeadDays != null && (allowed(r) ? <Popconfirm
      title="采纳采购周期建议" placement="topLeft"
      description={<div style={{ maxWidth: 240, overflowWrap: "anywhere" }}>
        将 {r.code} 的采购周期从 {r.currentLeadDays ?? "未设"} 改为 {r.suggestLeadDays} 天。
        这是该SKU共用的档案值，不只影响当前供应商；请结合其他供应商与首批/收齐差异核对。
        加工、在途周期不变，提交时会重新检查依据。
      </div>}
      okText="采纳" cancelText="取消" disabled={loading || applying !== null} onConfirm={() => void apply(r)}>
      <Button size="small" type="primary" ghost disabled={loading || applying !== null}
        loading={applying === `${r.supplierId}-${r.skuId}`}>采纳</Button>
    </Popconfirm> : <Typography.Text type="secondary">{data?.permissions?.canFill ? "已有值，请计划员确认" : "仅查看"}</Typography.Text>)}
  </Space>;

  const columns: ColumnsType<LtRow> = [
    ...(compact ? [{ title: "供应商 / SKU", key: "identity", width: 166, fixed: "left" as const,
      render: (_: unknown, r: LtRow) => <div style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
        <strong>{r.supplierName}</strong><br /><a href={`/inventory/balance?q=${encodeURIComponent(r.code)}`}>{r.code}</a>
        <div>{r.name}</div>{suggestion(r)}</div> }] : [
    { title: "供应商", dataIndex: "supplierName", width: 160, ellipsis: true, fixed: "left" as const },
    {
      title: "SKU 编码", dataIndex: "code", width: 155,
      render: (v: string) => <a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a>,
    },
    { title: "名称", dataIndex: "name", width: 220, ellipsis: true }]),
    { title: "独立订单", dataIndex: "samples", width: 100, align: "right" },
    { title: "P50 交期", dataIndex: "p50", width: 95, align: "right", render: (v: number | null) => (v == null ? "—" : `${v} 天`) },
    { title: "P90 交期", dataIndex: "p90", width: 95, align: "right", render: (v: number | null) => (v == null ? "—" : `${v} 天`) },
    {
      title: "波动 σ", dataIndex: "stdev", width: 90, align: "right",
      render: (v: number | null) => (v == null ? "—" : `±${v}`),
    },
    {
      title: "首批准时率", dataIndex: "onTimeRate", width: 130, align: "right",
      render: (v: number | null, r) => <>
        {v == null ? <Typography.Text type="secondary">承诺不足/不明</Typography.Text>
          : <Typography.Text style={{ color: v < 0.8 ? "#cf1322" : undefined }}>{(v * 100).toFixed(1)}%</Typography.Text>}
        <div><Typography.Text type="secondary">可判 {r.promiseSamples}/{r.samples} 单</Typography.Text></div>
      </>,
    },
    {
      title: "平均延误", dataIndex: "avgDelayDays", width: 100, align: "right",
      render: (v: number | null) =>
        v == null ? "—"
          : <Typography.Text style={{ color: v > 0 ? "#cf1322" : "#52c41a" }}>{v > 0 ? `+${v}` : v} 天</Typography.Text>,
    },
    { title: "档案采购周期", dataIndex: "currentLeadDays", width: 120, align: "right", render: (v: number | null, r) => (!r.targetField ? "不适用" : v == null ? <Typography.Text type="secondary">未设</Typography.Text> : `${v} 天`) },
    ...(!compact ? [{ title: "人工采纳", key: "suggestion", width: 190, render: (_: unknown, r: LtRow) => suggestion(r) }] : []),
  ];

  const s = data?.summary;

  return (
    <div>
      {/* 每套交期口径在本页各挂自己的表头：三个页签同名不同算法，不写清楚就会被当成同一个数 */}
      <Typography.Title level={5} style={{ marginTop: 0 }}>采购首批交期学习（系统记录）</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="只提议原料/包材的采购周期，不改加工周期；首批到货不等于全部收齐。"
        description={
          <Typography.Text type="secondary">
            每个PO/SKU只计一次，至少 {data?.minSamples ?? 3} 个独立订单且偏差超 ±{data?.leadDeviationTolerancePct ?? 20}% 才建议。
            <ContextHelp label="交期学习口径" title="样本、局限与采纳权限" content={
              "按供应商×SKU汇总，从PO制单日到首张生效、正数量正常收货的SH录单日，使用上海业务日。仅生效/已短关PO，返工、备品和零数量不计；同PO同SKU行承诺缺失或冲突不进入准时率分母。制单/录单不等于审批或真实到货，当前承诺也不等于原始承诺；本页不是OTIF或成品加工周期。与历史交期观察、记分卡并排核对。采购只能补空值，计划员/管理员可覆盖；SKU档案由所有供应商共用，不自动改档。"
            } />
          </Typography.Text>
        }
      />

      {receipt && <Alert type={receipt.type} showIcon message={receipt.text} style={{ marginBottom: 12 }} />}
      <LoadErrorAlert error={loadError} onRetry={retry} subject="交期学习" retrying={loading} />

      {/* 未加载 / 无样本 = 「—」而不是 0：0.0% 平均准时率会被读成「供应商全都不准时」 */}
      <Row gutter={[10, 10]} className="compact-kpi-row">
        <Col><Card size="small"><Statistic title="有样本的供应商-SKU 对" value={s ? s.pairCount : "—"} /></Card></Col>
        <Col><Card size="small"><Statistic title="有建议数" value={s ? s.withSuggestion : "—"} valueStyle={{ color: (s?.withSuggestion ?? 0) > 0 ? "#fa8c16" : undefined }} /></Card></Col>
        <Col>
          <Card size="small">
            <Statistic
              title={<ContextHelp label="平均首批准时率口径" title="供应商-SKU对的平均值" content="先逐供应商-SKU对计算可判承诺样本的首批准时率，再对这些对等权平均；不是全订单加权准时率，不是OTIF。无可判承诺时显示—，不是0%。">平均首批准时率</ContextHelp>}
              value={s?.avgOnTimeRate == null ? "—" : s.avgOnTimeRate * 100}
              precision={s?.avgOnTimeRate == null ? undefined : 1}
              suffix={s?.avgOnTimeRate == null ? "" : "%"}
              valueStyle={{ color: s?.avgOnTimeRate == null ? undefined : s.avgOnTimeRate < 0.8 ? "#cf1322" : "#52c41a" }}
            />
          </Card>
        </Col>
      </Row>

      <ListToolbar
        state={listState}
        extra={<Space wrap>
          <SearchInput
            key={q}
            allowClear
            defaultValue={q}
            placeholder="搜索供应商/SKU 编码/名称"
            style={{ width: 260, maxWidth: "100%" }}
            onSearch={(v) => listState.setFilter({ q: v.trim() })}
          /><Button onClick={retry} disabled={loading || applying !== null}>刷新核对</Button>
        </Space>}
      />

      <Table<LtRow>
        rowKey={(r) => `${r.supplierId}-${r.skuId}`}
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: data?.total ?? 0 })}
        locale={{ emptyText: loadError ? "数据未加载" : "暂无可学习的交期样本" }}
      />
    </div>
  );
}
