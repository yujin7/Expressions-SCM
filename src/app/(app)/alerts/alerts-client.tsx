"use client";

/**
 * struct#15 系统告警：看门狗产出的数据过期/单据超时/预警引擎告警，与人工裁决复核清单分家（生命周期不同）。
 * 筛选（状态/类别/严重度/隐藏已知悉）与分页写进 URL（useListState）；总数由服务端返回；
 * 每行可展开看规则来源 / 参数快照 / 触发原因（AlertEvidence，why 由引擎写进 paramsSnapshot.why）。
 *
 * W2 人工关闭：持有该告警 ownerRole 的人（或 admin）才看得到「关闭」，弹窗必选原因码 + 备注
 * （AlertCloseModal → POST /api/alerts/[id]/close，服务端仍会回查会话与角色再判一次——前端隐藏不算权限）。
 * 已关闭视图直接显示关闭原因/备注/关闭人（服务端从 alert_events 台账取最近一条 close），
 * 否则"为什么关的"只存在台账里，误报复盘与调阈值都只能靠猜。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { App, Button, Empty, Pagination, Select, Space, Spin, Switch, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import AlertCloseModal from "@/components/AlertCloseModal";
import AlertEvidence, { ackText, type AlertEvidenceFields } from "@/components/AlertEvidence";
import CaliberNote from "@/components/CaliberNote";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { useListState } from "@/components/useListState";
import { hasAnyRole, useMe } from "@/components/useMe";
import { ACTION, roleLabel, severityLabel } from "@/components/dictionary";
import { ALERT_CLOSE_REASON_LABELS, type AlertCloseReasonCode } from "@/lib/alert-close-reasons";
import styles from "./alerts-client.module.css";

interface Row extends AlertEvidenceFields {
  id: number;
  category: string;
  title: string;
  detail: string | null;
  severity: string | null;
  status: string;
  autoResolved?: boolean;
  createdAt: string;
  lastHitAt?: string | null;
  actionHref?: string | null;
  ownerRole?: string | null;
  refKey?: string | null;
  /** 已关闭视图：最近一条 close 事件（服务端从 alert_events 取） */
  closeReasonCode?: string | null;
  closeNote?: string | null;
  closedAt?: string | null;
  closedByName?: string | null;
}
interface ListData { rows: Row[]; total: number; page: number; pageSize: number }

// 与 systemAlerts 的 category 一一对应；新增告警类别必须同步补标签，
// 否则页面上会冒出 job_failure 这样的英文 slug（护栏：tests/architecture/alert-category-labels.test.ts）
const CAT: Record<string, string> = {
  data_freshness: "数据过期",
  doc_aging: "单据超时",
  integration_token: "凭据到期",
  job_failure: "任务失败",
  data_product_gate: "决策门禁降级",
  inventory_cover: "断货预警",
  sales_spike: "爆单预警",
  transfer_cost: "调拨成本异常",
  data_quality: "数据质量核对",
  snapshot_quality: "快照质量",
  supplier_license: "供应商证照到期",
  promise_breach: "交期承诺违约",
  otif_collapse: "供应商 OTIF 崩塌",
  quality_case_overdue: "质量案件逾期",
};
const SEV: Record<string, string> = { critical: "red", high: "orange", medium: "gold" };
const STATUS_OPTIONS = [{ value: "open", label: "待处理" }, { value: "resolved", label: "已关闭" }];

/** `id` 单条深链忽略展示筛选与页码，仍受服务端渠道权限约束。 */
type Filters = { status?: string; category?: string; severity?: string; acked?: string; id?: string; sort?: string; order?: string };
const SORT_OPTIONS = [
  { value: "id:desc", label: "记录：最新优先" },
  { value: "id:asc", label: "记录：最早优先" },
  { value: "createdAt:asc", label: "首次：最早优先" },
  { value: "createdAt:desc", label: "首次：最新优先" },
  { value: "lastHitAt:desc", label: "命中：最新优先" },
  { value: "lastHitAt:asc", label: "命中：最早优先" },
  { value: "severity:desc", label: "严重度：高到低" },
  { value: "severity:asc", label: "严重度：低到高" },
];

const ts = (v: string | null | undefined): string => (v ? new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "—");

