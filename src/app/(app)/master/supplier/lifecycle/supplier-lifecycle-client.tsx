"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Grid,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { CheckCircleOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { submitSupplierWork, supplierWorkHref } from "@/components/supplier-lifecycle-request";
import ListToolbar from "@/components/ListToolbar";
import RemoteSelect, { type RemoteRow } from "@/components/RemoteSelect";
import SearchInput from "@/components/SearchInput";
import { useListState } from "@/components/useListState";
import { hasAnyRole, useMe } from "@/components/useMe";
import {
  SUPPLIER_STATUS_COLORS,
  SUPPLIER_STATUS_LABELS,
} from "@/components/labels";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { useDocumentRead } from "@/components/useDocumentRead";
import CaliberNote from "@/components/CaliberNote";
import { todayShanghai } from "@/server/core/business-day";
import type { SupplierTermSnapshot, SupplierTermAgreement } from "@/server/modules/master/supplier-lifecycle";

type CaseKind = "admission" | "corrective" | "payment_term";
type CaseStatus = "open" | "closed";
type Priority = "normal" | "high" | "critical";

interface LifecycleRow {
  id: number;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  supplierStatus: string;
  kind: CaseKind;
  status: CaseStatus;
  priority: Priority;
  reason: string;
  dueDate: string;
  overdue: boolean;
  ownerId: number;
  ownerName: string;
  pauseNewOrders: boolean;
  supplierStatusBefore: string;
  supplierStatusAfter: string;
  outcome: string | null;
  closureNote: string | null;
  createdAt: string;
  closedAt: string | null;
  targetCreditDays: number | null;
  termBaseline: SupplierTermSnapshot | null;
  termCurrent: SupplierTermSnapshot;
  termAgreement: SupplierTermAgreement | null;
  termChanged: boolean;
  progressNote: string | null;
  version: number;
}

interface LifecycleData {
  rows: LifecycleRow[];
  total: number;
  owners: Array<{ id: number; name: string }>;
  summary: {
    open: number;
    overdue: number;
    admissions: number;
    corrective: number;
    negotiations: number;
  };
}

const KIND_LABELS: Record<CaseKind, string> = {
  admission: "准入评审",
  corrective: "整改闭环",
  payment_term: "账期谈判",
};
const PRIORITY_LABELS: Record<Priority, string> = {
  normal: "常规",
  high: "高",
  critical: "紧急",
};
const PRIORITY_COLORS: Record<Priority, string> = {
  normal: "default",
  high: "orange",
  critical: "red",
};
const OUTCOME_LABELS: Record<string, string> = {
  approved: "准入通过",
  rejected: "退回补充",
  resolved: "整改完成",
  failed: "整改失败",
};

// Header and footer keep their natural height; only the form body shrinks/scrolls.
const modalStyles = {
  content: { display: "flex", flexDirection: "column" as const, maxHeight: "calc(100dvh - 48px)" },
  header: { flexShrink: 0 },
  body: { minHeight: 0, overflowY: "auto" as const, overflowWrap: "anywhere" as const },
  footer: { flexShrink: 0 },
};

interface OpenForm {
  supplierId: number;
  kind: CaseKind;
  priority: Priority;
  reason: string;
  dueDate: Dayjs;
  pauseNewOrders: boolean;
  ownerId: number;
  targetCreditDays?: number;
}

interface CloseForm {
  outcome: "approved" | "rejected" | "resolved" | "failed";
  finalStatus?: "qualified" | "paused" | "blacklisted";
  closureNote: string;
  creditDays?: number;
  effectiveFrom?: Dayjs;
  paymentTerm?: string;
  evidenceRef?: string;
}

