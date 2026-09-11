"use client";

import { useLatestRead } from "@/components/useLatestRead";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import {
  AuditOutlined,
  CopyOutlined,
  LinkOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { fetchJson, patchJson, postJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import RemoteSelect, { type RemoteRow } from "@/components/RemoteSelect";
import SearchInput from "@/components/SearchInput";
import { useListState } from "@/components/useListState";
import { hasAnyRole, useMe } from "@/components/useMe";
import { useDocumentRead } from "@/components/useDocumentRead";
import { useDocumentTarget } from "@/components/useDocumentTarget";
import { qualityLegacyPath, qualityTab, qualityTabPath, type QualityTab } from "@/lib/quality-navigation";
import { DOCUMENT_TRANSIENT_PARAMS } from "@/lib/document-links";
import styles from "./quality-workspace.module.css";

type CaseKind = "complaint" | "adverse_event" | "recall" | "self_inspection";
type CaseStatus = "open" | "triaged" | "scoped" | "active" | "closed";
type Severity = "low" | "medium" | "high" | "critical";
type DueState = "not_due" | "due_soon" | "overdue" | "completed";
type LabelLifecycleState = "scheduled" | "current" | "historical" | "blocked";
type ActionKind =
  | "containment"
  | "corrective"
  | "preventive"
  | "effectiveness"
  | "notification"
  | "reconciliation"
  | "finding"
  | "follow_up";
type ActionStatus = "open" | "completed" | "verified" | "ineffective" | "waived";

interface QualityCase {
  id: number;
  caseNo: string;
  kind: CaseKind;
  status: CaseStatus;
  severity: Severity;
  marketCode: string;
  title: string;
  summary: string;
  sourceChannel: string;
  externalRef: string | null;
  skuId: number | null;
  skuCode: string | null;
  skuName: string | null;
  batchId: number | null;
  batchNo: string | null;
  supplierId: number | null;
  supplierName: string | null;
  ownerId: number;
  ownerName: string;
  receivedDate: string;
  occurredDate: string | null;
  assessment: "unassessed" | "non_serious" | "serious_not_reportable" | "serious_reportable";
  assessmentBasis: string | null;
  reportPolicy: string | null;
  reportDueDate: string | null;
  reportDueState: DueState | null;
  reportedAt: string | null;
  regulatorRef: string | null;
  retentionUntil: string | null;
  rootCause: string | null;
  scopeDigest: string | null;
  scopeSnapshot: Record<string, unknown> | null;
  scopeFrozenAt: string | null;
  inspectionYear: number | null;
  inspectionSite: string | null;
  inspectionReportRef: string | null;
  inspectionReportDate: string | null;
  version: number;
  createdAt: string;
  closedAt: string | null;
  closureNote: string | null;
}

interface CasesResponse {
  rows: QualityCase[];
  total: number;
  summary: {
    open: number;
    adverseDue: number;
    recalls: number;
    inspectionsThisYear: number;
  };
}

interface QualityAction {
  id: number;
  caseId: number;
  kind: ActionKind;
  title: string;
  description: string;
  ownerId: number;
  ownerName: string;
  dueDate: string;
  status: ActionStatus;
  targetType: string | null;
  targetRef: string | null;
  quantity: string | null;
  outcome: string | null;
  evidenceRef: string | null;
  verificationNote: string | null;
  createdAt: string;
  completedAt: string | null;
  verifiedAt: string | null;
}

interface RegulatoryRecord {
  id: number;
  recordKey: string;
  recordType: string;
  marketCode: string;
  skuId: number | null;
  skuCode: string | null;
  skuName: string | null;
  supplierId: number | null;
  supplierName: string | null;
  title: string;
  authority: string;
  referenceNo: string | null;
  status: string;
  effectiveDate: string | null;
  expiryDate: string | null;
  renewalDueDate: string | null;
  renewalState: DueState | null;
  retentionUntil: string | null;
  payload: Record<string, unknown> | null;
  payloadDigest: string;
  version: number;
  previousId: number | null;
  evidenceRef: string | null;
  createdAt: string;
  isLatest: boolean;
  isLatestRevision: boolean;
  isOperative: boolean;
}

interface ElectronicLabel {
  id: number;
  labelKey: string;
  skuId: number;
  skuCode: string;
  skuName: string;
  marketCode: string;
  locale: string;
  regulatoryRecordId: number;
  version: number;
  publicToken: string;
  contentDigest: string;
  effectiveDate: string;
  createdAt: string;
  lifecycleState: LabelLifecycleState;
  isCurrent: boolean;
  regulatoryRecordKey: string;
  regulatoryRecordVersion: number;
  regulatoryStatus: string;
  regulatoryEffectiveDate: string | null;
  regulatoryExpiryDate: string | null;
  regulatoryEligibleAtLabelEffective: boolean;
  regulatoryEligibleNow: boolean;
  publicPath: string;
}

interface CreateCaseForm {
  kind: CaseKind;
  severity: Severity;
  marketCode: string;
  title: string;
  summary: string;
  sourceChannel: string;
  externalRef?: string;
  skuId?: number;
  batchId?: number;
  supplierId?: number;
  warehouseId?: number;
  ownerId: number;
  receivedDate: Dayjs;
  occurredDate?: Dayjs;
  inspectionYear?: number;
  inspectionSite?: string;
}

interface CreateActionForm {
  kind: ActionKind;
  title: string;
  description: string;
  ownerId: number;
  dueDate: Dayjs;
  targetType?: string;
  targetRef?: string;
  quantity?: string;
}

interface CaseOperationForm {
  assessment?: "non_serious" | "serious_not_reportable" | "serious_reportable";
  basis?: string;
  policy?: string;
  reportDueDate?: Dayjs;
  retentionUntil?: Dayjs;
  regulatorRef?: string;
  limitationNote?: string;
  inspectionReportRef?: string;
  inspectionReportDate?: Dayjs;
  rootCause?: string;
  closureNote?: string;
}

interface ActionOperationForm {
  evidenceRef?: string;
  outcome?: string;
  result?: "verified" | "ineffective" | "waived";
  verificationNote?: string;
}

interface RegulatoryForm {
  recordKey: string;
  recordType: string;
  marketCode: string;
  skuId?: number;
  supplierId?: number;
  title: string;
  authority: string;
  referenceNo?: string;
  status: string;
  effectiveDate?: Dayjs;
  expiryDate?: Dayjs;
  renewalDueDate?: Dayjs;
  retentionUntil?: Dayjs;
  facts: string;
  evidenceRef?: string;
}

interface LabelForm {
  skuId: number;
  marketCode: string;
  locale: string;
  regulatoryRecordId: number;
  effectiveDate: Dayjs;
  productName: string;
  responsibleEntity: string;
  responsibleAddress: string;
  netContent: string;
  ingredients: string;
  usage?: string;
  precautions: string;
  batchStatement: string;
  durabilityStatement: string;
  origin?: string;
  registrationRef: string;
  otherMandatoryText?: string;
}

interface BatchBalanceOption {
  batchId: number | null;
  batchNo: string | null;
  batchExpiryDate: string | null;
  skuId: number;
  skuCode: string;
  skuName: string;
  warehouseName: string;
  qty: string;
}

const CASE_KIND_LABELS: Record<CaseKind, string> = {
  complaint: "投诉",
  adverse_event: "不良事件",
  recall: "召回",
  self_inspection: "GMP 自查",
};

const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  open: "待分诊",
  triaged: "已分诊",
  scoped: "范围已固化",
  active: "执行中",
  closed: "已关闭",
};

const SEVERITY_LABELS: Record<Severity, string> = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重",
};

const SEVERITY_COLORS: Record<Severity, string> = {
  low: "default",
  medium: "blue",
  high: "orange",
  critical: "red",
};

const ACTION_KIND_LABELS: Record<ActionKind, string> = {
  containment: "遏制",
  corrective: "纠正",
  preventive: "预防",
  effectiveness: "有效性",
  notification: "通知",
  reconciliation: "数量核对",
  finding: "自查发现",
  follow_up: "监管随访",
};

const ACTION_STATUS_LABELS: Record<ActionStatus, string> = {
  open: "待完成",
  completed: "待验证",
  verified: "已验证",
  ineffective: "无效",
  waived: "已豁免",
};

const ACTION_STATUS_COLORS: Record<ActionStatus, string> = {
  open: "processing",
  completed: "warning",
  verified: "success",
  ineffective: "error",
  waived: "default",
};

const RECORD_TYPE_LABELS: Record<string, string> = {
  nmpa_filing: "NMPA 备案",
  nmpa_registration: "NMPA 注册",
  fda_facility: "FDA 设施",
  fda_product_listing: "FDA 产品列名",
  eu_pif: "欧盟 PIF",
  eu_cpnp: "欧盟 CPNP",
  safety_assessment: "安全评估",
  other: "其他",
};

const RECORD_STATUS_LABELS: Record<string, string> = {
  submitted: "已提交",
  active: "有效",
  rejected: "驳回",
  expired: "过期",
  superseded: "已替代",
};

const RECORD_STATUS_COLORS: Record<string, string> = {
  submitted: "processing",
  active: "success",
  rejected: "error",
  expired: "warning",
  superseded: "default",
};

const LABEL_STATE: Record<LabelLifecycleState, { color: string; text: string }> = {
  scheduled: { color: "processing", text: "已排期" },
  current: { color: "success", text: "当前有效" },
  historical: { color: "default", text: "历史" },
  blocked: { color: "error", text: "监管支撑失效" },
};

const MODAL_BODY_STYLES = {
  body: { maxHeight: "calc(100dvh - 180px)", overflowY: "auto" as const },
};

const MODAL_TOP_STYLE = { top: 20 };

function dateTime(value: string | null): string {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "—";
}

function dueStateTag(state: DueState | null): React.ReactNode {
  if (!state) return null;
  const map: Record<DueState, { color: string; text: string }> = {
    completed: { color: "success", text: "已完成" },
    overdue: { color: "error", text: "已逾期" },
    due_soon: { color: "warning", text: "即将到期" },
    not_due: { color: "processing", text: "未到期" },
  };
  return <Tag color={map[state].color}>{map[state].text}</Tag>;
}