/** 关闭原因中文标签；未知码原样显示（不吞掉台账里的事实） */
function closeReasonLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return ALERT_CLOSE_REASON_LABELS[code as AlertCloseReasonCode]?.label ?? code;
}

/** Same safe API projection and actions as the table; no extra fetch or client permission source. */
export function AlertRecordCard({ row, actions }: { row: Row; actions: ReactNode }) {
  return (
    <article className={styles.card} aria-label={`告警 #${row.id} ${row.title}`}>
      <div className={styles.meta}>
        <Tag>{CAT[row.category] ?? row.category}</Tag>
        {row.severity ? <Tag color={SEV[row.severity]}>{severityLabel(row.severity)}</Tag> : <span>严重度未登记</span>}
        <span>#{row.id} · {row.status === "open" ? "待处理" : row.status === "resolved" ? "已关闭" : row.status}</span>
      </div>
      <h3 className={styles.title}>{row.title}</h3>
      <div className={styles.meta}>
        <span>责任：{row.ownerRole ? roleLabel(row.ownerRole) : "未登记"}</span>
        <span>{row.ackedAt ? "已知悉" : "未知悉"}</span>
        <span>最近命中：{ts(row.lastHitAt)}</span>
      </div>
      <details className={styles.evidence}>
        <summary>详情与证据</summary>
        {row.detail ? <p>{row.detail}</p> : null}
        <div>来源编号：{row.refKey ?? "—"}</div>
        <div>首次：{ts(row.createdAt)}</div>
        <AlertEvidence alert={row} />
        {row.status === "resolved" ? <div className={styles.closeEvidence}>
          <strong>关闭原因：{row.autoResolved ? "引擎自动关闭" : closeReasonLabel(row.closeReasonCode)}</strong>
          <div>{row.closedByName ?? "—"} · {ts(row.closedAt)}</div>
          {row.closeNote ? <p>{row.closeNote}</p> : null}
        </div> : null}
      </details>
      {actions}
    </article>
  );
}