interface FollowForm { ownerId: number; dueDate: Dayjs; note: string; confirmCurrentTerm: boolean }
function termText(term: SupplierTermSnapshot | null): string {
  if (!term) return "未记录";
  const label = ({ monthly_credit: "月结", prepay: "预付", on_delivery: "款到发货" } as Record<string, string>)[term.paymentTermType ?? ""] ?? "类型待核对";
  return `${label}${term.paymentTermType === "monthly_credit" ? ` ${term.creditDays ?? "待核对"} 天` : ""} · ${term.paymentTermEffectiveFrom ?? "缺生效日"}`;
}
function outcomeText(row: LifecycleRow): string {
  if (row.status === "open") return row.overdue ? "已逾期" : "进行中";
  if (row.kind === "payment_term") return row.outcome === "resolved" ? "协议已登记" : "未达成";
  return OUTCOME_LABELS[row.outcome ?? ""] ?? "已关闭";
}
function TermEvidence({ row, summaryOnly = false }: { row: LifecycleRow; summaryOnly?: boolean }) {
  if (row.kind !== "payment_term") return null;
  const agreement = row.termAgreement;
  return <Space direction="vertical" size={4} style={{ width: "100%", overflowWrap: "anywhere" }}>
    <Typography.Text>目标 {row.targetCreditDays} 天 · 基线：{termText(row.termBaseline)}</Typography.Text>
    {row.termChanged ? <Alert type="warning" showIcon message={`主档已变化：${termText(row.termCurrent)}。先跟进核对，不能直接覆盖。`} /> : null}
    {agreement ? <>
      <Typography.Text strong>协议：月结 {agreement.creditDays} 天 · {agreement.effectiveFrom} 生效</Typography.Text>
      <Space wrap size={4}>
        <Tag color={agreement.effectiveFrom > todayShanghai() ? "gold" : "blue"}>{agreement.effectiveFrom > todayShanghai() ? "待生效" : "协议生效日已到"}</Tag>
        <Tag color={agreement.creditDays >= (row.targetCreditDays ?? 45) ? "green" : "orange"}>{agreement.creditDays >= (row.targetCreditDays ?? 45) ? "达到本项目天数目标" : "未达到本项目天数目标"}</Tag>
      </Space>
      {!summaryOnly ? <>
        <Typography.Text>协议依据：{agreement.evidenceRef}</Typography.Text>
        <Typography.Text type="secondary">{agreement.paymentTerm}；历史登记，不代表当前主档仍采用该协议。</Typography.Text>
      </> : null}
    </> : null}
  </Space>;
}
interface CaseEvent { id: number; at: string; actorName: string | null; action: string; after: { progressNote?: string; closureNote?: string; reason?: string; ownerId?: number; dueDate?: string; confirmedCurrentTerm?: boolean } | null }
function LifecycleEvidence({ row, cursor, onCursorChange }: {
  row: LifecycleRow;
  cursor: number | null;
  onCursorChange: (cursor: number | null) => void;
}) {
  const read = useDocumentRead<{ history: CaseEvent[]; nextCursor: number | null }>(`/api/master/supplier/lifecycle/${row.id}${cursor ? `?beforeAuditId=${cursor}` : ""}`);
  return <div className="supplier-lifecycle-evidence">
    <details style={{ marginBottom: 12 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>完整发起依据{row.kind === "payment_term" ? "与协议" : ""}</summary>
      <Typography.Paragraph style={{ marginTop: 8 }}>{row.reason}</Typography.Paragraph>
      <TermEvidence row={row} />
    </details>
    <Typography.Text strong>跟进与结果记录（按时间倒序）</Typography.Text>
    <LoadErrorAlert error={read.error} onRetry={read.retry} subject="工作项记录" retrying={read.phase === "loading"} />
    {read.phase === "loading" ? <Typography.Paragraph type="secondary">正在读取记录…</Typography.Paragraph> : null}
    {read.data?.history.map(event => <details key={event.id} style={{ paddingBlock: 8, borderBottom: "1px solid #f0f0f0" }}>
      <summary style={{ cursor: "pointer" }}>
        {({ create: "发起", follow_up: "跟进", close: "关案" } as Record<string, string>)[event.action] ?? event.action} · {event.actorName ?? "历史用户"}
        <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>{new Date(event.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（上海）</Typography.Text>
      </summary>
      <Typography.Paragraph type="secondary">责任人 {event.after?.ownerId != null ? `#${event.after.ownerId}` : "未记录"} · 截止 {event.after?.dueDate ?? "未记录"}</Typography.Paragraph>
      <Typography.Paragraph>{event.action === "follow_up" ? event.after?.progressNote : event.action === "close" ? event.after?.closureNote : event.after?.reason}{event.after?.confirmedCurrentTerm ? "（已显式核对当时主档条款）" : ""}</Typography.Paragraph>
    </details>)}
    <Space wrap style={{ marginTop: 8 }}>
      {read.data?.nextCursor ? <Button size="small" onClick={() => onCursorChange(read.data!.nextCursor)}>更早记录</Button> : null}
      {cursor ? <Button size="small" onClick={() => onCursorChange(null)}>返回最新记录</Button> : null}
    </Space>
  </div>;
}

export default function SupplierLifecycleClient() {
  const { message } = App.useApp();
  const me = useMe();
  const screens = Grid.useBreakpoint();
  const canWrite = hasAnyRole(me, "purchasing");
  const [openForm] = Form.useForm<OpenForm>();
  const [closeForm] = Form.useForm<CloseForm>();
  const [followForm] = Form.useForm<FollowForm>();
  const [saving, setSaving] = useState(false);
  const [openModal, setOpenModal] = useState(false);
  const [closing, setClosing] = useState<LifecycleRow | null>(null);
  const [following, setFollowing] = useState<LifecycleRow | null>(null);
  const [searchText, setSearchText] = useState("");
  const [writeError, setWriteError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ id: number; summary: string } | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  // AntD remounts expanded rows when responsive columns change. Keep navigation
  // above the table, scoped to this case revision so newly saved evidence starts fresh.
  const [historyCursors, setHistoryCursors] = useState<Record<string, number | null>>({});
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const createKey = useRef<string | null>(null);
  const saveLock = useRef(false);
  const kind = Form.useWatch("kind", openForm) ?? "corrective";
  const closeOutcome = Form.useWatch("outcome", closeForm);

  const listState = useListState({
    key: "supplier-lifecycle",
    defaults: { q: "", status: "open", kind: "", supplierId: "", caseId: "", ownerId: "", sort: "", order: "" },
    defaultPageSize: 20,
  });
  const { filters } = listState;
  const apiQuery = listState.queryString();
  const read = useDocumentRead<LifecycleData>(`/api/master/supplier/lifecycle?${apiQuery}`);
  const { data, error: loadError, retry: load } = read;
  const loading = read.phase === "loading";
  useEffect(() => {
    setSearchText(filters.q);
  }, [filters.q]);
  useEffect(() => { setExpandedKeys(filters.caseId ? [Number(filters.caseId)] : []); }, [filters.caseId]);

  const showCreate = () => {
    setWriteError(null);
    createKey.current = globalThis.crypto.randomUUID();
    openForm.resetFields();
    openForm.setFieldsValue({
      kind: filters.kind === "payment_term" ? "payment_term" : "corrective",
      priority: "normal",
      dueDate: filters.kind === "payment_term" ? dayjs(todayShanghai()).endOf("year") : dayjs(todayShanghai()).add(14, "day"),
      pauseNewOrders: false,
      supplierId: filters.supplierId ? Number(filters.supplierId) : undefined,
      ownerId: me?.id, targetCreditDays: 60,
    });
    setOpenModal(true);
  };

  const submitOpen = async () => {
    if (saveLock.current) return;
    saveLock.current = true;
    try {
      const value = await openForm.validateFields();
      setSaving(true);
      setWriteError(null);
      const result = await submitSupplierWork("/api/master/supplier/lifecycle", "POST", {
        ...value,
        pauseNewOrders: value.kind === "corrective" ? value.pauseNewOrders : false,
        targetCreditDays: value.kind === "payment_term" ? value.targetCreditDays : undefined,
        dueDate: value.dueDate.format("YYYY-MM-DD"),
        idempotencyKey: createKey.current,
      });
      if (!mounted.current) return;
      setReceipt({ id: result.id, summary: `${KIND_LABELS[value.kind]}已发起` });
      message.success(`${KIND_LABELS[value.kind]}已发起`);
      setOpenModal(false);
      await load();
    } catch (error) {
      if (mounted.current && error instanceof Error) setWriteError(error.message);
    } finally {
      if (mounted.current) setSaving(false);
      saveLock.current = false;
    }
  };

  const showClose = useCallback((row: LifecycleRow) => {
    setWriteError(null);
    closeForm.resetFields();
    closeForm.setFieldsValue({
      outcome: row.kind === "admission" ? "approved" : "resolved",
      finalStatus: row.kind === "corrective" ? "qualified" : undefined,
      creditDays: row.targetCreditDays ?? undefined,
    });
    setClosing(row);
  }, [closeForm]);

  const submitClose = async () => {
    if (!closing || saveLock.current) return;
    saveLock.current = true;
    try {
      const value = await closeForm.validateFields();
      setSaving(true);
      setWriteError(null);
      const result = await submitSupplierWork(`/api/master/supplier/lifecycle/${closing.id}`, "PATCH", {
        outcome: value.outcome, finalStatus: value.finalStatus, closureNote: value.closureNote,
        expectedVersion: closing.version,
        agreement: closing.kind === "payment_term" && value.outcome === "resolved" ? {
          creditDays: value.creditDays, effectiveFrom: value.effectiveFrom?.format("YYYY-MM-DD"),
          paymentTerm: value.paymentTerm, evidenceRef: value.evidenceRef,
        } : undefined,
      });
      if (!mounted.current) return;
      const summary = closing.kind === "payment_term" ? "谈判结果已登记；协议生效和达标另行判断" : "工作项已关闭，供应商状态与审计已同步";
      setReceipt({ id: result.id, summary });
      message.success(summary);
      setClosing(null);
      await load();
    } catch (error) {
      if (mounted.current && error instanceof Error) setWriteError(error.message);
    } finally {
      if (mounted.current) setSaving(false);
      saveLock.current = false;
    }
  };

  const showFollow = useCallback((row: LifecycleRow) => {
    setWriteError(null);
    followForm.resetFields();
    followForm.setFieldsValue({ ownerId: row.ownerId, dueDate: dayjs(row.dueDate), confirmCurrentTerm: false });
    setFollowing(row);
  }, [followForm]);
  const submitFollow = async () => {
    if (!following || saveLock.current) return;
    saveLock.current = true;
    try {
      const value = await followForm.validateFields(); setSaving(true); setWriteError(null);
      const result = await submitSupplierWork(`/api/master/supplier/lifecycle/${following.id}`, "PATCH", { ...value, operation: "follow_up", expectedVersion: following.version,
        confirmedTerm: value.confirmCurrentTerm ? following.termCurrent : undefined, dueDate: value.dueDate.format("YYYY-MM-DD") });
      if (!mounted.current) return;
      setReceipt({ id: result.id, summary: "跟进已记录，历史保留" });
      message.success("跟进已记录，历史保留"); setFollowing(null); load();
    } catch (error) { if (mounted.current && error instanceof Error) setWriteError(error.message); }
    finally { if (mounted.current) setSaving(false); saveLock.current = false; }
  };

  const columns = useMemo<ColumnsType<LifecycleRow>>(
    () => [
      {
        title: "供应商",
        dataIndex: "supplierName",
        key: "supplierCode",
        width: 210,
        fixed: "left",
        sorter: true,
        sortOrder: filters.sort === "supplierCode" ? filters.order === "descend" ? "descend" : "ascend" : null,
        render: (name: string, row) => (
          <Space direction="vertical" size={0}>
            <Typography.Text strong>{name}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.supplierCode}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: "类型",
        dataIndex: "kind",
        width: 105,
        render: (value: CaseKind) => (
          <Tag color={value === "admission" ? "blue" : "purple"}>{KIND_LABELS[value]}</Tag>
        ),
      },
      {
        title: "优先级",
        dataIndex: "priority",
        width: 90,
        sorter: true,
        sortOrder: filters.sort === "priority" ? filters.order === "descend" ? "descend" : "ascend" : null,
        render: (value: Priority) => (
          <Tag color={PRIORITY_COLORS[value]}>{PRIORITY_LABELS[value]}</Tag>
        ),
      },
      {
        title: "原因与要求",
        dataIndex: "reason",
        width: 320,
        ellipsis: true,
      },
      {
        title: "责任人",
        dataIndex: "ownerName",
        width: 110,
        sorter: true,
        sortOrder: filters.sort === "ownerName" ? filters.order === "descend" ? "descend" : "ascend" : null,
      },
      {
        title: "截止日",
        dataIndex: "dueDate",
        width: 120,
        sorter: true,
        sortOrder: filters.sort === "dueDate" ? filters.order === "descend" ? "descend" : "ascend" : null,
        render: (value: string, row) => (
          <Typography.Text type={row.overdue ? "danger" : undefined} strong={row.overdue}>
            {value}{row.overdue ? " · 逾期" : ""}
          </Typography.Text>
        ),
      },
      {
        title: "供应商状态",
        dataIndex: "supplierStatus",
        width: 115,
        render: (value: string) => (
          <Tag color={SUPPLIER_STATUS_COLORS[value]}>
            {SUPPLIER_STATUS_LABELS[value] ?? value}
          </Tag>
        ),
      },
      {
        title: "工作项",
        dataIndex: "status",
        width: 95,
        render: (value: CaseStatus, row) =>
          value === "open" ? (
            <Tag color={row.overdue ? "error" : "processing"}>{row.overdue ? "已逾期" : "进行中"}</Tag>
          ) : (
            <Tag color={row.outcome === "failed" || row.outcome === "rejected" ? "default" : "success"}>{outcomeText(row)}</Tag>
          ),
      },
      {
        title: "操作",
        key: "actions",
        width: 160,
        fixed: "right",
        render: (_value, row) =>
          row.status === "open" && canWrite ? (
            <Space size={0} wrap><Button type="link" size="small" onClick={() => showFollow(row)}>跟进</Button><Button
              type="link"
              size="small"
              icon={<CheckCircleOutlined />}
              onClick={() => showClose(row)}
            >
              记录结果
            </Button></Space>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          ),
      },
    ],
    [canWrite, showClose, showFollow, filters.sort, filters.order],
  );
  const compactColumns: ColumnsType<LifecycleRow> = [{ title: "供应商工作项与下一步", key: "compact", render: (_, row) => (
    <Space direction="vertical" size={6} style={{ width: "100%", overflowWrap: "anywhere", whiteSpace: "normal" }}>
      <Typography.Text strong>#{row.id} · {row.supplierCode} · {row.supplierName}</Typography.Text>
      <Space wrap size={4}><Tag>{KIND_LABELS[row.kind]}</Tag><Tag color={row.overdue ? "red" : "default"}>{outcomeText(row)}</Tag><Tag color={PRIORITY_COLORS[row.priority]}>{PRIORITY_LABELS[row.priority]}</Tag></Space>
      <Typography.Text>{row.ownerName} · 截止 {row.dueDate} · {SUPPLIER_STATUS_LABELS[row.supplierStatus]}</Typography.Text>
      <Typography.Text>{row.reason.length > 56 ? `${row.reason.slice(0, 56)}…` : row.reason}</Typography.Text>
      <TermEvidence row={row} summaryOnly />
      {row.progressNote ? <Typography.Text type="secondary">最新跟进：{row.progressNote.length > 56 ? `${row.progressNote.slice(0, 56)}…` : row.progressNote}</Typography.Text> : null}
      <Button type="link" size="small" onClick={() => setExpandedKeys(keys => keys.includes(row.id) ? keys.filter(id => id !== row.id) : [...keys, row.id])} aria-expanded={expandedKeys.includes(row.id)}>
        {expandedKeys.includes(row.id) ? "收起完整依据与记录" : "完整依据与记录"}
      </Button>
      {row.status === "open" && canWrite ? <Space wrap size={4}><Button size="small" onClick={() => showFollow(row)}>跟进</Button><Button size="small" onClick={() => showClose(row)}>记录结果</Button></Space> : null}
    </Space>
  ) }];

  return (
    <div className="supplier-lifecycle-page">
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 4 }}>
        供应商工作项
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        准入、整改、账期谈判统一跟进；记分卡提供证据，采购作出决定。
      </Typography.Paragraph>

      <CaliberNote summary="责任人 → 跟进 → 协议/结果 → 留痕；谈成不等于已生效。" detail={<>
        <p>账期谈判不暂停新单或改变准入状态。登记协议必须有实际天数、生效日及协议编号/受控文件位置。未来条款保持待生效；历史关案不代表当前主档仍采用该协议。</p>
        <p>目标45–60天不等于自动判定全部供应商；合作历史和同级品牌政策仍需真实证据。工作项不是应付余额或财务付款指令。</p>
        <p>列表排序覆盖全部筛选结果。创建回执不确定时保留本次请求重试；跟进版本冲突须刷新核对，不自动覆盖。</p>
      </>} />

      <LoadErrorAlert error={loadError} onRetry={load} subject="供应商工作项" retrying={loading} />
      {receipt ? <Alert className="supplier-work-receipt" type="success" showIcon closable onClose={() => setReceipt(null)}
        message={`工作项 #${receipt.id}：${receipt.summary}`} style={{ marginBottom: 12 }}
        description={<Typography.Link href={supplierWorkHref(receipt.id)}>查看工作项 #{receipt.id} 与完整记录</Typography.Link>} /> : null}

      <Row gutter={[12, 12]} className="supplier-lifecycle-kpis">
        <Col xs={12} md={6}><Card size="small"><Statistic title="进行中" value={data ? data.summary.open : "—"} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="已逾期" value={data ? data.summary.overdue : "—"} valueStyle={{ color: data?.summary.overdue ? "#cf1322" : undefined }} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="准入 / 整改" value={data ? `${data.summary.admissions} / ${data.summary.corrective}` : "—"} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="谈判中" value={data ? data.summary.negotiations : "—"} /></Card></Col>
      </Row>

      <ListToolbar
        state={listState}
        extra={(
          <>
            <SearchInput
              allowClear
              value={searchText}
              placeholder="搜索供应商或原因"
              style={{ width: 260 }}
              onChange={(event) => {
                const value = event.target.value;
                setSearchText(value);
                if (!value) listState.setFilter({ q: "" });
              }}
              onSearch={(value) => listState.setFilter({ q: value.trim() })}
            />
            <Select
              aria-label="工作项状态"
              value={filters.status}
              style={{ width: 120 }}
              options={[
                { value: "", label: "全部状态" },
                { value: "open", label: "进行中" },
                { value: "closed", label: "已关闭" },
              ]}
              onChange={(value) => listState.setFilter({ status: value })}
            />
            <Select
              aria-label="工作项类型"
              value={filters.kind}
              style={{ width: 130 }}
              options={[
                { value: "", label: "全部类型" },
                { value: "admission", label: "准入评审" },
                { value: "corrective", label: "整改闭环" },
                { value: "payment_term", label: "账期谈判" },
              ]}
              onChange={(value) => listState.setFilter({ kind: value })}
            />
            <Select aria-label="责任人筛选" value={filters.ownerId} style={{ width: 150 }} options={[{ value: "", label: "全部责任人" }, ...(data?.owners ?? []).map(owner => ({ value: String(owner.id), label: owner.name }))]} onChange={value => listState.setFilter({ ownerId: value })} />
            {filters.supplierId ? <Tag closable onClose={() => listState.setFilter({ supplierId: "" })}>供应商 #{filters.supplierId}</Tag> : null}
            {filters.caseId ? <Tag closable onClose={() => listState.setFilter({ caseId: "" })}>工作项 #{filters.caseId}</Tag> : null}
            {!screens.lg ? <Select aria-label="排序" style={{ width: 170 }} value={`${filters.sort}:${filters.order}`} options={[{ value: ":", label: "优先级 / 截止日" }, { value: "dueDate:ascend", label: "截止日：近到远" }, { value: "dueDate:descend", label: "截止日：远到近" }, { value: "supplierCode:ascend", label: "供应商编码升序" }]} onChange={value => { const [sort, order] = value.split(":"); listState.setFilter({ sort, order }); }} /> : null}
          </>
        )}
        primaryActions={(
          <>
            <Button aria-label="刷新供应商工作项" aria-busy={loading} icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
            {canWrite ? <Button type="primary" icon={<PlusOutlined />} onClick={showCreate} disabled={!data}>发起工作项</Button> : null}
          </>
        )}
      />

      <Table<LifecycleRow>
        rowKey="id"
        className="supplier-lifecycle-table"
        loading={loading}
        size={listState.tableSize}
        columns={screens.lg ? columns : compactColumns}
        dataSource={data?.rows ?? []}
        pagination={listState.paginationProps({ total: data?.total })}
        scroll={{ x: screens.lg ? 1325 : undefined }}
        onChange={(_pagination, _filters, sorter, extra) => {
          if (extra.action !== "sort") return;
          const selected = Array.isArray(sorter) ? sorter[0] : sorter;
          listState.setFilter({ sort: selected.order ? String(selected.columnKey ?? selected.field) : "", order: selected.order ?? "" });
        }}
        locale={{ emptyText: loadError ? "数据未加载" : "当前条件下无供应商工作项" }}
        expandable={{
          expandedRowKeys: expandedKeys,
          onExpandedRowsChange: keys => setExpandedKeys([...keys]),
          expandedRowRender: (row) => <LifecycleEvidence key={`${row.id}:${row.version}`} row={row}
            cursor={historyCursors[`${row.id}:${row.version}`] ?? null}
            onCursorChange={cursor => setHistoryCursors(current => ({ ...current, [`${row.id}:${row.version}`]: cursor }))}
          />,
        }}
      />

      <Modal
        title="发起供应商工作项"
        open={openModal}
        onOk={() => void submitOpen()}
        onCancel={() => { if (!saving) setOpenModal(false); }}
        confirmLoading={saving}
        okText="发起"
        okButtonProps={{ "aria-label": "发起供应商工作项", "aria-busy": saving }}
        cancelText="取消"
        maskClosable={false}
        closable={!saving}
        keyboard={!saving}
        cancelButtonProps={{ disabled: saving }}
        style={{ top: 24 }}
        styles={modalStyles}
        destroyOnHidden
      >
        {writeError ? <Alert type="error" showIcon message="未取得成功回执" description={writeError} style={{ marginBottom: 12 }} /> : null}
        <Form form={openForm} layout="vertical" disabled={saving}>
          <Form.Item name="kind" label="类型" rules={[{ required: true }]}>
            <Select options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
          <Form.Item name="supplierId" label="供应商" rules={[{ required: true, message: "请选择供应商" }]}>
            <RemoteSelect
              api="/api/master/supplier"
              getLabel={(row) => `${String(row.code)} · ${String(row.name)}`}
              filterRow={(row: RemoteRow) =>
                kind === "admission"
                  ? row.status === "pending"
                  : row.status === "qualified" || row.status === "paused"
              }
              placeholder={kind === "admission" ? "选择准入中供应商" : "选择合格或暂停供应商"}
            />
          </Form.Item>
          <Form.Item name="priority" label="优先级" rules={[{ required: true }]}>
            <Select options={Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
          <Form.Item name="ownerId" label="责任人" rules={[{ required: true, message: "请选择实际负责的采购同事" }]}><Select options={(data?.owners ?? []).map(owner => ({ value: owner.id, label: owner.name }))} /></Form.Item>
          {kind === "payment_term" ? <Form.Item name="targetCreditDays" label="目标账期（天）" rules={[{ required: true }]}><InputNumber min={45} max={60} precision={0} style={{ width: "100%" }} /></Form.Item> : null}
          <Form.Item name="dueDate" label="截止日" rules={[{ required: true, message: "请选择截止日" }]}>
            <DatePicker style={{ width: "100%" }} disabledDate={(date) => date.format("YYYY-MM-DD") < todayShanghai()} />
          </Form.Item>
          <Form.Item name="reason" label={kind === "admission" ? "准入依据与待核事项" : "问题、目标与完成标准"} rules={[{ required: true }]}>
            <Input.TextArea rows={4} maxLength={500} showCount style={{ marginBottom: 20 }} placeholder="写明证据缺口、责任动作与可验证的完成标准" />
          </Form.Item>
          {kind === "corrective" ? (
            <Form.Item name="pauseNewOrders" label="发起时暂停新订单" valuePropName="checked">
              <Switch checkedChildren="暂停" unCheckedChildren="不暂停" />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>

      <Modal
        title={closing ? `完成${KIND_LABELS[closing.kind]} · ${closing.supplierName}` : "完成工作项"}
        open={closing != null}
        onOk={() => void submitClose()}
        onCancel={() => { if (!saving) setClosing(null); }}
        confirmLoading={saving}
        okText="确认完成"
        okButtonProps={{ "aria-label": "确认完成", "aria-busy": saving }}
        cancelText="取消"
        maskClosable={false}
        closable={!saving}
        keyboard={!saving}
        cancelButtonProps={{ disabled: saving }}
        style={{ top: 24 }}
        styles={modalStyles}
        destroyOnHidden
      >
        {writeError ? <Alert type="error" showIcon message="未取得成功回执" description={<>{writeError} {closing ? <Typography.Link href={supplierWorkHref(closing.id)} target="_blank" rel="noopener noreferrer">新页核对记录（本页输入保留）</Typography.Link> : null}</>} style={{ marginBottom: 12 }} /> : null}
        <Form form={closeForm} layout="vertical" disabled={saving}>
          {closing?.kind === "payment_term" ? <div style={{ marginBottom: 12 }}><TermEvidence row={closing} /></div> : null}
          <Form.Item name="outcome" label="结果" rules={[{ required: true }]}>
            <Select
              onChange={(value: CloseForm["outcome"]) => {
                if (closing?.kind !== "corrective") return;
                closeForm.setFieldValue("finalStatus", value === "failed" ? "paused" : "qualified");
              }}
              options={
                closing?.kind === "admission"
                  ? [
                      { value: "approved", label: "准入通过（转为合格）" },
                      { value: "rejected", label: "退回补充（保持准入中）" },
                    ]
                  : closing?.kind === "payment_term" ? [
                    { value: "resolved", label: "协议达成（登记实际条款）" }, { value: "failed", label: "未达成（保留主档）" },
                  ] : [
                      { value: "resolved", label: "整改完成" },
                      { value: "failed", label: "整改失败" },
                    ]
              }
            />
          </Form.Item>
          {closing?.kind === "corrective" ? (
            <Form.Item
              name="finalStatus"
              label="完成后的供应商状态"
              rules={[{ required: closeOutcome === "failed", message: "整改失败时必须选择暂停或黑名单" }]}
            >
              <Select
                options={
                  closeOutcome === "failed"
                    ? [
                        { value: "paused", label: "暂停" },
                        { value: "blacklisted", label: "黑名单（禁止新单）" },
                      ]
                    : [
                        { value: "qualified", label: "合格" },
                        { value: "paused", label: "保持暂停" },
                      ]
                }
              />
            </Form.Item>
          ) : null}
          {closing?.kind === "payment_term" && closeOutcome === "resolved" ? <>
            <Form.Item name="creditDays" label="协议实际月结天数" rules={[{ required: true }]}><InputNumber min={1} max={180} precision={0} style={{ width: "100%" }} /></Form.Item>
            <Form.Item name="effectiveFrom" label="协议生效日" rules={[{ required: true }]}><DatePicker style={{ width: "100%" }} /></Form.Item>
            <Form.Item name="paymentTerm" label="条款原文" rules={[{ required: true, max: 500 }]}><Input.TextArea rows={2} maxLength={500} /></Form.Item>
            <Form.Item name="evidenceRef" label="协议编号 / 受控文件位置" rules={[{ required: true, min: 5, max: 500 }]}><Input placeholder="能由相关人员回查的协议编号或存放位置，不填银行密码" maxLength={500} /></Form.Item>
            <Alert type="info" showIcon message="只登记实际协议；未来生效不提前达标，低于目标也须如实记录。" style={{ marginBottom: 12 }} />
          </> : null}
          <Form.Item name="closureNote" label="完成证据" rules={[{ required: true, min: 5, message: "请填写至少 5 个字的完成证据" }]}>
            <Input.TextArea rows={4} maxLength={1000} showCount style={{ marginBottom: 20 }} placeholder="记录核验结果、附件位置、后续限制或复查要求" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal title={following ? `跟进 · ${following.supplierName}` : "跟进工作项"} open={following != null}
        onOk={() => void submitFollow()} onCancel={() => { if (!saving) setFollowing(null); }} confirmLoading={saving}
        okText="记录跟进" okButtonProps={{ "aria-label": "记录跟进", "aria-busy": saving }} cancelText="取消" maskClosable={false} destroyOnHidden style={{ top: 24 }}
        closable={!saving} keyboard={!saving} cancelButtonProps={{ disabled: saving }} styles={modalStyles}>
        {writeError ? <Alert type="error" showIcon message="未取得成功回执" description={<>{writeError} {following ? <Typography.Link href={supplierWorkHref(following.id)} target="_blank" rel="noopener noreferrer">新页核对记录（本页输入保留）</Typography.Link> : null}</>} style={{ marginBottom: 12 }} /> : null}
        <Form form={followForm} layout="vertical" disabled={saving}>
          {following?.kind === "payment_term" ? <div style={{ marginBottom: 12 }}><TermEvidence row={following} /></div> : null}
          <Form.Item name="ownerId" label="责任人" rules={[{ required: true }]}><Select options={(data?.owners ?? []).map(owner => ({ value: owner.id, label: owner.name }))} /></Form.Item>
          <Form.Item name="dueDate" label="截止日" rules={[{ required: true }]}><DatePicker style={{ width: "100%" }} /></Form.Item>
          {following?.kind === "payment_term" && following.termChanged ? <Form.Item name="confirmCurrentTerm" label="我已核对以上主档条款，作为新的谈判基线" valuePropName="checked"><Switch /></Form.Item> : null}
          <Form.Item name="note" label="本次进展与下一步" rules={[{ required: true, min: 5 }]}><Input.TextArea rows={4} maxLength={1000} showCount style={{ marginBottom: 20 }} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
