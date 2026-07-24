"use client";

/** NPD 1.x 项目跟踪（D19 激活）：69 节点标准模板实例化 → 计划推算 → 任务推进 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert, App, Button, DatePicker, Drawer, Form, Input, Modal, Popconfirm, Progress, Select, Space, Table, Tag, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { fetchJson, postJson } from "@/components/fetchJson";

interface ProjectRow {
  id: number;
  name: string;
  skuCode: string | null;
  brand: string | null;
  startDate: string;
  status: string;
  remark: string | null;
  taskTotal: number;
  taskDone: number;
  planEnd: string | null;
  overdueTasks: number;
}

interface TaskRow {
  id: number;
  seq: number;
  nodeNo: string | null;
  name: string;
  stage: string | null;
  dept: string | null;
  days: number;
  planStart: string | null;
  planEnd: string | null;
  status: string;
  doneAt: string | null;
  note: string | null;
  overdue: boolean;
}

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  active: { color: "processing", label: "进行中" },
  done: { color: "success", label: "已完成" },
  cancelled: { color: "default", label: "已取消" },
};
const TASK_STATUS: Record<string, { color: string; label: string }> = {
  pending: { color: "default", label: "未开始" },
  doing: { color: "processing", label: "进行中" },
  done: { color: "success", label: "完成" },
  skipped: { color: "warning", label: "跳过" },
};

async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `请求失败（${res.status}）`);
  return data;
}

export default function NpdProjectsClient() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm<{ name: string; skuCode?: string; brand?: string; startDate: Dayjs; remark?: string }>();

  const [detail, setDetail] = useState<{ project: ProjectRow; tasks: TaskRow[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [skuDraft, setSkuDraft] = useState("");
  const [savingSku, setSavingSku] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchJson<{ projects: ProjectRow[] }>("/api/npd/projects");
      setRows(d.projects);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);
  useEffect(() => { void load(); }, [load]);

  const openDetail = async (id: number) => {
    setSkuDraft("");
    setDetailLoading(true);
    try {
      setDetail(await fetchJson<{ project: ProjectRow; tasks: TaskRow[] }>(`/api/npd/projects?id=${id}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleCreate = async () => {
    const v = await form.validateFields();
    setCreating(true);
    try {
      const res = await postJson<{ id: number; taskCount: number; planEnd: string }>("/api/npd/projects", {
        name: v.name,
        skuCode: v.skuCode || undefined,
        brand: v.brand || undefined,
        startDate: v.startDate.format("YYYY-MM-DD"),
        remark: v.remark || undefined,
      });
      message.success(`项目已创建：${res.taskCount} 个节点任务，计划完成 ${res.planEnd}`);
      setCreateOpen(false);
      form.resetFields();
      void load();
      void openDetail(res.id);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const setTask = async (taskId: number, status: string) => {
    try {
      await patchJson("/api/npd/tasks", { taskId, status });
      if (detail) void openDetail(detail.project.id);
      void load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const saveSku = async (projectId: number) => {
    const code = skuDraft.trim();
    if (!code) { message.error("请填写目标 SKU 编码"); return; }
    setSavingSku(true);
    try {
      await patchJson("/api/npd/projects", { intent: "set_sku", projectId, skuCode: code });
      message.success("目标 SKU 已补录");
      setSkuDraft("");
      void openDetail(projectId);
      void load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSavingSku(false);
    }
  };

  const reschedule = async (projectId: number) => {
    setRescheduling(true);
    try {
      const r = await patchJson<{ changed: number; planEnd: string }>("/api/npd/projects", { intent: "reschedule", projectId });
      message.success(`计划已重排：${r.changed} 个任务顺延，计划完成 ${r.planEnd}`);
      void openDetail(projectId);
      void load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setRescheduling(false);
    }
  };

  const setProject = async (projectId: number, status: string) => {
    try {
      await patchJson("/api/npd/projects", { projectId, status });
      message.success("项目状态已更新");
      setDetail(null);
      void load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const columns: ColumnsType<ProjectRow> = [
    { title: "项目", dataIndex: "name", width: 220, render: (v: string, r) => <a onClick={() => void openDetail(r.id)}>{v}</a> },
    { title: "目标 SKU", dataIndex: "skuCode", width: 130, render: (v: string | null) => v ?? "—" },
    { title: "品牌", dataIndex: "brand", width: 110, render: (v: string | null) => v ?? "—" },
    { title: "启动日", dataIndex: "startDate", width: 110 },
    { title: "计划完成", dataIndex: "planEnd", width: 110, render: (v: string | null) => v ?? "—" },
    {
      title: "进度",
      width: 170,
      render: (_, r) => (
        <Progress
          size="small"
          percent={r.taskTotal ? Math.round((r.taskDone / r.taskTotal) * 100) : 0}
          format={() => `${r.taskDone}/${r.taskTotal}`}
        />
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 150,
      render: (v: string, r) => (
        <Space size={4}>
          <Tag color={STATUS_TAG[v]?.color}>{STATUS_TAG[v]?.label ?? v}</Tag>
          {r.overdueTasks > 0 ? <Tag color="orange">逾期 {r.overdueTasks}</Tag> : null}
        </Space>
      ),
    },
  ];

  const taskCols: ColumnsType<TaskRow> = [
    { title: "#", dataIndex: "seq", width: 45 },
    { title: "编号", dataIndex: "nodeNo", width: 65, render: (v: string | null) => (v && v.length <= 10 ? v : "—") },
    { title: "节点", dataIndex: "name", ellipsis: true, width: 230 },
    { title: "阶段", dataIndex: "stage", width: 95, render: (v: string | null) => (v ? <Tag>{v}</Tag> : "—") },
    { title: "部门/岗位", dataIndex: "dept", width: 150, ellipsis: true, render: (v: string | null) => v ?? "—" },
    { title: "天数", dataIndex: "days", width: 55, align: "right" },
    {
      title: "计划",
      width: 210,
      render: (_, r) => (
        <Space size={4}>
          <span>{r.planStart ? `${r.planStart} ~ ${r.planEnd}` : "—"}</span>
          {r.overdue ? <Tag color="red">逾期</Tag> : null}
        </Space>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 210,
      render: (v: string, r) => (
        <Space size={4}>
          <Select
            size="small"
            value={v}
            style={{ width: 92 }}
            onChange={(nv) => void setTask(r.id, nv)}
            options={Object.entries(TASK_STATUS).map(([val, m]) => ({ value: val, label: m.label }))}
          />
          {r.doneAt ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.doneAt}</Typography.Text> : null}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>NPD 项目跟踪</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="D19 · 1.x：新建项目按「各节点核心说明」69 节点标准实例化，计划沿上一节点链推算（自然日）。节点标准/角色分配见「NPD 节点参考」页。"
      />
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建 NPD 项目
        </Button>
      </Space>
      <Table<ProjectRow> rowKey="id" size="small" columns={columns} dataSource={rows} loading={loading} pagination={false} scroll={{ x: "max-content" }} />

      <Modal
        title="新建 NPD 项目（按 69 节点标准实例化）"
        open={createOpen}
        onOk={() => void handleCreate()}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={creating}
        okText="创建"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" initialValues={{ startDate: dayjs() }}>
          <Form.Item name="name" label="项目名称" rules={[{ required: true, min: 2, message: "至少 2 字" }]}>
            <Input placeholder="如：EXPRESSIONS 秋季新品-胶原蛋白饮" maxLength={120} />
          </Form.Item>
          <Space style={{ display: "flex" }} align="start">
            <Form.Item name="skuCode" label="目标 SKU（可后补）">
              <Input placeholder="如 E120-000" maxLength={60} />
            </Form.Item>
            <Form.Item name="brand" label="品牌">
              <Input maxLength={60} />
            </Form.Item>
            <Form.Item name="startDate" label="启动日期" rules={[{ required: true }]}>
              <DatePicker />
            </Form.Item>
          </Space>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={detail ? `${detail.project.name}（${detail.tasks.filter((t) => t.status === "done" || t.status === "skipped").length}/${detail.tasks.length}）` : ""}
        open={detail != null}
        onClose={() => setDetail(null)}
        width="min(1080px, 100vw)"
        extra={
          detail && detail.project.status === "active" ? (
            <Space>
              <Button loading={rescheduling} onClick={() => void reschedule(detail.project.id)}>
                重排计划
              </Button>
              {detail.project.skuCode ? (
                <Button
                  onClick={() => {
                    const qty = window.prompt(`新品首单数量（${detail.project.skuCode}，基础单位）：`);
                    if (!qty || !/^\d+(\.\d+)?$/.test(qty.trim()) || Number(qty) <= 0) { if (qty != null) message.error("数量必须为正数"); return; }
                    void postJson<{ docNo: string }>("/api/npd/projects", { intent: "first_order", projectId: detail.project.id, qty: qty.trim() })
                      .then((r) => message.success(`首单备货申请草稿已生成：${r.docNo}（备货申请页提交审批）`))
                      .catch((e) => message.error((e as Error).message));
                  }}
                >
                  生成首单 BH
                </Button>
              ) : null}
              <Popconfirm title="确认整项目完成？" onConfirm={() => void setProject(detail.project.id, "done")}>
                <Button type="primary">标记完成</Button>
              </Popconfirm>
              <Popconfirm title="确认取消项目？（任务保留，仅状态标记）" onConfirm={() => void setProject(detail.project.id, "cancelled")}>
                <Button danger>取消项目</Button>
              </Popconfirm>
            </Space>
          ) : null
        }
      >
        {detail && detail.project.status === "active" && !detail.project.skuCode ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 8 }}
            message="目标 SKU 尚未设置——补录后方可生成新品首单 BH"
            description={
              <Space.Compact style={{ marginTop: 4 }}>
                <Input
                  placeholder="目标 SKU 编码或别名，如 N024-000"
                  value={skuDraft}
                  maxLength={60}
                  style={{ width: 260 }}
                  onChange={(e) => setSkuDraft(e.target.value)}
                  onPressEnter={() => void saveSku(detail.project.id)}
                />
                <Button type="primary" loading={savingSku} onClick={() => void saveSku(detail.project.id)}>
                  补录目标 SKU
                </Button>
              </Space.Compact>
            }
          />
        ) : null}
        <Space style={{ marginBottom: 8 }}>
          <Select
            allowClear
            placeholder="全部阶段"
            style={{ width: 200 }}
            value={stageFilter}
            onChange={(v) => setStageFilter(v ?? null)}
            options={[...new Set((detail?.tasks ?? []).map((t) => t.stage).filter(Boolean))].map((st) => ({ value: st as string, label: st as string }))}
          />
        </Space>
        <Table<TaskRow>
          rowKey="id"
          size="small"
          columns={taskCols}
          dataSource={(detail?.tasks ?? []).filter((t) => !stageFilter || t.stage === stageFilter)}
          loading={detailLoading}
          pagination={false}
          scroll={{ x: "max-content" }}
          rowClassName={(r) => (r.overdue ? "npd-overdue-row" : "")}
        />
        <style dangerouslySetInnerHTML={{ __html: ".npd-overdue-row > td { background: #fff1f0; }" }} />
      </Drawer>
    </div>
  );
}