function labelRegulatorySupport(row: ElectronicLabel): { color: string; text: string } {
  if (row.lifecycleState === "scheduled") {
    return row.regulatoryEligibleAtLabelEffective
      ? { color: "processing", text: "生效日支撑有效" }
      : { color: "error", text: "生效日支撑无效" };
  }
  return row.regulatoryEligibleNow
    ? { color: "success", text: "当前支撑有效" }
    : { color: "error", text: "当前支撑不可用" };
}

function ErrorAlert({
  error,
  retry,
}: {
  error: string | null;
  retry: () => void;
}) {
  if (!error) return null;
  return (
    <Alert
      type="error"
      showIcon
      style={{ marginBottom: 10 }}
      message="数据加载失败"
      description={error}
      action={<Button size="small" onClick={retry}>重试</Button>}
    />
  );
}

function KpiCard({
  title,
  value,
  color,
}: {
  title: string;
  value: number | string;
  color?: string;
}) {
  return (
    <Col>
      <Card size="small">
        <Statistic title={title} value={value} valueStyle={color ? { color } : undefined} />
      </Card>
    </Col>
  );
}

function OwnerSelect({
  value,
  onChange,
}: {
  value?: number;
  onChange?: (value: number) => void;
}) {
  const me = useMe();
  return (
    <Select
      value={value}
      onChange={onChange}
      options={me ? [{ value: me.id, label: `${me.name}（当前登记人）` }] : []}
      placeholder="当前登记人"
      notFoundContent="当前用户信息加载中"
    />
  );
}

function BatchBalanceSelect({
  value,
  onChange,
  skuId,
}: {
  value?: number;
  onChange?: (value: number | undefined) => void;
  skuId?: number;
}) {
  const [options, setOptions] = useState<Array<{ value: number; label: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setOptions([]);
    setLoadError(null);
    setLoading(true);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ page: "1", pageSize: "200", nonzero: "0" });
      if (query.trim()) params.set("q", query.trim());
      void fetchJson<{ rows: BatchBalanceOption[] }>(`/api/inventory/balance?${params}`, {
        signal: controller.signal,
      })
        .then((response) => {
          if (cancelled) return;
          const unique = new Map<number, BatchBalanceOption>();
          for (const row of response.rows) {
            if (row.batchId == null || (skuId && row.skuId !== skuId)) continue;
            if (!unique.has(row.batchId)) unique.set(row.batchId, row);
          }
          setOptions([...unique.values()].map((row) => ({
            value: row.batchId!,
            label: `${row.batchNo ?? `批次 #${row.batchId}`} · ${row.skuCode} ${row.skuName} · ${row.warehouseName} · ${row.qty}${row.batchExpiryDate ? ` · 效期 ${row.batchExpiryDate}` : ""}`,
          })));
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setOptions([]);
            setLoadError(error instanceof Error ? error.message : "批次加载失败");
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, reloadVersion, skuId]);

  return (
    <Select
      showSearch
      allowClear
      filterOption={false}
      value={value}
      loading={loading}
      options={options}
      placeholder="按批号、SKU 编码或名称搜索"
      onSearch={setQuery}
      onChange={onChange}
      notFoundContent={loading
        ? "正在查找批次…"
        : loadError
          ? (
              <Space size={4}>
                <Typography.Text type="danger" role="alert">批次加载失败</Typography.Text>
                <Button type="link" size="small" onClick={() => setReloadVersion((current) => current + 1)}>
                  重试
                </Button>
              </Space>
            )
          : "未找到批次余额记录"}
    />
  );
}