export default function AlertsClient() {
  const { message } = App.useApp();
  const me = useMe();
  const listState = useListState<Filters>({ key: "system-alerts", defaults: { status: "open", category: "", severity: "", acked: "", id: "", sort: "", order: "" }, defaultPageSize: 50 });
  const { filters } = listState;
  const query = listState.queryString();
  const [loaded, setLoaded] = useState<{ query: string; data: ListData } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{ query: string; message: string } | null>(null);
  // Bind evidence to its query during render, including the frame before the next effect starts.
  const data = loaded?.query === query ? loaded.data : null;
  const error = failure?.query === query ? failure.message : null;
  const busy = loading || (!data && !error);
  const [closing, setClosing] = useState<Row | null>(null);
  const loadRequest = useRef<AbortController | null>(null);
  const latestLoad = useRef<() => Promise<void>>(async () => {});
  const pendingAcks = useRef(new Set<number>());
  const [acking, setAcking] = useState<number[]>([]);
  /* 单条深链（?id=）不带状态筛选：这一条本身是不是已关闭，只能看行上的 status——
     否则从通知点进一条已关闭告警，列显示的仍是「已知悉」而不是「为什么关的」。 */
  const resolvedView = filters.id
    ? data?.rows.some((r) => r.status === "resolved") === true
    : (filters.status || "open") !== "open";
  const load = useCallback(async () => {
    loadRequest.current?.abort();
    const request = new AbortController();
    loadRequest.current = request;
    setLoading(true);
    setLoaded(null);
    setFailure(null);
    try {
      const next = await fetchJson<ListData>(`/api/alerts?${query}`, { signal: request.signal });
      if (!request.signal.aborted) setLoaded({ query, data: next });
    }
    catch (e) { if (!request.signal.aborted) setFailure({ query, message: e instanceof Error && e.message ? e.message : "告警加载失败，请重试" }); }
    finally { if (!request.signal.aborted) setLoading(false); }
  }, [query]);
  useEffect(() => {
    latestLoad.current = load;
    void load();
    return () => { loadRequest.current?.abort(); latestLoad.current = async () => {}; };
  }, [load]);

  const handleAck = async (id: number) => {
    if (pendingAcks.current.has(id) || busy || error) return;
    pendingAcks.current.add(id);
    setAcking([...pendingAcks.current]);
    try { await fetchJson(`/api/alerts/${id}/ack`, { method: "POST", body: JSON.stringify({}) }); message.success("已知悉（仅记录确认，不会关闭告警）"); await latestLoad.current(); }
    catch (e) { message.error((e as Error).message); }
    finally { pendingAcks.current.delete(id); setAcking([...pendingAcks.current]); }
  };

  /** 关闭按钮可见性：持有该告警责任角色，或 admin（hasAnyRole 内含 admin 放行）；
      ownerRole 为空的历史行只有 admin 能关——与服务端 closeAlert 的判定同口径。 */
  const canClose = (r: Row) => (r.ownerRole ? hasAnyRole(me, r.ownerRole) : hasAnyRole(me));
  /** 「已知悉」同口径（安全审计 S2）：服务端 ackAlert 与 closeAlert 现在用同一条判定，前端按钮随之收敛。 */
  const canAck = canClose;
  const actions = (r: Row) => (
    <div className={styles.actions}>
      {r.actionHref ? <a href={r.actionHref}>去处理</a> : null}
      {r.status === "open" && !r.ackedAt && canAck(r) ? <Button size="small" disabled={busy || !!error} loading={acking.includes(r.id)} onClick={() => void handleAck(r.id)}>已知悉</Button> : null}
      {r.status === "open" && canClose(r) ? <Button size="small" danger disabled={busy || !!error || acking.includes(r.id)} onClick={() => setClosing(r)}>{ACTION.closeAlert}</Button> : null}
    </div>
  );
  const sortOrder = (key: string) => !filters.id && filters.sort === key ? (filters.order === "asc" ? "ascend" as const : "descend" as const) : null;
  const emptyText = error ? "数据未加载" : busy ? "正在加载告警…" : filters.id ? "未找到该来源告警，或你无权查看。" : "当前条件下没有告警";

  const columns: ColumnsType<Row> = [
    { title: "类别", dataIndex: "category", width: 120, fixed: "left", render: (v: string) => <Tag>{CAT[v] ?? v}</Tag> },
    { title: "严重度", dataIndex: "severity", width: 110, sorter: !filters.id, sortOrder: sortOrder("severity"), render: (v: string | null) => (v ? <Tag color={SEV[v]}>{severityLabel(v)}</Tag> : "—") },
    {
      title: "告警", dataIndex: "title", width: 320, ellipsis: true,
      render: (v: string, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{v}</Typography.Text>
          {r.detail ? <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>{r.detail}</Typography.Text> : null}
        </Space>
      ),
    },
    { title: "责任角色", dataIndex: "ownerRole", width: 100, render: (v: string | null | undefined) => (v ? roleLabel(v) : "—") },
    { title: "首次", dataIndex: "createdAt", width: 160, sorter: !filters.id, sortOrder: sortOrder("createdAt"), render: (v: string) => ts(v) },
    { title: "最近命中", dataIndex: "lastHitAt", width: 160, sorter: !filters.id, sortOrder: sortOrder("lastHitAt"), render: (v: string | null | undefined) => ts(v) },
    resolvedView
      ? {
        title: "关闭原因", key: "close", width: 220,
        render: (_, r) => (r.autoResolved
          ? <Tag color="default">引擎自动关闭</Tag>
          : (
            <Space direction="vertical" size={0}>
              <Tag color="blue" style={{ marginInlineEnd: 0 }}>{closeReasonLabel(r.closeReasonCode)}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {r.closedByName ?? "—"}{r.closedAt ? ` · ${ts(r.closedAt)}` : ""}
              </Typography.Text>
              {r.closeNote ? <Typography.Text style={{ fontSize: 12 }} ellipsis={{ tooltip: r.closeNote }}>{r.closeNote}</Typography.Text> : null}
            </Space>
          )),
      }
      : { title: "已知悉", key: "ack", width: 200, render: (_, r) => (r.ackedAt ? <Tooltip title={ackText(r)}><Tag color="default">已知悉 · {r.ackedByName ?? (r.ackedBy != null ? `#${r.ackedBy}` : "")}</Tag></Tooltip> : <Typography.Text type="secondary">未知悉</Typography.Text>) },
    {
      title: "操作", key: "ops", width: 200, fixed: "right",
      render: (_, r) => actions(r),
    },
  ];

  return (
    <div className={styles.root}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>系统告警</Typography.Title>
      <CaliberNote
        summary="历史未关闭告警待复核，不代表当前仍命中；自动关闭须满足对应规则与证据条件。「已知悉」只记录确认，不会关闭告警。"
        detail={<div>失效的 A2/A3 仍须责任人撤回或重新验收。人工裁决事项见「复核清单与提醒」。同类别同去重键只保留一条待处理告警；迟滞天数按类别定（数据缺口型 3 天、单据/任务/凭据等硬事实不再命中即关、周期性事实不自动关闭）。「关闭」需要该告警的责任角色或 admin，必须选原因并进台账；关闭不删除告警，条件仍成立时引擎下一轮会另开一条新告警。</div>}
      />
      <LoadErrorAlert error={error} onRetry={() => void load()} subject="系统告警" retrying={loading} />
      <ListToolbar
        state={listState}
        extra={(
          <Space wrap>
            {/* 通知中心深链：只看那一条（含已关闭的）；一键清除回到常规视图 */}
            {filters.id ? (
              <Tag color="processing" closable onClose={() => listState.setFilter({ id: "" })}>
                仅看告警 #{filters.id}（忽略其他筛选）
              </Tag>
            ) : null}
            <Select style={{ width: 110 }} disabled={!!filters.id} value={filters.status || "open"} options={STATUS_OPTIONS} onChange={(v) => listState.setFilter({ status: v })} />
            <Select allowClear disabled={!!filters.id} placeholder="类别" style={{ width: 150 }} value={filters.category || undefined} options={Object.entries(CAT).map(([value, label]) => ({ value, label }))} onChange={(v) => listState.setFilter({ category: v ?? "" })} />
            <Select allowClear disabled={!!filters.id} placeholder="严重度" style={{ width: 110 }} value={filters.severity || undefined} options={["critical", "high", "medium"].map((v) => ({ value: v, label: severityLabel(v) }))} onChange={(v) => listState.setFilter({ severity: v ?? "" })} />
            <Select aria-label="告警排序" disabled={!!filters.id} style={{ width: 180 }} value={`${filters.sort || "id"}:${filters.order || "desc"}`} options={SORT_OPTIONS} onChange={(v) => { const [sort, order] = v.split(":"); listState.setFilter({ sort, order }); }} />
            <span>隐藏已知悉 <Switch size="small" disabled={!!filters.id} checked={filters.acked === "0"} onChange={(on) => listState.setFilter({ acked: on ? "0" : "" })} /></span>
          </Space>
        )}
        primaryActions={<Button size="small" onClick={() => void load()} loading={loading}>刷新</Button>}
      />
      <div className={styles.desktop}>
      <Table<Row>
        rowKey="id"
        size={listState.tableSize}
        loading={busy}
        columns={columns}
        dataSource={data?.rows ?? []}
        scroll={{ x: 1370 }}
        locale={{ emptyText }}
        pagination={false}
        onChange={(_, __, sorter, extra) => {
          if (extra.action !== "sort" || filters.id) return;
          const next = Array.isArray(sorter) ? sorter[0] : sorter;
          listState.setFilter({ sort: next.order ? String(next.field) : "", order: next.order === "ascend" ? "asc" : next.order === "descend" ? "desc" : "" });
        }}
        expandable={{ expandedRowRender: (r) => <div className={styles.evidence}>{r.detail ? <p>{r.detail}</p> : null}<AlertEvidence alert={r} /></div> }}
      />
      </div>
      <div className={styles.mobile} aria-busy={busy}>
        {busy ? <div className={styles.empty} role="status"><Spin size="small" /> 正在加载告警…</div>
          : data?.rows.length ? data.rows.map(row => <AlertRecordCard key={row.id} row={row} actions={actions(row)} />)
            : <Empty description={emptyText} image={Empty.PRESENTED_IMAGE_SIMPLE} />}
      </div>
      {!filters.id && data ? <Pagination className={styles.pagination} size="small" disabled={busy || !!error} {...listState.paginationProps({ total: data.total, showTotal: t => `共 ${t} 条告警` })} /> : null}
      <AlertCloseModal
        open={closing != null}
        alertId={closing?.id ?? null}
        alertTitle={closing?.title ?? null}
        onCancel={() => setClosing(null)}
        onClosed={() => { setClosing(null); void latestLoad.current(); }}
      />
    </div>
  );
}
