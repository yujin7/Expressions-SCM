"use client";

/**
 * D61 待办任务：我的待办 / 全部 / 完成率 三 Tab（每 Tab 独立 paramPrefix：mine_ / all_ / st_）。
 * 完成率只读统计不打分；绩效 = 证据导出（CSV）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Alert, App, Button, Col, DatePicker, Dropdown, Empty, Pagination, Row, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { fetchJson, patchJson } from "@/components/fetchJson";
import CaliberNote from "@/components/CaliberNote";
import { exportCsv } from "@/components/exportCsv";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import SearchInput from "@/components/SearchInput";
import { useListState } from "@/components/useListState";
import { useMe } from "@/components/useMe";
import { workItemSourceAction } from "@/lib/work-item-source";
import { todoItemHref, todoTabFromQuery, todoTabHref } from "@/lib/todo-navigation";
import { todoSortPatch, type TodoSortField } from "@/lib/todo-sort";
import TodoProgressCard from "./TodoProgressCard";
import TodoCreateDrawer from "./TodoCreateDrawer";
import TodoHistoryDrawer from "./TodoHistoryDrawer";
import TodoNoteRecovery from "./TodoNoteRecovery";
import styles from "./todo-client.module.css";

export interface WorkItemRow {
  id: number;
  title: string;
  detail: string | null;
  assigneeId: number;
  assigneeName: string | null;
  assignerId: number;
  assignerName: string | null;
  ownerRole: string | null;
  priority: string;
  dueDate: string | null;
  status: "open" | "in_progress" | "done" | "cancelled";
  sourceKind: string | null;
  sourceRef: string | null;
  completedAt: string | null;
  createdBy: number;
  createdAt: string;
  overdue: boolean;
  suspicious: boolean;
}

interface ListData { rows: WorkItemRow[]; total: number; today: string }
interface Assignee { id: number; name: string; roles: string[] }

const ROLE_OPTIONS = [
  { value: "ops", label: "运营" }, { value: "purchasing", label: "采购" }, { value: "warehouse", label: "仓管" },
  { value: "quality", label: "质量合规" }, { value: "pmc", label: "生产计划" }, { value: "finance", label: "财务" }, { value: "admin", label: "管理员" },
];
const ROLE_LABEL: Record<string, string> = Object.fromEntries(ROLE_OPTIONS.map((o) => [o.value, o.label]));
const STATUS_LABEL: Record<string, string> = { open: "待处理", in_progress: "进行中", done: "已完成", cancelled: "已取消" };
const STATUS_COLOR: Record<string, string> = { open: "blue", in_progress: "gold", done: "green", cancelled: "default" };
const PRIORITY_LABEL: Record<string, string> = { high: "高", normal: "中", low: "低" };
const PRIORITY_COLOR: Record<string, string> = { high: "red", normal: "blue", low: "default" };
const SOURCE_LABEL: Record<string, string> = { alert: "系统告警", review: "复核项", manual: "手工" };

function fmt(iso: string | null): string {
  return iso ? dayjs(iso).format("YYYY-MM-DD HH:mm") : "—";
}

export function TodoItemSummary({ row }: { row: WorkItemRow }) {
  const source = workItemSourceAction(row);
  return <div className={styles.summary}>
    <div className={styles.title}><span className={styles.id}>#{row.id}</span> <strong>{row.title}</strong></div>
    <div className={styles.meta}>
      <span>责任人：{row.assigneeName ?? `#${row.assigneeId}`}</span>
      {row.ownerRole ? <span>{ROLE_LABEL[row.ownerRole] ?? row.ownerRole}</span> : null}
      {source ? <a href={source.href}>{SOURCE_LABEL[row.sourceKind ?? ""] ?? "来源"} #{row.sourceRef}</a>
        : <span>{SOURCE_LABEL[row.sourceKind ?? ""] ?? row.sourceKind ?? "来源未登记"}{row.sourceRef ? ` #${row.sourceRef}` : ""}</span>}
    </div>
    <details className={styles.details}>
      <summary>明细与记录</summary>
      <p>{row.detail || "未填写明细"}</p>
      <dl><dt>指派人</dt><dd>{row.assignerName ?? `#${row.assignerId}`}</dd>
        <dt>创建时间</dt><dd>{fmt(row.createdAt)}</dd>
        <dt>完成时间</dt><dd>{fmt(row.completedAt)}</dd></dl>
      {source ? <p>{source.completionHint} <a href={source.href}>{source.label}</a></p> : null}
    </details>
  </div>;
}

function ItemStatus({ row }: { row: WorkItemRow }) {
  return <Space size={4} wrap>
    <Tag color={STATUS_COLOR[row.status]}>{STATUS_LABEL[row.status] ?? row.status}</Tag>
    {row.overdue ? <Tag color="volcano">{row.status === "done" ? "完成不按时" : "逾期"}</Tag> : null}
    {row.suspicious ? <Tag color="orange">可疑</Tag> : null}
  </Space>;
}

type Filters = { q?: string; status?: string; ownerRole?: string; overdue?: string; sortBy?: string; sortOrder?: string };

function useAssignees(): Assignee[] {
  const [list, setList] = useState<Assignee[]>([]);
  useEffect(() => {
    fetchJson<{ rows: Assignee[] }>("/api/todo/assignees").then((r) => setList(r.rows)).catch(() => setList([]));
  }, []);
  return list;
}

export function ItemTable({ view, prefix, assignees, refreshKey, onChanged }: { view: "mine" | "all"; prefix: string; assignees: Assignee[]; refreshKey: number; onChanged: () => void }) {
  const { message } = App.useApp();
  const me = useMe();
  const [data, setData] = useState<ListData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadRequest = useRef<AbortController | null>(null);
  const pendingIds = useRef(new Set<number>());
  const [busyIds, setBusyIds] = useState<ReadonlySet<number>>(new Set());
  const [feedback, setFeedback] = useState<{ row: WorkItemRow; text: string; type: "success" | "warning" | "error" } | null>(null);
  const [historyItem, setHistoryItem] = useState<WorkItemRow | null>(null);
  const listState = useListState<Filters>({
    key: `todo-${view}`,
    defaults: { q: "", status: view === "mine" ? "active" : "", ownerRole: "", overdue: "", sortBy: "", sortOrder: "" },
    defaultPageSize: 20,
    paramPrefix: prefix,
  });
  const { page, pageSize, filters } = listState;

  const load = useCallback(async () => {
    loadRequest.current?.abort();
    const request = new AbortController();
    loadRequest.current = request;
    setLoading(true);
    setLoadError(null);
    setData(null); // New filters/sorting must never display the previous query's rows as current facts.
    try {
      const params = new URLSearchParams({ view, page: String(page), pageSize: String(pageSize) });
      if (filters.q) params.set("q", filters.q);
      if (filters.status) params.set("status", filters.status);
      if (filters.ownerRole) params.set("ownerRole", filters.ownerRole);
      if (filters.overdue) params.set("overdue", "1");
      if (filters.sortBy) params.set("sortBy", filters.sortBy);
      if (filters.sortOrder) params.set("sortOrder", filters.sortOrder);
      const result = await fetchJson<ListData>(`/api/todo?${params.toString()}`, { signal: request.signal });
      if (!request.signal.aborted) setData(result);
    } catch (e) {
      if (!request.signal.aborted) setLoadError((e as Error).message);
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, [view, page, pageSize, filters.q, filters.status, filters.ownerRole, filters.overdue, filters.sortBy, filters.sortOrder]);
  useEffect(() => {
    void load();
    return () => { loadRequest.current?.abort(); };
  }, [load, refreshKey]);

  const act = async (row: WorkItemRow, patch: { status?: string; assigneeId?: number }) => {
    if (pendingIds.current.has(row.id) || loading || loadError) return;
    pendingIds.current.add(row.id);
    setBusyIds(new Set(pendingIds.current));
    try {
      const r = await patchJson<WorkItemRow>(`/api/todo/${row.id}`, patch);
      if (r.suspicious && patch.status === "done") message.warning("创建后不足 10 分钟即关闭，已标记为「可疑」（仅提示，不影响状态）");
      else if (patch.status === "done") message.success("待办已完成");
      else message.success("已更新");
      setFeedback({ row, text: r.suspicious && patch.status === "done" ? "完成操作已保存；创建不足10分钟即关闭，已标记可疑（仅提示）" : patch.status === "done" ? "完成待办的操作已保存" : "更新操作已保存", type: r.suspicious && patch.status === "done" ? "warning" : "success" });
      onChanged();
    } catch (e) {
      const text = e instanceof Error ? e.message : "更新结果未确认，请先核对待办，勿重复提交";
      message.error(text);
      setFeedback({ row, text, type: "error" });
    } finally {
      pendingIds.current.delete(row.id);
      setBusyIds(new Set(pendingIds.current));
    }
  };

  const canManage = (r: WorkItemRow) =>
    !!me && (me.roles.includes("admin") || [r.assigneeId, r.assignerId, r.createdBy].includes(me.id) || (!!r.ownerRole && me.roles.includes(r.ownerRole)));

  const sortProps = (key: TodoSortField) => ({
    key, sorter: true,
    sortOrder: filters.sortBy === key ? (filters.sortOrder === "desc" ? "descend" as const : "ascend" as const) : null,
  });

  const columns: ColumnsType<WorkItemRow> = [
    {
      title: "待办 / 责任人 / 来源", dataIndex: "title", width: 340,
      render: (_: string, r) => <TodoItemSummary row={r} />,
    },
    { title: "优先级", dataIndex: "priority", width: 100, ...sortProps("priority"), render: (v: string) => <Tag color={PRIORITY_COLOR[v]}>{PRIORITY_LABEL[v] ?? v}</Tag> },
    {
      title: "状态", dataIndex: "status", width: 140, ...sortProps("status"),
      render: (_: string, r) => <ItemStatus row={r} />,
    },
    { title: "截止", dataIndex: "dueDate", width: 110, ...sortProps("dueDate"), render: (v: string | null) => v ?? "—" },
    {
      title: "操作", key: "ops", width: 180,
      render: (_, r) => renderActions(r),
    },
  ];

  // Both layouts use the same permission decision, pending lock and mutation callback.
  function renderActions(r: WorkItemRow) {
        if (!canManage(r)) return <Typography.Text type="secondary">—</Typography.Text>;
        const active = r.status === "open" || r.status === "in_progress";
        const busy = busyIds.has(r.id);
        const disabled = busy || loading || !!loadError;
        const source = workItemSourceAction(r);
        return (
          <Space size={4} wrap>
            <Button size="small" disabled={disabled} onClick={() => setHistoryItem(r)}>跟进记录</Button>
            {r.status === "open" ? <Button size="small" disabled={disabled} onClick={() => act(r, { status: "in_progress" })}>开始</Button> : null}
            {active ? <Tooltip title={source?.completionHint}><Button size="small" type="primary" disabled={disabled} loading={busy} onClick={() => act(r, { status: "done" })}>完成待办</Button></Tooltip> : null}
            {!active ? <Button size="small" disabled={disabled} onClick={() => act(r, { status: "open" })}>重新打开</Button> : null}
            {active ? (
              <Dropdown
                trigger={["click"]}
                disabled={disabled}
                menu={{ items: [
                  { key: "assign", label: "改派给", disabled: assignees.every((a) => a.id === r.assigneeId), children: assignees.filter((a) => a.id !== r.assigneeId).map((a) => ({ key: `assign-${a.id}`, label: a.name, onClick: () => void act(r, { assigneeId: a.id }) })) },
                  { type: "divider" },
                  { key: "cancel", label: "取消待办", danger: true, onClick: () => void act(r, { status: "cancelled" }) },
                ] }}
              ><Button size="small" disabled={disabled} aria-label={`待办 ${r.id} 的更多操作`}>更多</Button></Dropdown>
            ) : null}
          </Space>
        );
  }

  const feedbackSource = feedback ? workItemSourceAction(feedback.row) : null;

  return (
    <section className={styles.list} aria-label={view === "mine" ? "我的待办列表" : "全部待办列表"}>
      <ListToolbar
        state={listState}
        extra={(
          <div className={styles.filters}>
            <SearchInput
              key={filters.q ?? ""}
              allowClear
              placeholder="标题 / 明细 / #id"
              className={styles.search}
              defaultValue={filters.q}
              onSearch={(v) => listState.setFilter({ q: v })}
            />
            <Select
              allowClear
              placeholder="状态"
              aria-label="待办状态"
              value={filters.status || undefined}
              onChange={(v) => listState.setFilter({ status: v ?? "" })}
              options={[{ value: "active", label: "未完成" }, ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))]}
            />
            <Select
              allowClear
              placeholder="责任角色"
              aria-label="待办责任角色"
              value={filters.ownerRole || undefined}
              onChange={(v) => listState.setFilter({ ownerRole: v ?? "" })}
              options={ROLE_OPTIONS}
            />
            <Select
              allowClear
              placeholder="逾期"
              aria-label="待办逾期筛选"
              value={filters.overdue || undefined}
              onChange={(v) => listState.setFilter({ overdue: v ?? "" })}
              options={[{ value: "1", label: "仅逾期" }]}
            />
            <Select aria-label="待办排序字段" allowClear placeholder="默认排序"
              value={filters.sortBy || undefined}
              onChange={(value) => listState.setFilter(value ? { sortBy: value, sortOrder: filters.sortOrder || "asc" } : { sortBy: "", sortOrder: "" })}
              options={[{ value: "priority", label: "按优先级" }, { value: "status", label: "按状态" }, { value: "dueDate", label: "按截止日期" }, { value: "createdAt", label: "按创建时间" }]} />
            {filters.sortBy ? <Button aria-label="切换待办排序方向" onClick={() => listState.setFilter({ sortOrder: filters.sortOrder === "desc" ? "asc" : "desc" })}>{filters.sortOrder === "desc" ? "降序 ↓" : "升序 ↑"}</Button> : null}
          </div>
        )}
      />
      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="待办列表" retrying={loading} />
      {feedback ? <Alert className={styles.feedback} type={feedback.type} showIcon closable onClose={() => setFeedback(null)}
        message={`#${feedback.row.id} ${feedback.row.title}：${feedback.text}`}
        description={<span><a href={todoItemHref(feedback.row.id)}>核对该待办</a>{feedbackSource ? <> · {feedbackSource.completionHint} <a href={feedbackSource.href}>{feedbackSource.label}</a></> : null}</span>} /> : null}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        排序作用于当前筛选下的全部可见待办；未设截止日期排最后。清除排序后恢复状态 → 优先级 → 截止日期顺序。
      </Typography.Paragraph>
      <Table<WorkItemRow>
        className={styles.desktop}
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        tableLayout="fixed"
        scroll={{ x: 870 }}
        locale={{ emptyText: loadError ? "数据未加载" : "当前条件下没有待办" }}
        pagination={false}
        onChange={(_pagination, _filters, sorter, extra) => {
          if (extra.action !== "sort") return;
          const patch = todoSortPatch(Array.isArray(sorter) ? sorter[0] ?? {} : sorter);
          if (patch) listState.setFilter(patch); // Shared list state resets to page 1 and preserves sibling tab parameters.
        }}
      />
      <div className={styles.mobile} data-density={listState.density} aria-busy={loading}>
        {loading ? <div className={styles.empty}><Spin /> 正在加载待办…</div> : data?.rows.length ? (
          <ul className={styles.cards}>{data.rows.map((row) => <li key={row.id} className={styles.card}>
            <div className={styles.meta}><Tag color={PRIORITY_COLOR[row.priority]}>优先级：{PRIORITY_LABEL[row.priority] ?? row.priority}</Tag><ItemStatus row={row} /></div>
            <TodoItemSummary row={row} />
            <div className={styles.cardFooter}><span>截止：{row.dueDate ?? "未设置"}</span><div>{renderActions(row)}</div></div>
          </li>)}</ul>
        ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loadError ? "数据未加载" : "当前条件下没有待办"} />}
      </div>
      <div className={styles.pagination}><Pagination {...listState.paginationProps({ total: data?.total ?? 0 })} size="small" responsive /></div>
      {historyItem ? <TodoHistoryDrawer key={historyItem.id} id={historyItem.id} title={historyItem.title} onClose={() => setHistoryItem(null)} /> : null}
    </section>
  );
}

interface StatsRow {
  groupKey: string; groupLabel: string; month: string; total: number; done: number; onTime: number; overdue: number;
  cancelled: number; suspicious: number; completionRate: number | null; onTimeRate: number | null;
}
interface StatsData { groupBy: "person" | "role"; fromMonth: string; toMonth: string; rows: StatsRow[]; caliber: string }

type StatsFilters = { groupBy?: string; from?: string; to?: string; ownerRole?: string };

export function StatsTab({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadRequest = useRef<AbortController | null>(null);
  const listState = useListState<StatsFilters>({
    key: "todo-stats",
    defaults: { groupBy: "person", from: "", to: "", ownerRole: "" },
    paginated: false,
    paramPrefix: "st",
  });
  const { filters } = listState;

  const load = useCallback(async () => {
    loadRequest.current?.abort();
    const request = new AbortController();
    loadRequest.current = request;
    setLoading(true);
    setLoadError(null);
    setData(null); // Old group/month facts and caliber must disappear before the next request settles.
    try {
      const params = new URLSearchParams({ groupBy: filters.groupBy || "person" });
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      if (filters.ownerRole) params.set("ownerRole", filters.ownerRole);
      const next = await fetchJson<StatsData>(`/api/todo/stats?${params.toString()}`, { signal: request.signal });
      if (!request.signal.aborted) setData(next);
    } catch (e) {
      if (!request.signal.aborted) setLoadError((e as Error).message);
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, [filters.groupBy, filters.from, filters.to, filters.ownerRole]);
  useEffect(() => {
    void load();
    return () => { loadRequest.current?.abort(); };
  }, [load, refreshKey]);

  const columns: ColumnsType<StatsRow> = [
    { title: "月份", dataIndex: "month", width: 90 },
    { title: filters.groupBy === "role" ? "责任角色" : "责任人", dataIndex: "groupLabel", width: 120, render: (v: string) => ROLE_LABEL[v] ?? v },
    { title: "总数", dataIndex: "total", width: 70, align: "right" },
    { title: "已完成", dataIndex: "done", width: 80, align: "right" },
    { title: "按时", dataIndex: "onTime", width: 70, align: "right" },
    { title: "逾期/不按时", dataIndex: "overdue", width: 100, align: "right" },
    { title: "已取消", dataIndex: "cancelled", width: 80, align: "right" },
    { title: "可疑", dataIndex: "suspicious", width: 70, align: "right", render: (v: number) => (v ? <Tag color="orange">{v}</Tag> : 0) },
    { title: "完成率", dataIndex: "completionRate", width: 90, align: "right", render: (v: number | null) => (v == null ? "—" : `${v}%`) },
    { title: "按时率", dataIndex: "onTimeRate", width: 90, align: "right", render: (v: number | null) => (v == null ? "—" : `${v}%`) },
  ];

  const onExport = () => {
    if (!data || loading || loadError) return;
    exportCsv(
      `待办完成率-${data.groupBy}-${data.fromMonth}_${data.toMonth}.csv`,
      ["月份", "分组", "总数", "已完成", "按时", "逾期/不按时", "已取消", "可疑", "完成率%", "按时率%"],
      data.rows.map((r) => [r.month, ROLE_LABEL[r.groupLabel] ?? r.groupLabel, r.total, r.done, r.onTime, r.overdue, r.cancelled, r.suspicious, r.completionRate ?? "", r.onTimeRate ?? ""]),
    );
  };

  return (
    <section className={styles.list} aria-label="待办完成率统计">
      <CaliberNote summary="只读统计，不打分；绩效 = 证据导出（D61）。" detail={data?.caliber} />
      <ListToolbar
        state={listState}
        onExport={data && !loading && !loadError ? onExport : undefined}
        exportText="导出证据 CSV"
        extra={(
          <div className={styles.filters}>
            <Select
              aria-label="完成率分组"
              value={filters.groupBy || "person"}
              onChange={(v) => listState.setFilter({ groupBy: v })}
              options={[{ value: "person", label: "按人×月" }, { value: "role", label: "按角色×月" }]}
            />
            <DatePicker.RangePicker
              className={styles.monthRange}
              picker="month"
              value={[filters.from ? dayjs(filters.from) : null, filters.to ? dayjs(filters.to) : null]}
              onChange={(v) => listState.setFilter({ from: v?.[0]?.format("YYYY-MM") ?? "", to: v?.[1]?.format("YYYY-MM") ?? "" })}
            />
            <Select
              allowClear
              placeholder="责任角色"
              aria-label="完成率责任角色"
              value={filters.ownerRole || undefined}
              onChange={(v) => listState.setFilter({ ownerRole: v ?? "" })}
              options={ROLE_OPTIONS}
            />
          </div>
        )}
      />
      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="待办完成率" retrying={loading} />
      <Table<StatsRow>
        className={styles.desktop}
        rowKey={(r) => `${r.groupKey}|${r.month}`}
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        tableLayout="fixed"
        scroll={{ x: 860 }}
        locale={{ emptyText: loadError ? "数据未加载" : "当前条件下没有待办统计" }}
        pagination={false}
      />
      <div className={styles.mobile} data-density={listState.density} aria-busy={loading}>
        {loading ? <div className={styles.empty}><Spin /> 正在加载统计…</div> : data?.rows.length ? (
          <ul className={styles.cards} aria-label="待办完成率明细">{data.rows.map((r) => (
            <li key={`${r.groupKey}|${r.month}`} className={styles.card}>
              <div className={styles.statsHeading}><strong>{ROLE_LABEL[r.groupLabel] ?? r.groupLabel}</strong><span>{r.month}</span></div>
              <dl className={styles.rates}>
                <div><dt>完成率</dt><dd>{r.completionRate == null ? "—" : `${r.completionRate}%`}</dd></div>
                <div><dt>按时率</dt><dd>{r.onTimeRate == null ? "—" : `${r.onTimeRate}%`}</dd></div>
              </dl>
              <dl className={styles.counts}>
                <div><dt>总数</dt><dd>{r.total}</dd></div>
                <div><dt>已完成</dt><dd>{r.done}</dd></div>
                <div><dt>按时</dt><dd>{r.onTime}</dd></div>
                <div><dt>逾期/不按时</dt><dd>{r.overdue}</dd></div>
                <div><dt>已取消</dt><dd>{r.cancelled}</dd></div>
                <div><dt>可疑</dt><dd>{r.suspicious ? <Tag color="orange">{r.suspicious}</Tag> : 0}</dd></div>
              </dl>
            </li>
          ))}</ul>
        ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loadError ? "数据未加载" : "当前条件下没有待办统计"} />}
      </div>
    </section>
  );
}

export default function TodoClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = todoTabFromQuery(searchParams.toString());
  const me = useMe();
  const assignees = useAssignees();
  const [drawer, setDrawer] = useState(false);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const items = useMemo(() => [
    { key: "mine", label: "我的待办", children: <ItemTable view="mine" prefix="mine" assignees={assignees} refreshKey={tick} onChanged={bump} /> },
    { key: "all", label: "全部待办", children: <ItemTable view="all" prefix="all" assignees={assignees} refreshKey={tick} onChanged={bump} /> },
    { key: "stats", label: "完成率", children: <StatsTab refreshKey={tick} /> },
  ], [assignees, tick, bump]);

  return (
    <div>
      <Row justify="space-between" align="middle" style={{ marginBottom: 8 }}>
        <Col><Typography.Title level={4} style={{ margin: 0 }}>待办任务</Typography.Title></Col>
        <Col><Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawer(true)}>新建待办</Button></Col>
      </Row>
      <CaliberNote
        summary="系统告警 / 复核项自动生成待办（同来源只建一条）；手工待办不计入完成率。单据审批在「待我审批」。"
        detail={<div>部门按责任角色划分（D61）。同来源 7 天内再触发则重新打开而不是新建。完成率 = 已完成 ÷ (总数 − 已取消)；按时率 = 按时完成 ÷ 已完成；创建后不足 10 分钟即关闭标「可疑」。审批类事项不在这里，见顶部菜单「待我审批」。</div>}
      />
      <div style={{ marginBottom: 12 }}><TodoProgressCard refreshKey={tick} /></div>
      {me ? <TodoNoteRecovery key={`${me.id}:${me.roles.join(",")}`} actorId={me.id} /> : null}
      <Tabs
        activeKey={activeTab}
        onChange={(tab) => router.push(todoTabHref(searchParams.toString(), tab), { scroll: false })}
        destroyOnHidden={false}
        items={items}
      />
      {drawer && (
        <TodoCreateDrawer
          defaultAssigneeId={me?.id}
          assigneeOptions={assignees.map((a) => ({ value: a.id, label: `${a.name}（${a.roles.map((r) => ROLE_LABEL[r] ?? r).join("/")}）` }))}
          roleOptions={ROLE_OPTIONS}
          priorityOptions={Object.entries(PRIORITY_LABEL).map(([value, label]) => ({ value, label }))}
          onCancel={() => setDrawer(false)}
          onCreated={() => { setDrawer(false); bump(); }}
        />
      )}
    </div>
  );
}
