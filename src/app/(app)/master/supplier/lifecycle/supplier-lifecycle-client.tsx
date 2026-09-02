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
  Input,
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
import { fetchJson, patchJson, postJson } from "@/components/fetchJson";
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

type CaseKind = "admission" | "corrective";
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
}

interface LifecycleData {
  rows: LifecycleRow[];
  total: number;
  summary: {
    open: number;
    overdue: number;
    admissions: number;
    corrective: number;
  };
}

const KIND_LABELS: Record<CaseKind, string> = {
  admission: "准入评审",
  corrective: "整改闭环",
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

interface OpenForm {
  supplierId: number;
  kind: CaseKind;
  priority: Priority;
  reason: string;
  dueDate: Dayjs;
  pauseNewOrders: boolean;
}

interface CloseForm {
  outcome: "approved" | "rejected" | "resolved" | "failed";
  finalStatus?: "qualified" | "paused" | "blacklisted";
  closureNote: string;
}

export default function SupplierLifecycleClient() {
  const { message } = App.useApp();
  const me = useMe();
  const canWrite = hasAnyRole(me, "purchasing");
  const [openForm] = Form.useForm<OpenForm>();
  const [closeForm] = Form.useForm<CloseForm>();
  const [data, setData] = useState<LifecycleData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openModal, setOpenModal] = useState(false);
  const [closing, setClosing] = useState<LifecycleRow | null>(null);
  const [searchText, setSearchText] = useState("");
  const loadSequence = useRef(0);
  const kind = Form.useWatch("kind", openForm) ?? "corrective";
  const closeOutcome = Form.useWatch("outcome", closeForm);

  const listState = useListState({
    key: "supplier-lifecycle",
    defaults: { q: "", status: "open", kind: "", supplierId: "" },
    defaultPageSize: 20,
  });
  const { filters } = listState;
  const apiQuery = listState.queryString();

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await fetchJson<LifecycleData>(
        `/api/master/supplier/lifecycle?${apiQuery}`,
      );
      if (sequence === loadSequence.current) setData(next);
    } catch (error) {
      if (sequence === loadSequence.current) setLoadError((error as Error).message);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [apiQuery]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setSearchText(filters.q);
  }, [filters.q]);

  const showCreate = () => {
    openForm.resetFields();
    openForm.setFieldsValue({
      kind: "corrective",
      priority: "normal",
      dueDate: dayjs().add(14, "day"),
      pauseNewOrders: false,
    });
    setOpenModal(true);
  };

  const submitOpen = async () => {
    try {
      const value = await openForm.validateFields();
      setSaving(true);
      await postJson("/api/master/supplier/lifecycle", {
        ...value,
        dueDate: value.dueDate.format("YYYY-MM-DD"),
        idempotencyKey: globalThis.crypto.randomUUID(),
      });
      message.success(value.kind === "admission" ? "准入评审已发起" : "整改工作项已发起");
      setOpenModal(false);
      await load();
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const showClose = useCallback((row: LifecycleRow) => {
    closeForm.resetFields();
    closeForm.setFieldsValue({
      outcome: row.kind === "admission" ? "approved" : "resolved",
      finalStatus: row.kind === "corrective" ? "qualified" : undefined,
    });
    setClosing(row);
  }, [closeForm]);

  const submitClose = async () => {
    if (!closing) return;
    try {
      const value = await closeForm.validateFields();
      setSaving(true);
      await patchJson(`/api/master/supplier/lifecycle/${closing.id}`, value);
      message.success("工作项已关闭，供应商状态与审计已同步");
      setClosing(null);
      await load();
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const columns = useMemo<ColumnsType<LifecycleRow>>(
    () => [
      {
        title: "供应商",
        dataIndex: "supplierName",
        width: 210,
        fixed: "left",
        sorter: (a, b) => a.supplierCode.localeCompare(b.supplierCode),
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
        filters: Object.entries(KIND_LABELS).map(([value, text]) => ({ value, text })),
        onFilter: (value, row) => row.kind === value,
        render: (value: CaseKind) => (
          <Tag color={value === "admission" ? "blue" : "purple"}>{KIND_LABELS[value]}</Tag>
        ),
      },
      {
        title: "优先级",
        dataIndex: "priority",
        width: 90,
        sorter: (a, b) =>
          ({ normal: 0, high: 1, critical: 2 })[a.priority]
          - ({ normal: 0, high: 1, critical: 2 })[b.priority],
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
        sorter: (a, b) => a.ownerName.localeCompare(b.ownerName),
      },
      {
        title: "截止日",
        dataIndex: "dueDate",
        width: 120,
        sorter: (a, b) => a.dueDate.localeCompare(b.dueDate),
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
            <Tag color="success">{OUTCOME_LABELS[row.outcome ?? ""] ?? "已关闭"}</Tag>
          ),
      },
      {
        title: "操作",
        key: "actions",
        width: 100,
        fixed: "right",
        render: (_value, row) =>
          row.status === "open" && canWrite ? (
            <Button
              type="link"
              size="small"
              icon={<CheckCircleOutlined />}
              onClick={() => showClose(row)}
            >
              完成
            </Button>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          ),
      },
    ],
    [canWrite, showClose],
  );

  return (
    <div className="supplier-lifecycle-page">
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 4 }}>
        供应商准入与整改
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        记分卡提供证据，采购负责人作出决定。系统不会自动准入、暂停或拉黑供应商。
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="最小闭环：发起 → 明确责任人与截止日 → 提交完成证据 → 人工决定供应商状态；全部变更与审计同事务。"
      />

      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="供应商准入与整改" retrying={loading} />

      <Row gutter={[12, 12]} className="supplier-lifecycle-kpis">
        <Col xs={12} md={6}><Card size="small"><Statistic title="进行中" value={data ? data.summary.open : "—"} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="已逾期" value={data ? data.summary.overdue : "—"} valueStyle={{ color: data?.summary.overdue ? "#cf1322" : undefined }} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="待准入" value={data ? data.summary.admissions : "—"} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="整改中" value={data ? data.summary.corrective : "—"} /></Card></Col>
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
              value={filters.kind}
              style={{ width: 130 }}
              options={[
                { value: "", label: "全部类型" },
                { value: "admission", label: "准入评审" },
                { value: "corrective", label: "整改闭环" },
              ]}
              onChange={(value) => listState.setFilter({ kind: value })}
            />
          </>
        )}
        primaryActions={(
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
            {canWrite ? <Button type="primary" icon={<PlusOutlined />} onClick={showCreate}>发起工作项</Button> : null}
          </>
        )}
      />

      <Table<LifecycleRow>
        rowKey="id"
        className="supplier-lifecycle-table"
        loading={loading}
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        pagination={listState.paginationProps({ total: data?.total })}
        scroll={{ x: 1265 }}
        locale={{ emptyText: loadError ? "数据未加载" : "当前条件下无供应商工作项" }}
        expandable={{
          expandedRowRender: (row) => (
            <div className="supplier-lifecycle-evidence">
              <Typography.Text strong>发起原因</Typography.Text>
              <Typography.Paragraph>{row.reason}</Typography.Paragraph>
              {row.closureNote ? (
                <>
                  <Typography.Text strong>完成证据</Typography.Text>
                  <Typography.Paragraph style={{ marginBottom: 0 }}>{row.closureNote}</Typography.Paragraph>
                </>
              ) : null}
            </div>
          ),
        }}
      />

      <Modal
        title="发起供应商工作项"
        open={openModal}
        onOk={() => void submitOpen()}
        onCancel={() => setOpenModal(false)}
        confirmLoading={saving}
        okText="发起"
        cancelText="取消"
        maskClosable={false}
        style={{ top: 24 }}
        styles={{
          body: {
            maxHeight: "calc(100vh - 180px)",
            overflowY: "auto",
          },
        }}
        destroyOnHidden
      >
        <Form form={openForm} layout="vertical">
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
          <Form.Item name="dueDate" label="截止日" rules={[{ required: true, message: "请选择截止日" }]}>
            <DatePicker style={{ width: "100%" }} disabledDate={(date) => date.startOf("day").isBefore(dayjs().startOf("day"))} />
          </Form.Item>
          <Form.Item name="reason" label={kind === "admission" ? "准入依据与待核事项" : "问题、目标与完成标准"} rules={[{ required: true }]}>
            <Input.TextArea rows={4} maxLength={500} showCount placeholder="写明证据缺口、责任动作与可验证的完成标准" />
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
        onCancel={() => setClosing(null)}
        confirmLoading={saving}
        okText="确认完成"
        cancelText="取消"
        maskClosable={false}
        style={{ top: 24 }}
        styles={{
          body: {
            maxHeight: "calc(100vh - 180px)",
            overflowY: "auto",
          },
        }}
        destroyOnHidden
      >
        <Form form={closeForm} layout="vertical">
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
                  : [
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
          <Form.Item name="closureNote" label="完成证据" rules={[{ required: true, min: 5, message: "请填写至少 5 个字的完成证据" }]}>
            <Input.TextArea rows={5} maxLength={1000} showCount placeholder="记录核验结果、附件位置、后续限制或复查要求" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
