"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, Descriptions, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Radio, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, PrinterOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import RemoteSelect from "@/components/RemoteSelect";
import DocStatusTag from "@/components/DocStatusTag";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import { fetchJson, postJson } from "@/components/fetchJson";
import ApprovalTimeline from "@/components/ApprovalTimeline";

/** 抽盘=循环抽点（原 PRD"永续盘点"）；full=定期全盘 */
const MODE_LABELS: Record<string, string> = { full: "定期全盘", partial: "抽盘" };
const MODE_COLORS: Record<string, string> = { full: "blue", partial: "purple" };

interface TaskRow {
  id: number;
  docNo: string;
  status: string;
  mode: string;
  warehouseName: string | null;
  lineCount: number;
  diffCount: number;
  diffTotal: string;
  createdByName: string | null;
  createdAt: string;
}

interface TaskLine {
  id: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  batchId: number | null;
  bookQty: string;
  countedQty: string;
  diffQty: string;
  adjustDocId: number | null;
}

interface TaskApproval {
  approverName: string | null;
  action: "approve" | "reject";
  comment: string | null;
  createdAt: string;
}

interface TaskDetail {
  id: number;
  docNo: string;
  status: string;
  mode: string;
  remark: string | null;
  version: number;
  warehouseId: number;
  warehouseName: string | null;
  lines: TaskLine[];
  adjustDocs: { id: number; docNo: string }[];
  approvals: TaskApproval[];
  createdByName: string | null;
  createdAt: string;
}

interface CreateFormValues {
  warehouseId: number;
  mode: "full" | "partial";
  q?: string;
  skuIds?: number[];
  remark?: string;
}

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "completed", label: "已完成" },
];

/** 精确十进制减法（显示用；禁 float——与 PO 打印页同一约定），scale=4 */
function subDec(a: string, b: string): string {
  const toU = (s: string): bigint => {
    const t = s.trim();
    const neg = t.startsWith("-");
    const [i, f = ""] = (neg ? t.slice(1) : t).split(".");
    const v = BigInt((i || "0") + (f + "0000").slice(0, 4));
    return neg ? -v : v;
  };
  const v = toU(a) - toU(b);
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(5, "0");
  const int = s.slice(0, -4);
  const frac = s.slice(-4).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
}

/** 差异展示：盈=绿 亏=红 平=灰 */
function DiffText({ value }: { value: string }) {
  const trimmed = (value ?? "").trim();
  const isZero = !trimmed || /^-?0(\.0*)?$/.test(trimmed);
  if (isZero) return <Typography.Text type="secondary">0</Typography.Text>;
  const neg = trimmed.startsWith("-");
  return (
    <Typography.Text style={{ color: neg ? "#cf1322" : "#389e0d", fontWeight: 600 }}>
      {neg ? trimmed : `+${trimmed}`}
    </Typography.Text>
  );
}

export default function CountClient() {
  // useSearchParams（列表页状态平台 E6-P1）需要 Suspense 边界
  return (
    <Suspense>
      <CountInner />
    </Suspense>
  );
}