function RegulatoryRecordSelect({
  value,
  onChange,
  marketCode,
  skuId,
  effectiveDate,
  onSelectRecord,
}: {
  value?: number;
  onChange?: (value: number | undefined) => void;
  marketCode?: string;
  skuId?: number;
  effectiveDate?: Dayjs;
  onSelectRecord?: (record: RegulatoryRecord | null) => void;
}) {
  const [records, setRecords] = useState<RegulatoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const normalizedMarket = marketCode?.trim().toUpperCase() ?? "";
  const targetDate = effectiveDate?.format("YYYY-MM-DD") ?? "";

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoadError(null);
    if (!normalizedMarket) {
      setRecords([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    void fetchJson<RegulatoryRecord[]>(
      `/api/quality/regulatory?marketCode=${encodeURIComponent(normalizedMarket)}`,
      { signal: controller.signal },
    )
      .then((next) => {
        if (!cancelled) setRecords(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRecords([]);
          setLoadError(error instanceof Error ? error.message : "监管证据加载失败");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [normalizedMarket, reloadVersion]);

  const eligibleRecords = useMemo(() => {
    if (!targetDate) return [];
    const latestByKey = new Map<string, RegulatoryRecord>();
    for (const row of records) {
      if (
        row.status !== "active"
        || (row.skuId != null && row.skuId !== skuId)
        || (row.effectiveDate != null && row.effectiveDate > targetDate)
        || (row.expiryDate != null && row.expiryDate < targetDate)
      ) {
        continue;
      }
      const current = latestByKey.get(row.recordKey);
      if (!current || row.version > current.version) latestByKey.set(row.recordKey, row);
    }
    return [...latestByKey.values()].sort((a, b) =>
      a.recordKey.localeCompare(b.recordKey) || b.version - a.version);
  }, [records, skuId, targetDate]);

  return (
    <Select
      showSearch
      allowClear
      optionFilterProp="label"
      value={value}
      onChange={(next) => {
        onChange?.(next);
        onSelectRecord?.(eligibleRecords.find((row) => row.id === next) ?? null);
      }}
      loading={loading}
      options={eligibleRecords.map((row) => ({
        value: row.id,
        label: [
          row.recordKey,
          `v${row.version}`,
          row.title,
          row.skuCode,
          row.referenceNo,
          `${row.effectiveDate ?? "即刻"} → ${row.expiryDate ?? "长期"}`,
        ].filter(Boolean).join(" · "),
      }))}
      placeholder={!normalizedMarket
        ? "请先选择市场"
        : !targetDate
          ? "请先选择标签生效日"
          : "选择生效日有效的最新监管证据"}
      notFoundContent={loading
        ? "正在加载监管证据…"
        : loadError
          ? (
              <Space size={4}>
                <Typography.Text type="danger" role="alert">监管证据加载失败</Typography.Text>
                <Button type="link" size="small" onClick={() => setReloadVersion((current) => current + 1)}>
                  重试
                </Button>
              </Space>
            )
          : normalizedMarket && targetDate
            ? "该市场、SKU 和生效日没有可用的监管证据"
            : "请先完成依赖字段"}
    />
  );
}

export default function QualityClient() {
  const search = useSearchParams();
  const query = search.toString();
  const tab = qualityTab(query);
  const target = useDocumentTarget();
  const me = useMe();
  const legacy = qualityLegacyPath("/quality", query);
  useEffect(() => {
    const { pathname, search, hash } = window.location;
    const path = qualityLegacyPath(pathname, search, hash);
    if (path) window.history.replaceState(null, "", path);
  }, [query]);
  const changeTab = (next: string) => {
    const { pathname, search, hash } = window.location;
    window.history.pushState(null, "", qualityTabPath(pathname, search, next as QualityTab, hash));
  };
  return (
    <div className="quality-page">
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 4 }}>
        质量与合规
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        投诉、不良事件、召回、CAPA、年度 GMP 自查、监管证据与电子标签的可审计工作台。
      </Typography.Paragraph>
      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        style={{ marginBottom: 12 }}
        message="系统保留事实、时限和版本；严重性、监管提交、召回范围与关闭决定仍由有权限的人承担。"
      />
      <Tabs
        activeKey={tab}
        onChange={changeTab}
        destroyOnHidden
        items={[
          { key: "cases", label: "案件与行动", children: tab === "cases" && !legacy ? <CasesTab key={`${me?.id}:${me?.roles.join(",")}:${target.id}:${target.error}`} target={target} /> : null },
          { key: "regulatory", label: "监管证据", children: <RegulatoryTab /> },
          { key: "labels", label: "电子标签", children: <ElectronicLabelsTab /> },
        ]}
      />
    </div>
  );
}

function CasesTab({ target }: { target: ReturnType<typeof useDocumentTarget> }) {
  const { message, modal } = App.useApp();
  const me = useMe();
  const currentUserId = me?.id;
  const canCreateCase = hasAnyRole(me, "quality", "ops", "warehouse", "purchasing");
  const canCreateAction = hasAnyRole(me, "quality", "purchasing", "warehouse", "pmc");
  const canQuality = hasAnyRole(me, "quality");
  const [createForm] = Form.useForm<CreateCaseForm>();
  const [actionForm] = Form.useForm<CreateActionForm>();
  const [caseOperationForm] = Form.useForm<CaseOperationForm>();
  const [actionOperationForm] = Form.useForm<ActionOperationForm>();
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [actionCase, setActionCase] = useState<QualityCase | null>(null);
  const [caseOperation, setCaseOperation] = useState<{
    row: QualityCase;
    operation: "assess" | "report" | "freeze_scope" | "document_inspection" | "close";
  } | null>(null);
  const [actionOperation, setActionOperation] = useState<{
    row: QualityAction;
    operation: "complete" | "verify";
  } | null>(null);
  const [quarantiningId, setQuarantiningId] = useState<number | null>(null);
  const [searchText, setSearchText] = useState("");
  const mounted = useRef(true);
  const recallDialog = useRef<ReturnType<typeof modal.confirm> | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; recallDialog.current?.destroy(); }; }, []);
  const createCaseKey = useRef("");
  const createActionKey = useRef("");
  const watchedCaseKind = Form.useWatch("kind", createForm) ?? "complaint";
  const watchedCaseSkuId = Form.useWatch("skuId", createForm);
  const watchedAssessment = Form.useWatch("assessment", caseOperationForm);
  const watchedActionKind = Form.useWatch("kind", actionForm);

  const listState = useListState({
    key: "quality-cases",
    defaults: { q: "", kind: "", status: "", sort: "", direction: "" },
    defaultPageSize: 20,
    paramPrefix: "qc",
    transientParams: DOCUMENT_TRANSIENT_PARAMS,
  });
  const { filters } = listState;
  const apiQuery = listState.queryString();
  const listRead = useDocumentRead<CasesResponse>(`/api/quality/cases?${apiQuery}`);
  const detailRead = useDocumentRead<QualityCase>(target.id ? `/api/quality/cases/${target.id}` : null);
  const actionsRead = useDocumentRead<QualityAction[]>(target.id ? `/api/quality/cases/${target.id}/actions` : null);
  const data = listRead.data;
  const loading = listRead.phase === "loading";
  const error = listRead.error;
  const load = () => { listRead.retry(); detailRead.retry(); actionsRead.retry(); };
  useEffect(() => {
    setSearchText(filters.q);
  }, [filters.q]);
  useEffect(() => {
    if (!createOpen) return;
    createForm.resetFields();
    createForm.setFieldsValue({
      kind: "complaint",
      severity: "medium",
      marketCode: "CN",
      sourceChannel: "internal",
      ownerId: currentUserId,
      receivedDate: dayjs(),
    });
  }, [createForm, createOpen, currentUserId]);
  useEffect(() => {
    if (!actionCase) return;
    actionForm.resetFields();
    actionForm.setFieldsValue({
      kind: actionCase.kind === "recall" ? "containment" : "corrective",
      ownerId: currentUserId,
      dueDate: dayjs().add(7, "day"),
    });
  }, [actionCase, actionForm, currentUserId]);
  useEffect(() => {
    if (!caseOperation) return;
    caseOperationForm.resetFields();
    if (caseOperation.operation === "assess") {
      caseOperationForm.setFieldsValue({ assessment: "non_serious" });
    }
    if (caseOperation.operation === "document_inspection") {
      caseOperationForm.setFieldsValue({ inspectionReportDate: dayjs() });
    }
  }, [caseOperation, caseOperationForm]);
  useEffect(() => {
    if (!actionOperation) return;
    actionOperationForm.resetFields();
    if (actionOperation.operation === "verify") {
      actionOperationForm.setFieldsValue({ result: "verified" });
    }
  }, [actionOperation, actionOperationForm]);

  const loadActions = (_caseId: number) => { actionsRead.retry(); };

  const openCreateCase = () => {
    createCaseKey.current = globalThis.crypto.randomUUID();
    setCreateOpen(true);
  };

  const submitCreateCase = async () => {
    try {
      const value = await createForm.validateFields();
      if (!mounted.current) return;
      setSaving(true);
      const created = await postJson<{ id: number }>("/api/quality/cases", {
        ...value,
        marketCode: value.marketCode.trim().toUpperCase(),
        receivedDate: value.receivedDate.format("YYYY-MM-DD"),
        occurredDate: value.occurredDate?.format("YYYY-MM-DD"),
        idempotencyKey: createCaseKey.current,
      });
      if (!mounted.current) return;
      message.success("质量案件已登记");
      setCreateOpen(false);
      target.setId(created.id);
    } catch (submitError) {
      if (mounted.current && submitError instanceof Error) message.error(submitError.message);
    } finally {
      setSaving(false);
    }
  };

  const openCreateAction = (row: QualityCase) => {
    createActionKey.current = globalThis.crypto.randomUUID();
    setActionCase(row);
  };

  const submitCreateAction = async () => {
    if (!actionCase) return;
    try {
      const value = await actionForm.validateFields();
      if (!mounted.current) return;
      setSaving(true);
      await postJson(`/api/quality/cases/${actionCase.id}/actions`, {
        ...value,
        dueDate: value.dueDate.format("YYYY-MM-DD"),
        idempotencyKey: createActionKey.current,
      });
      if (!mounted.current) return;
      message.success("质量行动已建立");
      setActionCase(null);
      await loadActions(actionCase.id);
    } catch (submitError) {
      if (mounted.current && submitError instanceof Error) message.error(submitError.message);
    } finally {
      setSaving(false);
    }
  };

  const openCaseOperation = (
    row: QualityCase,
    operation: "assess" | "report" | "freeze_scope" | "document_inspection" | "close",
  ) => {
    setCaseOperation({ row, operation });
  };

  const submitCaseOperation = async () => {
    if (!caseOperation) return;
    try {
      const value = await caseOperationForm.validateFields();
      if (!mounted.current) return;
      setSaving(true);
      const body: Record<string, unknown> = {
        operation: caseOperation.operation,
        expectedVersion: caseOperation.row.version,
      };
      if (caseOperation.operation === "assess") {
        Object.assign(body, {
          assessment: value.assessment,
          basis: value.basis,
          policy: value.policy,
          reportDueDate: value.reportDueDate?.format("YYYY-MM-DD"),
          retentionUntil: value.retentionUntil?.format("YYYY-MM-DD"),
        });
      } else if (caseOperation.operation === "report") {
        body.regulatorRef = value.regulatorRef;
      } else if (caseOperation.operation === "freeze_scope") {
        body.limitationNote = value.limitationNote;
      } else if (caseOperation.operation === "document_inspection") {
        body.inspectionReportRef = value.inspectionReportRef;
        body.reportDate = value.inspectionReportDate?.format("YYYY-MM-DD");
        body.rootCause = value.rootCause;
      } else {
        body.rootCause = value.rootCause;
        body.closureNote = value.closureNote;
      }
      await patchJson(`/api/quality/cases/${caseOperation.row.id}`, body);
      if (!mounted.current) return;
      message.success("案件状态已更新");
      setCaseOperation(null);
      await load();
    } catch (submitError) {
      if (mounted.current && submitError instanceof Error) message.error(submitError.message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * W2 审计 4a：冻结案件范围内的批次。
   * 服务端会先登记围堵行动，再请求库存侧执行隔离；执行不了时返回明确原因（不静默跳过），
   * 这里如实转达——「以为隔离了其实没隔」比「知道没隔」危险得多。
   */
  const quarantineCase = async (row: QualityCase) => {
    setQuarantiningId(row.id);
    try {
      const res = await postJson<{ executed: number; pending: number; emptyScope: boolean; lines: { reason: string | null }[] }>(
        `/api/quality/cases/${row.id}/quarantine`,
        {},
      );
      if (!mounted.current) return;
      if (res.emptyScope) message.warning("范围内已无正库存可隔离（围堵行动未产生）");
      else if (res.pending > 0) {
        message.warning(`已登记围堵行动 ${res.executed + res.pending} 项，其中 ${res.pending} 项库存侧未执行：${res.lines.find((l) => l.reason)?.reason ?? ""}`);
      } else message.success(`已隔离 ${res.executed} 项批次库存`);
      await load();
    } catch (e) {
      if (mounted.current) message.error(e instanceof Error ? e.message : "冻结失败");
    } finally {
      setQuarantiningId(null);
    }
  };

  const activateRecall = (row: QualityCase) => {
    recallDialog.current = modal.confirm({
      title: `启动召回 · ${row.caseNo}`,
      content: "启动前系统会核验遏制、通知、有效性和数量核对四类行动均已建立。",
      okText: "确认启动",
      cancelText: "取消",
      onOk: async () => {
        if (!mounted.current) return;
        try {
          await patchJson(`/api/quality/cases/${row.id}`, {
            operation: "activate",
            expectedVersion: row.version,
          });
          if (!mounted.current) return;
          message.success("召回已启动");
          await load();
        } catch (operationError) {
          if (mounted.current) message.error(operationError instanceof Error ? operationError.message : "召回启动失败");
        }
      },
    });
  };

  const openActionOperation = (row: QualityAction, operation: "complete" | "verify") => {
    setActionOperation({ row, operation });
  };

  const submitActionOperation = async () => {
    if (!actionOperation) return;
    try {
      const value = await actionOperationForm.validateFields();
      if (!mounted.current) return;
      setSaving(true);
      const body = actionOperation.operation === "complete"
        ? {
            operation: "complete",
            evidenceRef: value.evidenceRef,
            outcome: value.outcome,
          }
        : {
            operation: "verify",
            result: value.result,
            verificationNote: value.verificationNote,
          };
      await patchJson(`/api/quality/actions/${actionOperation.row.id}`, body);
      if (!mounted.current) return;
      message.success(actionOperation.operation === "complete" ? "行动已提交验证" : "验证结论已登记");
      const caseId = actionOperation.row.caseId;
      setActionOperation(null);
      await loadActions(caseId);
    } catch (submitError) {
      if (mounted.current && submitError instanceof Error) message.error(submitError.message);
    } finally {
      setSaving(false);
    }
  };

  const actionControl = (row: QualityAction) => {
    if (row.status === "open" && (canQuality || row.ownerId === me?.id)) {
      return <Button type="link" size="small" onClick={() => openActionOperation(row, "complete")}>完成</Button>;
    }
    if (row.status === "completed" && canQuality) {
      return <Button type="link" size="small" onClick={() => openActionOperation(row, "verify")}>验证</Button>;
    }
    return <Typography.Text type="secondary">—</Typography.Text>;
  };
  const actionColumns: ColumnsType<QualityAction> = [
      {
        title: "行动",
        dataIndex: "title",
        width: 250,
        render: (title: string, row) => (
          <Space direction="vertical" size={0}>
            <Space size={4} wrap>
              <Tag>{ACTION_KIND_LABELS[row.kind]}</Tag>
              <Typography.Text strong>{title}</Typography.Text>
            </Space>
            <Typography.Text type="secondary" ellipsis={{ tooltip: row.description }} style={{ maxWidth: 300 }}>
              {row.description}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: "责任与时限",
        key: "owner",
        width: 170,
        sorter: (a, b) => a.dueDate.localeCompare(b.dueDate),
        render: (_value, row) => (
          <Space direction="vertical" size={0}>
            <Typography.Text>{row.ownerName}</Typography.Text>
            <Typography.Text type={dayjs(row.dueDate).isBefore(dayjs(), "day") && row.status === "open" ? "danger" : "secondary"}>
              {row.dueDate}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: "目标/数量",
        key: "target",
        width: 160,
        render: (_value, row) => (
          <Typography.Text type="secondary">
            {[row.targetType, row.targetRef, row.quantity].filter(Boolean).join(" · ") || "—"}
          </Typography.Text>
        ),
      },
      {
        title: "状态",
        dataIndex: "status",
        width: 105,
        filters: Object.entries(ACTION_STATUS_LABELS).map(([value, text]) => ({ value, text })),
        onFilter: (value, row) => row.status === value,
        render: (status: ActionStatus) => (
          <Tag color={ACTION_STATUS_COLORS[status]}>{ACTION_STATUS_LABELS[status]}</Tag>
        ),
      },
      {
        title: "完成证据",
        key: "evidence",
        width: 260,
        ellipsis: true,
        render: (_value, row) => row.evidenceRef ? (
          <Typography.Text ellipsis={{ tooltip: `${row.evidenceRef} · ${row.outcome ?? ""}` }}>
            {row.evidenceRef} · {row.outcome}
          </Typography.Text>
        ) : "—",
      },
      {
        title: "操作",
        key: "operation",
        fixed: "right",
        width: 105,
        render: (_value, row) => actionControl(row),
      },
    ];

  const columns: ColumnsType<QualityCase> = [
      {
        title: "案件",
        dataIndex: "caseNo",
        key: "caseNo",
        fixed: "left",
        width: 260,
        sorter: true,
        sortOrder: filters.sort === "caseNo" ? filters.direction === "desc" ? "descend" : "ascend" : null,
        render: (caseNo: string, row) => (
          <Space direction="vertical" size={0}>
            <Space size={5} wrap>
              <Button type="link" size="small" onClick={() => target.setId(row.id)}>{caseNo}</Button>
              <Tag color={SEVERITY_COLORS[row.severity]}>{SEVERITY_LABELS[row.severity]}</Tag>
            </Space>
            <Typography.Text strong ellipsis={{ tooltip: row.title }} style={{ maxWidth: 230 }}>
              {row.title}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: "类型/市场",
        key: "kind",
        width: 135,
        render: (_value, row) => (
          <Space direction="vertical" size={0}>
            <Tag color={row.kind === "recall" ? "red" : row.kind === "adverse_event" ? "orange" : "blue"}>
              {CASE_KIND_LABELS[row.kind]}
            </Tag>
            <Typography.Text type="secondary">{row.marketCode}</Typography.Text>
          </Space>
        ),
      },
      {
        title: "关联对象",
        key: "subject",
        width: 210,
        render: (_value, row) => (
          <Space direction="vertical" size={0}>
            <Typography.Text>{row.skuCode ? `${row.skuCode} · ${row.skuName ?? ""}` : "未绑定 SKU"}</Typography.Text>
            <Typography.Text type="secondary">
              {[row.batchNo && `批次 ${row.batchNo}`, row.supplierName].filter(Boolean).join(" · ") || "—"}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: "报告/范围",
        key: "report",
        width: 200,
        sorter: true,
        sortOrder: filters.sort === "reportDueDate" ? filters.direction === "desc" ? "descend" : "ascend" : null,
        render: (_value, row) => (
          <Space direction="vertical" size={0}>
            {row.reportDueDate ? (
              <Space size={4} wrap>
                <Typography.Text>{row.reportDueDate}</Typography.Text>
                {dueStateTag(row.reportDueState)}
              </Space>
            ) : row.scopeDigest ? (
              <Typography.Text code copyable={{ text: row.scopeDigest }}>
                范围 {row.scopeDigest.slice(0, 10)}…
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary">
                {row.assessment === "unassessed" ? "待人工评估" : "无需监管报告"}
              </Typography.Text>
            )}
            <Typography.Text type="secondary">
              {row.reportedAt ? `已提交 ${dateTime(row.reportedAt)}` : row.retentionUntil ? `保留至 ${row.retentionUntil}` : "—"}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: "责任/状态",
        key: "owner",
        width: 165,
        sorter: true,
        sortOrder: filters.sort === "ownerName" ? filters.direction === "desc" ? "descend" : "ascend" : null,
        render: (_value, row) => (
          <Space direction="vertical" size={0}>
            <Typography.Text>{row.ownerName}</Typography.Text>
            <Tag color={row.status === "closed" ? "default" : row.status === "active" ? "processing" : "blue"}>
              {CASE_STATUS_LABELS[row.status]}
            </Tag>
          </Space>
        ),
      },
      {
        title: "接收日",
        dataIndex: "receivedDate",
        key: "receivedDate",
        width: 115,
        sorter: true,
        sortOrder: filters.sort === "receivedDate" ? filters.direction === "desc" ? "descend" : "ascend" : null,
      },
      {
        title: "操作",
        key: "actions",
        fixed: "right",
        width: 120,
        render: (_value, row) => <Button type="link" size="small" onClick={() => target.setId(row.id)}>查看与处理</Button>,
      },
    ];

  const renderCaseActions = (row: QualityCase) => (<Space size={0} wrap>
            {canCreateAction && row.status !== "closed" ? (
              <Button type="link" size="small" onClick={() => openCreateAction(row)}>建行动</Button>
            ) : null}
            {canQuality && row.status !== "closed" && ["complaint", "adverse_event"].includes(row.kind) && row.assessment === "unassessed" ? (
              <Button type="link" size="small" onClick={() => openCaseOperation(row, "assess")}>评估</Button>
            ) : null}
            {canQuality && row.assessment === "serious_reportable" && !row.reportedAt ? (
              <Button type="link" size="small" onClick={() => openCaseOperation(row, "report")}>登记报告</Button>
            ) : null}
            {canQuality && row.kind === "recall" && row.status === "open" ? (
              <Button type="link" size="small" danger onClick={() => openCaseOperation(row, "freeze_scope")}>固化范围</Button>
            ) : null}
            {canQuality && row.kind === "recall" && row.status === "scoped" ? (
              <Button type="link" size="small" danger onClick={() => activateRecall(row)}>启动</Button>
            ) : null}
            {canQuality && row.kind === "self_inspection" && !row.inspectionReportRef ? (
              <Button type="link" size="small" onClick={() => openCaseOperation(row, "document_inspection")}>登记报告</Button>
            ) : null}
            {/* W2 审计 4a：案件必须能冻结自己范围内的批次——此前 quality_cases 对库存零约束力 */}
            {canQuality && row.status !== "closed" && row.batchId != null ? (
              <Popconfirm
                title="冻结该案件范围内的批次？"
                description="会按案件范围登记围堵行动，并请求库存侧执行隔离；执行不了会明确告诉你原因（不会假装隔离过了）。"
                okText="冻结"
                cancelText="取消"
                onConfirm={() => void quarantineCase(row)}
              >
                <Button type="link" size="small" danger loading={quarantiningId === row.id}>冻结批次</Button>
              </Popconfirm>
            ) : null}
            {canQuality && row.status !== "closed" ? (
              <Button type="link" size="small" onClick={() => openCaseOperation(row, "close")}>关闭</Button>
            ) : null}
          </Space>);
  const renderCaseDetails = (row: QualityCase) => (<div style={{ padding: "2px 0 8px" }}>
              <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} style={{ marginBottom: 8 }}>
                <Descriptions.Item label="事实摘要">{row.summary}</Descriptions.Item>
                <Descriptions.Item label="来源">{row.sourceChannel}{row.externalRef ? ` · ${row.externalRef}` : ""}</Descriptions.Item>
                <Descriptions.Item label="评估">{row.assessmentBasis ?? "尚未评估"}</Descriptions.Item>
                {row.inspectionSite ? <Descriptions.Item label="自查场所">{row.inspectionSite}</Descriptions.Item> : null}
                {row.inspectionReportDate ? <Descriptions.Item label="自查报告日">{row.inspectionReportDate}</Descriptions.Item> : null}
                {row.rootCause ? <Descriptions.Item label="根因">{row.rootCause}</Descriptions.Item> : null}
                {row.closureNote ? <Descriptions.Item label="关闭结论">{row.closureNote}</Descriptions.Item> : null}
              </Descriptions>
              <ErrorAlert error={actionsRead.error} retry={() => void loadActions(row.id)} />
              <div className={styles.actionCards}>
                {actionsRead.data?.map(action => <article className={styles.actionCard} key={action.id} aria-label={`质量行动：${action.title}`}>
                  <div className={styles.actionTitle}>{action.title}</div>
                  <div className={styles.actionMeta}>
                    <Tag>{ACTION_KIND_LABELS[action.kind]}</Tag>
                    <Tag color={ACTION_STATUS_COLORS[action.status]}>{ACTION_STATUS_LABELS[action.status]}</Tag>
                    <span>责任人：{action.ownerName}</span>
                    <span>截止：{action.dueDate}</span>
                  </div>
                  <p>{action.description}</p>
                  {[action.targetType, action.targetRef, action.quantity].some(Boolean) ? <p>目标 / 数量：{[action.targetType, action.targetRef, action.quantity].filter(Boolean).join(" · ")}</p> : null}
                  {action.evidenceRef ? <p>完成证据：{action.evidenceRef} · {action.outcome}</p> : null}
                  {action.verificationNote ? <p>核验：{action.verificationNote}</p> : null}
                  {actionControl(action)}
                </article>)}
              </div>
              <Table<QualityAction>
                className={`${styles.actionTable} ${actionsRead.data?.length ? styles.actionTablePopulated : ""}`}
                rowKey="id"
                size="small"
                loading={actionsRead.phase === "loading"}
                columns={actionColumns}
                dataSource={actionsRead.data ?? []}
                pagination={false}
                scroll={{ x: 1050 }}
                locale={{ emptyText: <Empty style={{ margin: "12px 0" }} styles={{ image: { height: 28 } }} image={Empty.PRESENTED_IMAGE_SIMPLE} description={actionsRead.error ? "行动读取失败，请重试" : actionsRead.phase === "loading" ? "正在读取行动" : "该案件尚未建立质量行动"} /> }}
              />
            </div>);

  const caseOperationTitle = caseOperation ? {
    assess: "人工严重性评估",
    report: "登记监管报告",
    freeze_scope: "固化召回范围",
    document_inspection: "登记 GMP 自查报告",
    close: "关闭质量案件",
  }[caseOperation.operation] : "";

  return (
    <>
      <Row className="compact-kpi-row">
        <KpiCard title="未关闭案件" value={data ? data.summary.open : "—"} />
        <KpiCard title="待报告严重事件" value={data ? data.summary.adverseDue : "—"} color={data?.summary.adverseDue ? "#cf1322" : undefined} />
        <KpiCard title="进行中召回" value={data ? data.summary.recalls : "—"} color={data?.summary.recalls ? "#d46b08" : undefined} />
        <KpiCard title="本年 GMP 自查" value={data ? data.summary.inspectionsThisYear : "—"} />
      </Row>
      {data?.summary.adverseDue ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 10 }}
          message={`${data.summary.adverseDue} 个可报告严重事件尚未登记监管提交证据`}
        />
      ) : null}
      <ErrorAlert error={error} retry={() => void load()} />
      <ListToolbar
        state={listState}
        extra={(
          <>
            <SearchInput
              allowClear
              value={searchText}
              placeholder="搜索案件号、标题或 SKU"
              style={{ width: 260 }}
              onChange={(event) => {
                setSearchText(event.target.value);
                if (!event.target.value) listState.setFilter({ q: "" });
              }}
              onSearch={(value) => listState.setFilter({ q: value.trim() })}
            />
            <Select
              value={filters.kind}
              style={{ width: 130 }}
              options={[
                { value: "", label: "全部类型" },
                ...Object.entries(CASE_KIND_LABELS).map(([value, label]) => ({ value, label })),
              ]}
              onChange={(kind) => listState.setFilter({ kind })}
            />
            <Select
              value={filters.status}
              style={{ width: 130 }}
              options={[
                { value: "", label: "全部状态" },
                ...Object.entries(CASE_STATUS_LABELS).map(([value, label]) => ({ value, label })),
              ]}
              onChange={(status) => listState.setFilter({ status })}
            />
          </>
        )}
        primaryActions={(
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
            {canCreateCase ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreateCase}>登记案件</Button>
            ) : null}
          </>
        )}
      />
      <Table<QualityCase>
        rowKey="id"
        loading={loading}
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        onChange={(_page, _filters, sort, extra) => {
          if (extra.action !== "sort" || Array.isArray(sort)) return;
          const fields: Record<string, string> = { caseNo: "caseNo", report: "reportDueDate", owner: "ownerName", receivedDate: "receivedDate" };
          listState.setFilter({ sort: sort.order ? fields[String(sort.columnKey)] ?? "" : "", direction: sort.order === "descend" ? "desc" : sort.order ? "asc" : "" });
        }}
        pagination={listState.paginationProps({ total: data?.total, showTotal: (total) => `共 ${total} 个案件` })}
        scroll={{ x: 1320 }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={error ? "案件读取失败，请重试" : loading ? "正在读取案件" : filters.q || filters.kind || filters.status ? "当前筛选没有匹配案件" : "暂无质量案件；发生投诉、事件、自查或召回时从这里登记"}
            />
          ),
        }}

      />


      <Drawer title={detailRead.data ? `案件详情 · ${detailRead.data.caseNo}` : "案件详情"}
        open={target.present} onClose={() => target.setId(null)} width={1040} destroyOnHidden
        styles={{ wrapper: { maxWidth: "100vw" }, body: { padding: 16, minWidth: 0 } }}>
        {target.error ? <Alert type="error" showIcon message={target.error} /> : null}
        <ErrorAlert error={detailRead.error} retry={detailRead.retry} />
        {detailRead.phase === "loading" ? <Typography.Paragraph role="status">正在读取案件，请稍候…</Typography.Paragraph> : null}
        {detailRead.data ? <>
          <Typography.Title level={5} style={{ marginTop: 0, overflowWrap: "anywhere" }}>{detailRead.data.title}</Typography.Title>
          <Space wrap style={{ marginBottom: 12 }}>
            <Tag>{CASE_KIND_LABELS[detailRead.data.kind]}</Tag><Tag>{CASE_STATUS_LABELS[detailRead.data.status]}</Tag>
            <Tag color={SEVERITY_COLORS[detailRead.data.severity]}>{SEVERITY_LABELS[detailRead.data.severity]}</Tag>
            <span>负责人：{detailRead.data.ownerName}</span><span>接收：{detailRead.data.receivedDate}</span>
          </Space>
          <Typography.Paragraph>{[detailRead.data.skuCode, detailRead.data.skuName, detailRead.data.batchNo, detailRead.data.supplierName].filter(Boolean).join(" · ") || "未绑定 SKU / 批次 / 供应商"}</Typography.Paragraph>
          {detailRead.data.reportDueDate ? <Alert style={{ marginBottom: 12 }} type={detailRead.data.reportDueState === "overdue" ? "warning" : "info"} showIcon
            message={<>报告截止：{detailRead.data.reportDueDate} {dueStateTag(detailRead.data.reportDueState)}{detailRead.data.reportedAt ? ` · 已提交 ${dateTime(detailRead.data.reportedAt)}` : " · 尚未登记提交证据"}</>} /> : null}
          <div style={{ marginBottom: 12 }}>{renderCaseActions(detailRead.data)}</div>
          {renderCaseDetails(detailRead.data)}
        </> : null}
      </Drawer>
      <Modal
        title="登记质量案件"
        open={createOpen}
        onOk={() => void submitCreateCase()}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={saving}
        okText="登记"
        cancelText="取消"
        maskClosable={false}
        destroyOnHidden
        width={680}
        style={MODAL_TOP_STYLE}
        styles={MODAL_BODY_STYLES}
      >
        <Form
          form={createForm}
          layout="vertical"
          onValuesChange={(changed) => {
            if ("skuId" in changed) createForm.setFieldValue("batchId", undefined);
          }}
        >
          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="kind" label="案件类型" rules={[{ required: true }]}>
                <Select options={Object.entries(CASE_KIND_LABELS).map(([value, label]) => ({ value, label }))} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="severity" label="严重度" rules={[{ required: true }]}>
                <Select options={Object.entries(SEVERITY_LABELS).map(([value, label]) => ({ value, label }))} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="marketCode" label="目的市场" rules={[{ required: true }, { pattern: /^[A-Za-z]{2,8}$/, message: "请输入 2–8 位市场编码" }]}>
                <Input placeholder="CN / US / EU" maxLength={8} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="sourceChannel" label="来源渠道" rules={[{ required: true }]}>
                <Select
                  options={[
                    ["consumer", "消费者"],
                    ["marketplace", "电商平台"],
                    ["retailer", "零售商"],
                    ["internal", "内部"],
                    ["supplier", "供应商"],
                    ["regulator", "监管机构"],
                    ["other", "其他"],
                  ].map(([value, label]) => ({ value, label }))}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="title" label="标题" rules={[{ required: true, min: 3 }]}>
            <Input
              maxLength={160}
              placeholder="概括质量判断；不要写消费者姓名、联系方式或其他敏感信息"
            />
          </Form.Item>
          <Form.Item name="summary" label="事实摘要" rules={[{ required: true, min: 5 }]}>
            <Input.TextArea
              rows={3}
              maxLength={4000}
              showCount
              placeholder="只记录去标识化事实、来源和未知项；消费者详情留在受控证据系统"
            />
          </Form.Item>
          <Form.Item name="externalRef" label="外部证据引用">
            <Input maxLength={300} placeholder="仅填工单号、受控文件或监管来函编号，不粘贴证据正文" />
          </Form.Item>
          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="skuId" label="关联 SKU">
                <RemoteSelect
                  api="/api/master/sku"
                  getLabel={(row: RemoteRow) => `${String(row.code)} · ${String(row.name)}`}
                  filterRow={(row: RemoteRow) => row.active !== false}
                  placeholder="搜索 SKU 编码或名称"
                  allowClear
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                name="batchId"
                label="关联批次"
                extra="按批号或 SKU 搜索当前系统批次余额；选择后仍请核对案件详情回显。"
                rules={watchedCaseKind === "recall" ? [{ required: true, message: "召回必须绑定批次" }] : undefined}
              >
                <BatchBalanceSelect skuId={watchedCaseSkuId} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="supplierId" label="关联供应商">
                <RemoteSelect
                  api="/api/master/supplier"
                  getLabel={(row: RemoteRow) => `${String(row.code)} · ${String(row.name)}`}
                  placeholder="搜索供应商"
                  allowClear
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="warehouseId" label="关联仓库">
                <RemoteSelect
                  api="/api/master/warehouse"
                  getLabel={(row: RemoteRow) => `${String(row.code)} · ${String(row.name)}`}
                  filterRow={(row: RemoteRow) => row.active !== false}
                  placeholder="搜索仓库"
                  allowClear
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col xs={24} sm={8}>
              <Form.Item name="ownerId" label="责任人" rules={[{ required: true }]}>
                <OwnerSelect />
              </Form.Item>
            </Col>
            <Col xs={12} sm={8}>
              <Form.Item name="receivedDate" label="接收日" rules={[{ required: true }]}>
                <DatePicker style={{ width: "100%" }} disabledDate={(date) => date.isAfter(dayjs(), "day")} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={8}>
              <Form.Item name="occurredDate" label="发生日">
                <DatePicker style={{ width: "100%" }} disabledDate={(date) => date.isAfter(dayjs(), "day")} />
              </Form.Item>
            </Col>
          </Row>
          {watchedCaseKind === "self_inspection" ? (
            <Row gutter={12}>
              <Col xs={24} sm={8}>
                <Form.Item name="inspectionYear" label="自查年度" rules={[{ required: true }]}>
                  <InputNumber min={2020} max={2200} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={16}>
                <Form.Item name="inspectionSite" label="生产场所" rules={[{ required: true, min: 2 }]}>
                  <Input maxLength={160} />
                </Form.Item>
              </Col>
            </Row>
          ) : null}
        </Form>
      </Modal>

      <Modal
        title={actionCase ? `建立行动 · ${actionCase.caseNo}` : "建立质量行动"}
        open={actionCase != null}
        onOk={() => void submitCreateAction()}
        onCancel={() => setActionCase(null)}
        confirmLoading={saving}
        okText="建立"
        cancelText="取消"
        maskClosable={false}
        destroyOnHidden
        width={600}
        style={MODAL_TOP_STYLE}
        styles={MODAL_BODY_STYLES}
      >
        <Form form={actionForm} layout="vertical">
          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="kind" label="行动类型" rules={[{ required: true }]}>
                <Select
                  options={Object.entries(ACTION_KIND_LABELS)
                    .filter(([value]) => value !== "follow_up")
                    .map(([value, label]) => ({ value, label }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="ownerId" label="责任人" rules={[{ required: true }]}>
                <OwnerSelect />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="title" label="行动标题" rules={[{ required: true, min: 3 }]}>
            <Input maxLength={160} placeholder="概括行动；不要写消费者或受控证据中的敏感信息" />
          </Form.Item>
          <Form.Item name="description" label="完成标准" rules={[{ required: true, min: 5 }]}>
            <Input.TextArea
              rows={3}
              maxLength={3000}
              showCount
              placeholder="写明动作、受控证据编号和可验证结果；不要粘贴证据正文"
            />
          </Form.Item>
          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="dueDate" label="截止日" rules={[{ required: true }]}>
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="quantity" label="核对数量" rules={watchedActionKind === "reconciliation" ? [{ required: true }] : undefined}>
                <Input placeholder="最多 4 位小数" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="targetType" label="通知目标类型" rules={watchedActionKind === "notification" ? [{ required: true }] : undefined}>
                <Input placeholder="渠道 / 仓库 / 经销商" maxLength={80} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="targetRef" label="目标引用" rules={watchedActionKind === "notification" ? [{ required: true }] : undefined}>
                <Input placeholder="仅填受控名单或通知批次编号" maxLength={300} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        title={caseOperationTitle}
        open={caseOperation != null}
        onOk={() => void submitCaseOperation()}
        onCancel={() => setCaseOperation(null)}
        confirmLoading={saving}
        okText="确认"
        cancelText="取消"
        maskClosable={false}
        destroyOnHidden
        width={580}
        style={MODAL_TOP_STYLE}
        styles={MODAL_BODY_STYLES}
      >
        <Form form={caseOperationForm} layout="vertical">
          {caseOperation?.operation === "assess" ? (
            <>
              <Form.Item name="assessment" label="人工结论" rules={[{ required: true }]}>
                <Select
                  options={[
                    { value: "non_serious", label: "非严重" },
                    { value: "serious_not_reportable", label: "严重但按当前政策不可报告" },
                    { value: "serious_reportable", label: "严重且可报告" },
                  ]}
                />
              </Form.Item>
              <Form.Item name="basis" label="判断依据" rules={[{ required: true, min: 5 }]}>
                <Input.TextArea rows={4} maxLength={2000} showCount />
              </Form.Item>
              {watchedAssessment === "serious_reportable" && caseOperation.row.marketCode !== "US" ? (
                <>
                  <Form.Item name="policy" label="适用政策/版本" rules={[{ required: true }]}>
                    <Input maxLength={120} />
                  </Form.Item>
                  <Row gutter={12}>
                    <Col xs={24} sm={12}><Form.Item name="reportDueDate" label="报告截止日" rules={[{ required: true }]}><DatePicker style={{ width: "100%" }} /></Form.Item></Col>
                    <Col xs={24} sm={12}><Form.Item name="retentionUntil" label="保留至" rules={[{ required: true }]}><DatePicker style={{ width: "100%" }} /></Form.Item></Col>
                  </Row>
                </>
              ) : null}
            </>
          ) : null}
          {caseOperation?.operation === "report" ? (
            <Form.Item name="regulatorRef" label="监管提交证据引用" rules={[{ required: true, min: 3 }]}>
              <Input maxLength={300} placeholder="提交回执号或受控文件引用" />
            </Form.Item>
          ) : null}
          {caseOperation?.operation === "freeze_scope" ? (
            <>
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="范围快照和摘要一经固化不可覆盖；未知客户去向、外部仓批次覆盖和历史无批次余额会明确保留。"
              />
              <Form.Item name="limitationNote" label="额外限制说明">
                <Input.TextArea rows={3} maxLength={1000} />
              </Form.Item>
            </>
          ) : null}
          {caseOperation?.operation === "document_inspection" ? (
            <>
              <Form.Item name="inspectionReportDate" label="自查报告日" rules={[{ required: true }]}>
                <DatePicker style={{ width: "100%" }} disabledDate={(date) => date.isAfter(dayjs(), "day")} />
              </Form.Item>
              <Form.Item name="inspectionReportRef" label="自查报告引用" rules={[{ required: true, min: 3 }]}>
                <Input maxLength={300} />
              </Form.Item>
              <Form.Item name="rootCause" label="主要问题/根因">
                <Input.TextArea rows={3} maxLength={3000} />
              </Form.Item>
            </>
          ) : null}
          {caseOperation?.operation === "close" ? (
            <>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="关闭前系统会核验监管报告、CAPA、召回或自查行动均已验证；不满足时拒绝关闭。"
              />
              <Form.Item name="rootCause" label="根因（高/严重案件必填）">
                <Input.TextArea
                  rows={3}
                  maxLength={3000}
                  placeholder="记录去标识化根因；不要写消费者或医疗敏感信息"
                />
              </Form.Item>
              <Form.Item name="closureNote" label="关闭结论" rules={[{ required: true, min: 5 }]}>
                <Input.TextArea
                  rows={4}
                  maxLength={3000}
                  showCount
                  placeholder="记录去标识化结论和受控证据编号"
                />
              </Form.Item>
            </>
          ) : null}
        </Form>
      </Modal>

      <Modal
        title={actionOperation?.operation === "complete" ? "提交行动完成证据" : "独立验证行动"}
        open={actionOperation != null}
        onOk={() => void submitActionOperation()}
        onCancel={() => setActionOperation(null)}
        confirmLoading={saving}
        okText="确认"
        cancelText="取消"
        maskClosable={false}
        destroyOnHidden
        width={560}
        style={MODAL_TOP_STYLE}
        styles={MODAL_BODY_STYLES}
      >
        <Form form={actionOperationForm} layout="vertical">
          {actionOperation?.operation === "complete" ? (
            <>
              <Form.Item name="evidenceRef" label="证据引用" rules={[{ required: true, min: 3 }]}>
                <Input maxLength={500} placeholder="仅填受控证据编号或受限存储路径，不粘贴敏感正文" />
              </Form.Item>
              <Form.Item name="outcome" label="执行结果" rules={[{ required: true, min: 3 }]}>
                <Input.TextArea
                  rows={4}
                  maxLength={1000}
                  placeholder="记录去标识化结果；消费者或医疗详情留在受控证据系统"
                />
              </Form.Item>
            </>
          ) : (
            <>
              <Alert type="info" showIcon style={{ marginBottom: 12 }} message="行动完成人不能验证自己的行动；豁免仅限管理员并必须留理由。" />
              <Form.Item name="result" label="验证结论" rules={[{ required: true }]}>
                <Select
                  options={[
                    { value: "verified", label: "有效" },
                    { value: "ineffective", label: "无效，需重新处置" },
                    { value: "waived", label: "带理由豁免（管理员）" },
                  ]}
                />
              </Form.Item>
              <Form.Item name="verificationNote" label="验证依据" rules={[{ required: true, min: 5 }]}>
                <Input.TextArea
                  rows={4}
                  maxLength={2000}
                  showCount
                  placeholder="记录去标识化验证结论和受控证据编号"
                />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </>
  );
}

function RegulatoryTab() {
  const { message } = App.useApp();
  const me = useMe();
  const canWrite = hasAnyRole(me, "quality");
  const [form] = Form.useForm<RegulatoryForm>();
  const [rows, setRows] = useState<RegulatoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const loadSequence = useRef(0);
  const publishKey = useRef("");
  const listState = useListState({
    key: "quality-regulatory",
    defaults: { q: "", marketCode: "", recordType: "" },
    paginated: false,
    paramPrefix: "reg",
  });
  const { filters } = listState;
  const apiQuery = listState.queryString();

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchJson<RegulatoryRecord[]>(`/api/quality/regulatory?${apiQuery}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      if (sequence === loadSequence.current) setRows(next);
    } catch (loadError) {
      if (!readRequest.isCurrent()) return;
      if (sequence === loadSequence.current) setError((loadError as Error).message);
    } finally {
      if (readRequest.isCurrent()) { if (sequence === loadSequence.current) setLoading(false); }
    }
  }, [beginLoadRead, apiQuery]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setSearchText(filters.q);
  }, [filters.q]);
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({ marketCode: "CN", status: "active", recordType: "nmpa_filing" });
  }, [form, open]);

  const showCreate = () => {
    publishKey.current = globalThis.crypto.randomUUID();
    setOpen(true);
  };

  const submit = async () => {
    try {
      const value = await form.validateFields();
      setSaving(true);
      await postJson("/api/quality/regulatory", {
        ...value,
        marketCode: value.marketCode.trim().toUpperCase(),
        effectiveDate: value.effectiveDate?.format("YYYY-MM-DD"),
        expiryDate: value.expiryDate?.format("YYYY-MM-DD"),
        renewalDueDate: value.renewalDueDate?.format("YYYY-MM-DD"),
        retentionUntil: value.retentionUntil?.format("YYYY-MM-DD"),
        payload: { statement: value.facts.trim() },
        facts: undefined,
        idempotencyKey: publishKey.current,
      });
      message.success("监管证据新版本已发布");
      setOpen(false);
      await load();
    } catch (submitError) {
      if (submitError instanceof Error) message.error(submitError.message);
    } finally {
      setSaving(false);
    }
  };

  const summary = useMemo(() => {
    const latest = rows.filter((row) => row.isLatest);
    return {
      latest: latest.length,
      active: latest.filter((row) => row.status === "active").length,
      renewalRisk: latest.filter((row) => row.renewalState === "overdue" || row.renewalState === "due_soon").length,
      markets: new Set(latest.map((row) => row.marketCode)).size,
    };
  }, [rows]);

  const columns = useMemo<ColumnsType<RegulatoryRecord>>(
    () => [
      {
        title: "证据版本",
        dataIndex: "recordKey",
        fixed: "left",
        width: 250,
        sorter: (a, b) => a.recordKey.localeCompare(b.recordKey) || b.version - a.version,
        render: (key: string, row) => (
          <Space direction="vertical" size={0}>
            <Space size={4} wrap>
              <Typography.Text code>{key}</Typography.Text>
              <Tag color={row.isLatest ? "blue" : "default"}>v{row.version}{row.isLatest ? " · 当前" : ""}</Tag>
            </Space>
            <Typography.Text strong ellipsis={{ tooltip: row.title }} style={{ maxWidth: 220 }}>
              {row.title}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: "类型/市场",
        key: "type",
        width: 165,
        render: (_value, row) => (
          <Space direction="vertical" size={0}>
            <Typography.Text>{RECORD_TYPE_LABELS[row.recordType] ?? row.recordType}</Typography.Text>
            <Typography.Text type="secondary">{row.marketCode} · {row.authority}</Typography.Text>
          </Space>
        ),
      },
      {
        title: "关联对象",
        key: "subject",
        width: 210,
        render: (_value, row) => (
          <Typography.Text>
            {row.skuCode ? `${row.skuCode} · ${row.skuName ?? ""}` : row.supplierName ?? "通用证据"}
          </Typography.Text>
        ),
      },
      {
        title: "状态",
        dataIndex: "status",
        width: 160,
        filters: Object.entries(RECORD_STATUS_LABELS).map(([value, text]) => ({ value, text })),
        onFilter: (value, row) => row.status === value,
        render: (status: string, row) => (
          <Space direction="vertical" size={2}>
            <Tag color={RECORD_STATUS_COLORS[status]}>{RECORD_STATUS_LABELS[status] ?? status}</Tag>
            {row.isOperative ? (
              <Tag color="success">当前可用</Tag>
            ) : status === "active" ? (
              <Tag color="warning">当前不可用</Tag>
            ) : null}
          </Space>
        ),
      },
      {
        title: "有效/续期",
        key: "dates",
        width: 210,
        sorter: (a, b) => (a.renewalDueDate ?? a.expiryDate ?? "9999").localeCompare(b.renewalDueDate ?? b.expiryDate ?? "9999"),
        render: (_value, row) => (
          <Space direction="vertical" size={0}>
            <Typography.Text>{row.effectiveDate ?? "—"} → {row.expiryDate ?? "长期/未填"}</Typography.Text>
            <Space size={4} wrap>
              <Typography.Text type="secondary">{row.renewalDueDate ? `续期 ${row.renewalDueDate}` : "无续期日"}</Typography.Text>
              {dueStateTag(row.renewalState)}
            </Space>
          </Space>
        ),
      },
      {
        title: "监管编号",
        dataIndex: "referenceNo",
        width: 170,
        ellipsis: true,
        render: (value: string | null) => value ?? "—",
      },
      {
        title: "证据摘要",
        dataIndex: "payloadDigest",
        width: 190,
        render: (digest: string) => (
          <Typography.Text code copyable={{ text: digest }}>{digest.slice(0, 14)}…</Typography.Text>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <Row className="compact-kpi-row">
        <KpiCard title="当前证据" value={summary.latest} />
        <KpiCard title="有效版本" value={summary.active} />
        <KpiCard title="续期风险" value={summary.renewalRisk} color={summary.renewalRisk ? "#d46b08" : undefined} />
        <KpiCard title="覆盖市场" value={summary.markets} />
      </Row>
      <ErrorAlert error={error} retry={() => void load()} />
      <ListToolbar
        state={listState}
        extra={(
          <>
            <SearchInput
              allowClear
              value={searchText}
              placeholder="搜索证据键、标题、编号或 SKU"
              style={{ width: 280 }}
              onChange={(event) => {
                setSearchText(event.target.value);
                if (!event.target.value) listState.setFilter({ q: "" });
              }}
              onSearch={(value) => listState.setFilter({ q: value.trim() })}
            />
            <Input
              value={filters.marketCode}
              aria-label="按市场筛选监管证据"
              placeholder="市场"
              maxLength={8}
              style={{ width: 90 }}
              onChange={(event) => listState.setFilter({ marketCode: event.target.value.trim().toUpperCase() })}
            />
            <Select
              value={filters.recordType}
              style={{ width: 150 }}
              options={[
                { value: "", label: "全部证据类型" },
                ...Object.entries(RECORD_TYPE_LABELS).map(([value, label]) => ({ value, label })),
              ]}
              onChange={(recordType) => listState.setFilter({ recordType })}
            />
          </>
        )}
        primaryActions={(
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
            {canWrite ? <Button type="primary" icon={<AuditOutlined />} onClick={showCreate}>发布新版本</Button> : null}
          </>
        )}
      />
      <Table<RegulatoryRecord>
        rowKey="id"
        loading={loading}
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 个版本` }}
        scroll={{ x: 1360 }}
        locale={{
          emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filters.q || filters.marketCode || filters.recordType ? "当前筛选没有匹配的监管证据" : "暂无监管证据版本"} />,
        }}
        expandable={{
          expandedRowRender: (row) => (
            <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }}>
              <Descriptions.Item label="事实载荷">
                {row.payload == null ? (
                  <Typography.Text type="secondary">仅质量合规角色可见</Typography.Text>
                ) : (
                  <Typography.Text code style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
                    {JSON.stringify(row.payload)}
                  </Typography.Text>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="证据引用">{row.evidenceRef ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="保留至">{row.retentionUntil ?? "未设"}</Descriptions.Item>
              <Descriptions.Item label="前一版本">{row.previousId ?? "首版"}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{dateTime(row.createdAt)}</Descriptions.Item>
            </Descriptions>
          ),
        }}
      />

      <Modal
        title="发布监管证据新版本"
        open={open}
        onOk={() => void submit()}
        onCancel={() => setOpen(false)}
        confirmLoading={saving}
        okText="发布不可变版本"
        cancelText="取消"
        maskClosable={false}
        destroyOnHidden
        width={720}
        style={MODAL_TOP_STYLE}
        styles={MODAL_BODY_STYLES}
      >
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="同一证据键会自动生成下一版本；已发布版本不可修改或删除。" />
        <Form form={form} layout="vertical">
          <Row gutter={12}>
            <Col xs={24} sm={12}><Form.Item name="recordKey" label="稳定证据键" rules={[{ required: true, min: 3 }]}><Input maxLength={160} placeholder="如 EXP-SKU001-CN-FILING" /></Form.Item></Col>
            <Col xs={24} sm={12}><Form.Item name="recordType" label="证据类型" rules={[{ required: true }]}><Select options={Object.entries(RECORD_TYPE_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
          </Row>
          <Row gutter={12}>
            <Col xs={24} sm={8}><Form.Item name="marketCode" label="市场" rules={[{ required: true }, { pattern: /^[A-Za-z]{2,8}$/ }]}><Input maxLength={8} /></Form.Item></Col>
            <Col xs={24} sm={8}>
              <Form.Item name="skuId" label="关联 SKU">
                <RemoteSelect
                  api="/api/master/sku"
                  getLabel={(row: RemoteRow) => `${String(row.code)} · ${String(row.name)}`}
                  filterRow={(row: RemoteRow) => row.active !== false}
                  placeholder="搜索 SKU"
                  allowClear
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item name="supplierId" label="关联供应商">
                <RemoteSelect
                  api="/api/master/supplier"
                  getLabel={(row: RemoteRow) => `${String(row.code)} · ${String(row.name)}`}
                  placeholder="搜索供应商"
                  allowClear
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="title" label="标题" rules={[{ required: true, min: 3 }]}><Input maxLength={200} /></Form.Item>
          <Row gutter={12}>
            <Col xs={24} sm={12}><Form.Item name="authority" label="监管/评估机构" rules={[{ required: true, min: 2 }]}><Input maxLength={160} /></Form.Item></Col>
            <Col xs={24} sm={12}><Form.Item name="referenceNo" label="监管编号"><Input maxLength={200} /></Form.Item></Col>
          </Row>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select options={Object.entries(RECORD_STATUS_LABELS).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
          <Row gutter={12}>
            <Col xs={24} sm={12} md={6}><Form.Item name="effectiveDate" label="生效日"><DatePicker style={{ width: "100%" }} /></Form.Item></Col>
            <Col xs={24} sm={12} md={6}><Form.Item name="expiryDate" label="到期日"><DatePicker style={{ width: "100%" }} /></Form.Item></Col>
            <Col xs={24} sm={12} md={6}><Form.Item name="renewalDueDate" label="续期日"><DatePicker style={{ width: "100%" }} /></Form.Item></Col>
            <Col xs={24} sm={12} md={6}><Form.Item name="retentionUntil" label="保留至"><DatePicker style={{ width: "100%" }} /></Form.Item></Col>
          </Row>
          <Form.Item name="facts" label="版本事实摘要" rules={[{ required: true, min: 5 }]}>
            <Input.TextArea rows={4} maxLength={4000} showCount placeholder="记录该版本可复核的核心事实；结构化扩展由后续受控模板承载" />
          </Form.Item>
          <Form.Item name="evidenceRef" label="受控证据引用"><Input maxLength={500} /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function ElectronicLabelsTab() {
  const { message } = App.useApp();
  const me = useMe();
  const canWrite = hasAnyRole(me, "quality");
  const [form] = Form.useForm<LabelForm>();
  const [rows, setRows] = useState<ElectronicLabel[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const loadSequence = useRef(0);
  const publishKey = useRef("");
  const labelMarketCode = Form.useWatch("marketCode", form);
  const labelSkuId = Form.useWatch("skuId", form);
  const labelEffectiveDate = Form.useWatch("effectiveDate", form);
  const listState = useListState({
    key: "quality-electronic-labels",
    defaults: { skuId: "", marketCode: "" },
    paginated: false,
    paramPrefix: "el",
  });
  const { filters } = listState;
  const apiQuery = listState.queryString();

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchJson<ElectronicLabel[]>(`/api/quality/labels?${apiQuery}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      if (sequence === loadSequence.current) setRows(next);
    } catch (loadError) {
      if (!readRequest.isCurrent()) return;
      if (sequence === loadSequence.current) setError((loadError as Error).message);
    } finally {
      if (readRequest.isCurrent()) { if (sequence === loadSequence.current) setLoading(false); }
    }
  }, [beginLoadRead, apiQuery]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({
      marketCode: "CN",
      locale: "zh-CN",
      effectiveDate: dayjs(),
    });
  }, [form, open]);

  const showPublish = () => {
    publishKey.current = globalThis.crypto.randomUUID();
    setOpen(true);
  };

  const submit = async () => {
    try {
      const value = await form.validateFields();
      const ingredients = value.ingredients.split(/\r?\n|，|,/).map((item) => item.trim()).filter(Boolean);
      if (!ingredients.length) {
        message.warning("请至少填写一种成分");
        return;
      }
      setSaving(true);
      await postJson("/api/quality/labels", {
        skuId: value.skuId,
        marketCode: value.marketCode.trim().toUpperCase(),
        locale: value.locale,
        regulatoryRecordId: value.regulatoryRecordId,
        effectiveDate: value.effectiveDate.format("YYYY-MM-DD"),
        content: {
          productName: value.productName,
          responsibleEntity: value.responsibleEntity,
          responsibleAddress: value.responsibleAddress,
          netContent: value.netContent,
          ingredients,
          usage: value.usage,
          precautions: value.precautions,
          batchStatement: value.batchStatement,
          durabilityStatement: value.durabilityStatement,
          origin: value.origin,
          registrationRef: value.registrationRef,
          otherMandatoryText: value.otherMandatoryText,
        },
        idempotencyKey: publishKey.current,
      });
      message.success("电子标签不可变版本已发布");
      setOpen(false);
      await load();
    } catch (submitError) {
      if (submitError instanceof Error) message.error(submitError.message);
    } finally {
      setSaving(false);
    }
  };

  const copyPublicLink = async (path: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      message.success("已复制公开标签链接");
    } catch {
      message.error("复制失败，请打开标签后复制地址栏");
    }
  };

  const summary = useMemo(() => ({
    versions: rows.length,
    current: rows.filter((row) => row.lifecycleState === "current").length,
    scheduled: rows.filter((row) => row.lifecycleState === "scheduled").length,
    blocked: rows.filter((row) => row.lifecycleState === "blocked").length,
    skus: new Set(rows.map((row) => row.skuId)).size,
  }), [rows]);

  const columns: ColumnsType<ElectronicLabel> = [
      {
        title: "产品",
        dataIndex: "skuCode",
        fixed: "left",
        width: 260,
        sorter: (a, b) => a.skuCode.localeCompare(b.skuCode),
        render: (code: string, row) => (
          <Space direction="vertical" size={0}>
            <Typography.Text strong>{code} · {row.skuName}</Typography.Text>
            <Typography.Text type="secondary">{row.labelKey}</Typography.Text>
          </Space>
        ),
      },
      {
        title: "市场/语言",
        key: "market",
        width: 130,
        render: (_value, row) => <><Tag color="blue">{row.marketCode}</Tag><Typography.Text>{row.locale}</Typography.Text></>,
      },
      {
        title: "版本",
        dataIndex: "version",
        width: 135,
        sorter: (a, b) => b.version - a.version,
        render: (version: number, row) => (
          <Tag color={LABEL_STATE[row.lifecycleState].color}>
            v{version} · {LABEL_STATE[row.lifecycleState].text}
          </Tag>
        ),
      },
      {
        title: "生效日",
        dataIndex: "effectiveDate",
        width: 120,
        sorter: (a, b) => a.effectiveDate.localeCompare(b.effectiveDate),
      },
      {
        title: "监管证据",
        key: "regulatory",
        width: 235,
        render: (_value, row) => {
          const support = labelRegulatorySupport(row);
          return (
            <Space direction="vertical" size={2}>
              <Typography.Text>
                {row.regulatoryRecordKey} · v{row.regulatoryRecordVersion}
              </Typography.Text>
              <Space size={4} wrap>
                <Tag color={support.color}>{support.text}</Tag>
                <Typography.Text type="secondary">
                  {row.regulatoryEffectiveDate ?? "即刻"} → {row.regulatoryExpiryDate ?? "长期"}
                </Typography.Text>
              </Space>
            </Space>
          );
        },
      },
      {
        title: "内容摘要",
        dataIndex: "contentDigest",
        width: 210,
        render: (digest: string) => <Typography.Text code copyable={{ text: digest }}>{digest.slice(0, 16)}…</Typography.Text>,
      },
      {
        title: "发布时间",
        dataIndex: "createdAt",
        width: 170,
        render: (value: string) => dateTime(value),
      },
      {
        title: "公开页",
        key: "public",
        fixed: "right",
        width: 155,
        render: (_value, row) => (
          <Space size={0}>
            <Button
              type="link"
              size="small"
              icon={<LinkOutlined />}
              href={row.publicPath}
              target="_blank"
              rel="noopener noreferrer"
            >
              打开
            </Button>
            <Button type="text" size="small" icon={<CopyOutlined />} aria-label="复制公开标签链接" onClick={() => void copyPublicLink(row.publicPath)} />
          </Space>
        ),
      },
    ];

  return (
    <>
      <Row className="compact-kpi-row">
        <KpiCard title="不可变版本" value={summary.versions} />
        <KpiCard title="当前标签" value={summary.current} />
        <KpiCard title="已排期" value={summary.scheduled} />
        <KpiCard title="监管支撑异常" value={summary.blocked} color={summary.blocked ? "#cf1322" : undefined} />
        <KpiCard title="覆盖 SKU" value={summary.skus} />
      </Row>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 10 }}
        message="公开电子标签是产品信息补充页；能否替代实体标签取决于企业资格、目的市场与当前监管要求。"
      />
      <ErrorAlert error={error} retry={() => void load()} />
      <ListToolbar
        state={listState}
        extra={(
          <>
            <RemoteSelect
              api="/api/master/sku"
              aria-label="按 SKU 筛选电子标签"
              getLabel={(row: RemoteRow) => `${String(row.code)} · ${String(row.name)}`}
              filterRow={(row: RemoteRow) => row.active !== false}
              value={filters.skuId ? Number(filters.skuId) : undefined}
              placeholder="搜索 SKU"
              style={{ width: 240 }}
              allowClear
              onChange={(value) => listState.setFilter({ skuId: value ? String(value) : "" })}
            />
            <Input
              value={filters.marketCode}
              aria-label="按市场筛选电子标签"
              placeholder="市场"
              maxLength={8}
              style={{ width: 90 }}
              onChange={(event) => listState.setFilter({ marketCode: event.target.value.trim().toUpperCase() })}
            />
          </>
        )}
        primaryActions={(
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
            {canWrite ? <Button type="primary" icon={<PlusOutlined />} onClick={showPublish}>发布标签</Button> : null}
          </>
        )}
      />
      <Table<ElectronicLabel>
        rowKey="id"
        loading={loading}
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 个版本` }}
        scroll={{ x: 1420 }}
        locale={{
          emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filters.skuId || filters.marketCode ? "当前筛选没有匹配的电子标签" : "暂无电子标签版本；发布前请先建立有效监管证据"} />,
        }}
      />

      <Modal
        title="发布电子标签不可变版本"
        open={open}
        onOk={() => void submit()}
        onCancel={() => setOpen(false)}
        confirmLoading={saving}
        okText="发布"
        cancelText="取消"
        maskClosable={false}
        destroyOnHidden
        width={760}
        style={MODAL_TOP_STYLE}
        styles={MODAL_BODY_STYLES}
      >
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="必须绑定同市场且状态为有效的监管证据版本；发布后内容不可覆盖，只能追加新版本。" />
        <Form
          form={form}
          layout="vertical"
          onValuesChange={(changed) => {
            if ("marketCode" in changed || "skuId" in changed || "effectiveDate" in changed) {
              form.setFieldValue("regulatoryRecordId", undefined);
              form.setFieldValue("registrationRef", undefined);
            }
          }}
        >
          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="skuId" label="SKU" rules={[{ required: true }]}>
                <RemoteSelect
                  api="/api/master/sku"
                  getLabel={(row: RemoteRow) => `${String(row.code)} · ${String(row.name)}`}
                  filterRow={(row: RemoteRow) => row.active !== false}
                  placeholder="搜索 SKU 编码或名称"
                />
              </Form.Item>
            </Col>
            <Col xs={12} sm={6}><Form.Item name="marketCode" label="市场" rules={[{ required: true }, { pattern: /^[A-Za-z]{2,8}$/ }]}><Input maxLength={8} /></Form.Item></Col>
            <Col xs={12} sm={6}><Form.Item name="locale" label="语言" rules={[{ required: true }, { pattern: /^[a-z]{2}(-[A-Z]{2})?$/, message: "如 zh-CN" }]}><Input placeholder="zh-CN" /></Form.Item></Col>
          </Row>
          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="effectiveDate" label="生效日" rules={[{ required: true }]}>
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="regulatoryRecordId" label="生效日有效的监管证据版本" rules={[{ required: true }]}>
                <RegulatoryRecordSelect
                  marketCode={labelMarketCode}
                  skuId={labelSkuId}
                  effectiveDate={labelEffectiveDate}
                  onSelectRecord={(record) => {
                    form.setFieldValue("registrationRef", record?.referenceNo ?? undefined);
                  }}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="productName" label="产品名称" rules={[{ required: true, min: 2 }]}><Input maxLength={200} /></Form.Item>
          <Row gutter={12}>
            <Col xs={24} sm={12}><Form.Item name="responsibleEntity" label="责任主体" rules={[{ required: true, min: 2 }]}><Input maxLength={200} /></Form.Item></Col>
            <Col xs={24} sm={12}><Form.Item name="netContent" label="净含量" rules={[{ required: true }]}><Input maxLength={80} /></Form.Item></Col>
          </Row>
          <Form.Item name="responsibleAddress" label="责任主体地址" rules={[{ required: true, min: 5 }]}><Input maxLength={500} /></Form.Item>
          <Form.Item name="ingredients" label="全成分（每行或逗号分隔）" rules={[{ required: true }]}>
            <Input.TextArea rows={5} maxLength={10000} placeholder={"水\n甘油\n丁二醇"} />
          </Form.Item>
          <Form.Item name="usage" label="使用方法"><Input.TextArea rows={2} maxLength={2000} /></Form.Item>
          <Form.Item name="precautions" label="注意事项" rules={[{ required: true, min: 3 }]}><Input.TextArea rows={3} maxLength={3000} /></Form.Item>
          <Row gutter={12}>
            <Col xs={24} sm={12}><Form.Item name="batchStatement" label="批号说明" rules={[{ required: true, min: 2 }]}><Input maxLength={500} /></Form.Item></Col>
            <Col xs={24} sm={12}><Form.Item name="durabilityStatement" label="限用/保质期说明" rules={[{ required: true, min: 2 }]}><Input maxLength={500} /></Form.Item></Col>
          </Row>
          <Row gutter={12}>
            <Col xs={24} sm={12}><Form.Item name="origin" label="原产地"><Input maxLength={160} /></Form.Item></Col>
            <Col xs={24} sm={12}><Form.Item name="registrationRef" label="注册/备案编号" rules={[{ required: true, min: 2 }]}><Input maxLength={200} /></Form.Item></Col>
          </Row>
          <Form.Item name="otherMandatoryText" label="其他强制信息"><Input.TextArea rows={3} maxLength={5000} /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}