function CountInner() {
  const { message } = App.useApp();
  const [form] = Form.useForm<CreateFormValues>();
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({
    key: "count",
    defaults: { q: "", status: "", mode: "" },
    defaultPageSize: 20,
  });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const status = filters.status;
  const mode = filters.mode || undefined;

  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const createMode = Form.useWatch("mode", form);

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  /** 草稿态本地编辑的实盘数（lineId → 输入值） */
  const [edited, setEdited] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      if (mode) params.set("mode", mode);
      const res = await fetchJson<{ rows: TaskRow[]; total: number }>(`/api/inventory/count?${params.toString()}`);
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, status, mode, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetail = useCallback(
    async (id: number) => {
      setDetailLoading(true);
      try {
        const res = await fetchJson<TaskDetail>(`/api/inventory/count/${id}`);
        setDetail(res);
        setEdited({});
      } catch (e) {
        message.error((e as Error).message);
      } finally {
        setDetailLoading(false);
      }
    },
    [message],
  );

  useEffect(() => {
    if (detailId != null) void loadDetail(detailId);
    else {
      setDetail(null);
      setEdited({});
    }
  }, [detailId, loadDetail]);

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const filters =
        values.mode === "partial"
          ? {
              q: values.q?.trim() || undefined,
              skuIds: values.skuIds && values.skuIds.length > 0 ? values.skuIds : undefined,
            }
          : undefined;
      await postJson<{ id: number }>("/api/inventory/count", {
        warehouseId: values.warehouseId,
        mode: values.mode,
        filters,
        remark: values.remark?.trim() || undefined,
      });
      message.success("盘点任务已创建（草稿）——账面数已快照");
      setCreateOpen(false);
      form.resetFields();
      void load();
    } catch (e) {
      if (e instanceof Error && e.message) message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const doAction = async (path: string, body: unknown, successText: string): Promise<boolean> => {
    if (!detail) return false;
    setActionLoading(true);
    try {
      await postJson(`/api/inventory/count/${detail.id}/${path}`, body);
      message.success(successText);
      void loadDetail(detail.id);
      void load();
      return true;
    } catch (e) {
      message.error((e as Error).message);
      return false;
    } finally {
      setActionLoading(false);
    }
  };

  const dirtyCount = useMemo(() => Object.keys(edited).length, [edited]);

  const saveCounts = async () => {
    if (!detail || dirtyCount === 0) return;
    await doAction(
      "lines",
      {
        version: detail.version,
        lines: Object.entries(edited).map(([lineId, countedQty]) => ({ lineId: Number(lineId), countedQty })),
      },
      "实盘数已保存",
    );
  };

  const columns: ColumnsType<TaskRow> = [
    {
      title: "单据号",
      dataIndex: "docNo",
      width: 160,
      render: (v: string, r) => <Typography.Link onClick={() => setDetailId(r.id)}>{v}</Typography.Link>,
    },
    {
      title: "模式",
      dataIndex: "mode",
      width: 100,
      render: (v: string) => <Tag color={MODE_COLORS[v] ?? "default"}>{MODE_LABELS[v] ?? v}</Tag>,
    },
    { title: "仓库", dataIndex: "warehouseName" },
    { title: "行数", dataIndex: "lineCount", width: 70, align: "right" },
    {
      title: "差异行数",
      dataIndex: "diffCount",
      width: 90,
      align: "right",
      render: (v: number) => (v > 0 ? <Typography.Text type="warning">{v}</Typography.Text> : v),
    },
    {
      title: "盈亏合计",
      dataIndex: "diffTotal",
      width: 110,
      align: "right",
      render: (v: string) => <DiffText value={v} />,
    },
    { title: "制单人", dataIndex: "createdByName", width: 100 },
    {
      title: "时间",
      dataIndex: "createdAt",
      width: 150,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm"),
    },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <DocStatusTag status={v} /> },
  ];

  const editable = detail?.status === "draft";

  const lineColumns: ColumnsType<TaskLine> = [
    { title: "SKU 编码", dataIndex: "skuCode", width: 110 },
    { title: "名称", dataIndex: "skuName" },
    { title: "单位", dataIndex: "baseUom", width: 70 },
    { title: "账面数", dataIndex: "bookQty", width: 100, align: "right" },
    {
      title: "实盘数",
      dataIndex: "countedQty",
      width: 130,
      align: "right",
      render: (v: string, r) =>
        editable ? (
          <InputNumber
            min={0}
            precision={4}
            size="small"
            style={{ width: 120 }}
            value={edited[r.id] != null ? Number(edited[r.id]) : Number(v)}
            onChange={(val) => {
              if (val == null) return;
              setEdited((prev) => ({ ...prev, [r.id]: String(val) }));
            }}
          />
        ) : (
          v
        ),
    },
    {
      title: "差异",
      key: "diff",
      width: 100,
      align: "right",
      render: (_, r) => {
        // 草稿态按本地编辑值即时计算展示（提交后以服务端为准）；十进制字符串运算，禁 float
        const shown = edited[r.id] != null ? subDec(edited[r.id], r.bookQty) : r.diffQty;
        return <DiffText value={shown} />;
      },
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        盘点任务
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
        抽盘=循环抽点（原&ldquo;永续盘点&rdquo;）：不停业、按计划抽部分货品；全盘=定期全仓清点。审批（财务）通过后自动生成盘盈亏调整单（CA）过账。
      </Typography.Paragraph>
      <Tabs
        activeKey={status}
        items={STATUS_TABS}
        onChange={(key) => listState.setFilter({ status: key })}
      />
      <Space style={{ marginBottom: 12, width: "100%", justifyContent: "flex-end" }} wrap>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            form.resetFields();
            form.setFieldsValue({ mode: "partial" });
            setCreateOpen(true);
          }}
        >
          新建盘点任务
        </Button>
      </Space>
      <ListToolbar
        state={listState}
        extra={
          <>
            <Input.Search
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索单据号"
              style={{ width: 220 }}
              onSearch={(value) => listState.setFilter({ q: value.trim() })}
            />
            <Select
              allowClear
              placeholder="全部模式"
              style={{ width: 140 }}
              options={Object.entries(MODE_LABELS).map(([value, label]) => ({ value, label }))}
              value={mode}
              onChange={(v) => listState.setFilter({ mode: v ?? "" })}
            />
          </>
        }
      />
      <Table<TaskRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        scroll={{ x: "max-content" }}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => listState.setPage(p, ps),
        }}
      />

      <Modal
        title="新建盘点任务"
        open={createOpen}
        onOk={() => void handleCreate()}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={saving}
        width="min(640px, 100vw)"
        forceRender
        maskClosable={false}
        okText="创建（快照账面数）"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="warehouseId" label="仓库（仅实时记账仓）" rules={[{ required: true, message: "必须选择仓库" }]}>
            <RemoteSelect
              api="/api/master/warehouse"
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              filterRow={(r) => r.accountingMode === "realtime" && r.active !== false}
              placeholder="选择仓库"
            />
          </Form.Item>
          <Form.Item name="mode" label="盘点模式" rules={[{ required: true }]}>
            <Radio.Group>
              <Radio.Button value="partial">抽盘（循环抽点）</Radio.Button>
              <Radio.Button value="full">定期全盘</Radio.Button>
            </Radio.Group>
          </Form.Item>
          {createMode === "partial" ? (
            <>
              <Form.Item name="skuIds" label="指定 SKU（可多选；留空则按关键词/全部非零行）">
                <RemoteSelect
                  api="/api/master/sku"
                  mode="multiple"
                  getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
                  placeholder="选择要抽盘的 SKU"
                />
              </Form.Item>
              <Form.Item name="q" label="关键词筛选（SKU 编码/名称/产品名）">
                <Input allowClear placeholder="如：包材 / RA000 / 精华液" maxLength={100} />
              </Form.Item>
            </>
          ) : null}
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={200} placeholder="如：7 月循环抽点第 3 批" />
          </Form.Item>
        </Form>
        <Typography.Text type="secondary">
          创建时将快照当前账面数为盘前基准；实盘数默认预填=账面数，请逐行改为实际清点数。
        </Typography.Text>
      </Modal>

      <Drawer
        title={
          detail ? (
            <Space>
              <span>{detail.docNo}</span>
              <Tag color={MODE_COLORS[detail.mode] ?? "default"}>{MODE_LABELS[detail.mode] ?? detail.mode}</Tag>
              <DocStatusTag status={detail.status} />
            </Space>
          ) : (
            "盘点单详情"
          )
        }
        open={detailId != null}
        onClose={() => setDetailId(null)}
        width="min(860px, 100vw)"
        loading={detailLoading}
        extra={
          detail ? (
            <Space>
              <Button
                icon={<PrinterOutlined />}
                onClick={() => window.open(`/inventory/count/${detail.id}/print`, "_blank")}
              >
                打印盘点表
              </Button>
              {editable ? (
                <Button
                  icon={<SaveOutlined />}
                  disabled={dirtyCount === 0}
                  loading={actionLoading}
                  onClick={() => void saveCounts()}
                >
                  保存实盘数{dirtyCount > 0 ? `（${dirtyCount}）` : ""}
                </Button>
              ) : null}
              {detail.status === "draft" ? (
                <Popconfirm
                  title={dirtyCount > 0 ? "有未保存的实盘数，提交前请先保存。仍要提交？" : "确认提交财务审批？"}
                  okText="提交"
                  cancelText="取消"
                  onConfirm={() => void doAction("submit", { version: detail.version }, "已提交审批（盘点=财务审批域）")}
                >
                  <Button type="primary" loading={actionLoading}>
                    提交
                  </Button>
                </Popconfirm>
              ) : null}
              {detail.status === "pending" ? (
                <>
                  <Popconfirm
                    title="审批通过将立即生成盘盈亏调整单并过账，确认？"
                    okText="通过"
                    cancelText="取消"
                    onConfirm={() =>
                      void doAction("approve", { action: "approve", version: detail.version }, "审批通过，差异已过账")
                    }
                  >
                    <Button type="primary" loading={actionLoading}>
                      审批通过
                    </Button>
                  </Popconfirm>
                  <Button danger loading={actionLoading} onClick={() => setRejectOpen(true)}>
                    驳回
                  </Button>
                </>
              ) : null}
            </Space>
          ) : null
        }
      >
        {detail ? (
          <div>
            <Descriptions column={2} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="仓库">{detail.warehouseName ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="模式">{MODE_LABELS[detail.mode] ?? detail.mode}</Descriptions.Item>
              <Descriptions.Item label="制单人">{detail.createdByName ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="制单时间">{dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm")}</Descriptions.Item>
              <Descriptions.Item label="备注">{detail.remark ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="调整单">
                {detail.adjustDocs.length > 0
                  ? detail.adjustDocs.map((a) => (
                      <Typography.Link key={a.id} href={`/inventory/docs?q=${encodeURIComponent(a.docNo)}`}>
                        {a.docNo}
                      </Typography.Link>
                    ))
                  : detail.status === "completed"
                    ? "无差异，未生成"
                    : "—"}
              </Descriptions.Item>
            </Descriptions>
            {editable ? (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                实盘数已预填账面数——只需修改有差异的行；未改动的行视为账实相符。
              </Typography.Paragraph>
            ) : null}
            <Table<TaskLine>
              rowKey="id"
              size="small"
              columns={lineColumns}
              dataSource={detail.lines}
              pagination={detail.lines.length > 100 ? { pageSize: 100, showSizeChanger: false } : false}
              style={{ marginBottom: 24 }}
            />
            {detail.approvals.length > 0 ? (
              <>
                <Typography.Title level={5}>审批记录</Typography.Title>
                <ApprovalTimeline items={detail.approvals} />
              </>
            ) : null}
          </div>
        ) : null}
      </Drawer>

      <Modal
        title="驳回盘点单"
        open={rejectOpen}
        okText="确认驳回"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={actionLoading}
        onCancel={() => setRejectOpen(false)}
        onOk={() =>
          void doAction(
            "approve",
            { action: "reject", comment: rejectComment.trim() || undefined, version: detail?.version },
            "已驳回，退回草稿",
          ).then((ok) => {
            if (ok) {
              setRejectOpen(false);
              setRejectComment("");
            }
          })
        }
      >
        <Input.TextArea
          rows={3}
          maxLength={200}
          placeholder="驳回意见（可选）"
          value={rejectComment}
          onChange={(e) => setRejectComment(e.target.value)}
        />
      </Modal>
    </div>
  );
}
