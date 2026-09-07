"use client";

/** NPD 1.x 项目跟踪（D19 激活）：69 节点标准模板实例化 → 计划推算 → 任务推进 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import styles from "./npd-projects.module.css";
import {
  Alert, App, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Progress, Row, Select, Space, Table, Tag, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import DecisionVisual from "@/components/DecisionVisual";
import ProductExternalDecisionEvidenceCard from "@/components/ProductExternalDecisionEvidenceCard";
import { patchJson, postJson } from "@/components/fetchJson";
import { hasAnyRole, useMe } from "@/components/useMe";
import { useDocumentRead } from "@/components/useDocumentRead";
import { useDocumentTarget } from "@/components/useDocumentTarget";
import DocumentDrawer from "@/components/DocumentDrawer";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import { documentHref, DOCUMENT_TRANSIENT_PARAMS } from "@/lib/document-links";
import { buildLaunchExternalEvidenceBriefs } from "@/components/launch-external-evidence";
import type { ProductExternalDecisionEvidenceBrief } from "@/components/product-external-decision-evidence";
import { ACTION } from "@/components/dictionary";
import type { JiandaoyunSupportingObservation } from "@/server/modules/report/jiandaoyun-supporting-observation";

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

const displayExternalMetric = (value: string): string => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString("zh-CN", { maximumFractionDigits: 4 })
    : value;
};

function LaunchExternalEvidence({ observations }: { observations: readonly JiandaoyunSupportingObservation[] }) {
  const briefs = buildLaunchExternalEvidenceBriefs(observations);
  return (
    <Card
      size="small"
      title="简道云新品外部佐证（历史观察，非上市就绪）"
      extra={<Button type="link" size="small" href="/import/exceptions?status=open&scope=JIANDAOYUN">处理身份认领</Button>}
      style={{ marginBottom: 12 }}
    >
      <Alert
        banner
        showIcon
        type="warning"
        message="新品里程碑流尚未实现；产品主档和样品旧表只能补充背景，不能证明里程碑、首单到货或首销已完成。"
        style={{ marginBottom: 10 }}
      />
      <Row gutter={[10, 10]}>
        {briefs.map((brief) => (
          <Col xs={24} xl={12} key={brief.stream}>
            <Card
              type="inner"
              size="small"
              title={brief.label}
              extra={<Tag color={brief.state === "available" ? "gold" : "default"}>{brief.state === "available" ? "历史辅助" : "缺失"}</Tag>}
            >
              {brief.state === "missing" ? (
                <Typography.Text type="secondary">尚无最新成功批次；保持未知，不显示为 0。</Typography.Text>
              ) : (
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Typography.Text type="secondary">源截止 {brief.sourceAsOf ?? "未提供"} · 业务期 {brief.period}</Typography.Text>
                  <Space size={[6, 6]} wrap>
                    {brief.metrics.map((metric) => (
                      <Tag key={metric.key}>{metric.label} {displayExternalMetric(metric.value)}{metric.unit}</Tag>
                    ))}
                  </Space>
                  <Space size={[6, 6]} wrap>
                    {brief.identities.length > 0 ? brief.identities.map((identity) => (
                      <Tag color={identity.openValues > 0 ? "orange" : "default"} key={identity.kind}>
                        {identity.label} {identity.governedMatches}/{identity.distinctValues} · 待认领 {identity.openValues}
                      </Tag>
                    )) : <Typography.Text type="secondary">该批次未提供可治理身份。</Typography.Text>}
                  </Space>
                </Space>
              )}
            </Card>
          </Col>
        ))}
      </Row>
    </Card>
  );
}

interface ProjectDetail { project: Omit<ProjectRow, "taskTotal" | "taskDone" | "planEnd" | "overdueTasks">; tasks: TaskRow[] }
interface EvidenceResponse {
  supportingObservations: JiandaoyunSupportingObservation[];
  externalDecisionEvidence: ProductExternalDecisionEvidenceBrief;
}

export default function NpdProjectsClient() {
  const { message } = App.useApp();
  const me = useMe();
  const canWrite = hasAnyRole(me, "ops", "pmc");
  const selection = useDocumentTarget();
  const listRead = useDocumentRead<{ projects: ProjectRow[] }>("/api/npd/projects?view=projects");
  const evidenceRead = useDocumentRead<EvidenceResponse>("/api/npd/projects?view=evidence");
  const listState = useListState({ key: "npd-projects", defaults: { q: "", status: "", sortBy: "", sortOrder: "" },
    transientParams: DOCUMENT_TRANSIENT_PARAMS, defaultPageSize: 20 });
  const { q, status } = listState.filters;
  const [searchText, setSearchText] = useState(q);
  useEffect(() => setSearchText(q), [q]);
  const allRows = listRead.data?.projects ?? [];
  const rows = allRows.filter(row => (!status || row.status === status)
    && (!q || [row.name, row.skuCode, row.brand].some(value => value?.toLocaleLowerCase().includes(q.toLocaleLowerCase()))));
  const loading = listRead.phase === "loading";
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [form] = Form.useForm<{ name: string; skuCode?: string; brand?: string; startDate: Dayjs; remark?: string }>();
  const openDetail = (id: number) => selection.setId(id);
  const orderFor = (field: string) => listState.filters.sortBy !== field ? null
    : listState.filters.sortOrder === "asc" ? "ascend" as const : listState.filters.sortOrder === "desc" ? "descend" as const : null;
  const handleCreate = async () => {
    if (!canWrite || creatingRef.current) return;
    creatingRef.current = true;
    try {
      const v = await form.validateFields();
      setCreating(true);
      const res = await postJson<{ id: number; taskCount: number; planEnd: string }>("/api/npd/projects", {
        name: v.name, skuCode: v.skuCode || undefined, brand: v.brand || undefined,
        startDate: v.startDate.format("YYYY-MM-DD"), remark: v.remark || undefined,
      });
      if (!mounted.current) return;
      message.success(`项目已创建：${res.taskCount} 个节点任务，计划完成 ${res.planEnd}`);
      setCreateOpen(false); form.resetFields(); listRead.retry(); openDetail(res.id);
    } catch (error) {
      if (mounted.current && !(typeof error === "object" && error !== null && "errorFields" in error)) message.error((error as Error).message);
    } finally { creatingRef.current = false; if (mounted.current) setCreating(false); }
  };

  const columns: ColumnsType<ProjectRow> = [
    { title: "项目", dataIndex: "name", width: 220, sortOrder: orderFor("name"), sorter: (a, b) => a.name.localeCompare(b.name, "zh-CN"), render: (v: string, r) => <Link href={documentHref("npd", r.id)!} onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); openDetail(r.id); } }}>{v}</Link> },
    { title: "目标 SKU", dataIndex: "skuCode", width: 130, render: (v: string | null) => v ?? "—" },
    { title: "品牌", dataIndex: "brand", width: 110, render: (v: string | null) => v ?? "—" },
    { title: "启动日", dataIndex: "startDate", width: 110, sortOrder: orderFor("startDate"), sorter: (a, b) => a.startDate.localeCompare(b.startDate) },
    { title: "计划完成", dataIndex: "planEnd", width: 110, sortOrder: orderFor("planEnd"), sorter: (a, b) => (a.planEnd ?? "").localeCompare(b.planEnd ?? ""), render: (v: string | null) => v ?? "—" },
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

  const projectSummary = useMemo(() => {
    const active = rows.filter((row) => row.status === "active");
    const taskTotal = active.reduce((sum, row) => sum + row.taskTotal, 0);
    const taskDone = active.reduce((sum, row) => sum + row.taskDone, 0);
    const overdueTasks = active.reduce((sum, row) => sum + row.overdueTasks, 0);
    return {
      active,
      taskTotal,
      taskDone,
      overdueTasks,
      progress: taskTotal > 0 ? Math.round((taskDone / taskTotal) * 100) : null,
    };
  }, [rows]);

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="D19 · 1.x：新建项目按「各节点核心说明」节点标准实例化，计划沿上一节点链推算（自然日）。节点标准/角色分配见本页「节点模板」页签。"
      />
      <ListToolbar state={listState}
        extra={<><Input.Search aria-label="搜索项目 / SKU / 品牌" placeholder="搜索项目 / SKU / 品牌" value={searchText}
          onChange={event => setSearchText(event.target.value)} onSearch={value => listState.setFilter({ q: value.trim() })}
          allowClear style={{ width: 280, maxWidth: "100%" }} />
          <Select aria-label="项目状态" value={status} onChange={value => listState.setFilter({ status: value })}
          style={{ width: 130 }} options={[{ value: "", label: "全部状态" }, ...Object.entries(STATUS_TAG).map(([value, meta]) => ({ value, label: meta.label }))]} /></>}
        primaryActions={<>
          <Button icon={<ReloadOutlined />} onClick={listRead.retry}>刷新项目</Button>
          {canWrite ? <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建 NPD 项目</Button> : null}
        </>}
      />
      <DecisionVisual
        title="新品项目组合进度"
        question="哪些在研项目已落后计划，哪些节点需要本周优先解除阻塞？"
        metricId="npdProgress"
        grain="项目 / 节点任务"
        unit="项目、任务、%"
        source={{ tier: "ledger", source: "NPD 项目与实例化节点任务" }}
        coverage={listRead.data ? {
          covered: projectSummary.active.filter((row) => row.taskTotal > 0).length,
          total: projectSummary.active.length,
          label: "当前筛选进行中项目含节点计划",
        } : undefined}
        summary={listRead.data ? `当前筛选：进行中 ${projectSummary.active.length} 个项目，已完成 ${projectSummary.taskDone}/${projectSummary.taskTotal} 个节点${projectSummary.progress == null ? "" : `，组合进度 ${projectSummary.progress}%`}；逾期节点 ${projectSummary.overdueTasks} 个。` : "项目事实尚不可用，不推断项目或节点为零。"}
        caveat="当前只有项目计划与节点完成事实；缺少上市后销量、毛利、退货和复盘标签，不能据此评价新品商业成功率。"
        state={listRead.error ? "error" : loading ? "loading" : rows.length === 0 ? "empty" : projectSummary.taskTotal === 0 ? "insufficient" : "ready"}
        stateDetail={listRead.error ? <Space direction="vertical"><span>{listRead.error}</span><Button onClick={listRead.retry}>重试项目</Button></Space> : rows.length === 0
          ? q || status ? "当前筛选没有匹配项目，请调整搜索或状态。" : "尚无 NPD 项目；新建项目后将自动实例化节点计划。"
          : projectSummary.taskTotal === 0
            ? "现有进行中项目尚未实例化节点计划，无法形成组合进度。"
            : undefined}
        height={Math.max(220, Math.min(420, projectSummary.active.length * 58 + 30))}
        fitContent
        dataView={listRead.data ?
          <Table<ProjectRow>
            rowKey="id"
            size={listState.tableSize}
            columns={columns}
            dataSource={rows}
            loading={loading}
            pagination={{ current: listState.page, pageSize: listState.pageSize, total: rows.length, onChange: listState.setPage }}
            onChange={(_page, _filters, sorter, extra) => {
              if (extra.action !== "sort") return;
              const selected = Array.isArray(sorter) ? sorter[0] : sorter;
              listState.setFilter({ sortBy: selected.order ? String(selected.field) : "", sortOrder: selected.order === "ascend" ? "asc" : selected.order === "descend" ? "desc" : "" });
            }}
            scroll={{ x: "max-content" }}
          /> : undefined
        }
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          {projectSummary.active.map((project) => {
            const percent = project.taskTotal > 0
              ? Math.round((project.taskDone / project.taskTotal) * 100)
              : 0;
            return (
              <div key={project.id}>
                <Space style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }} wrap>
                  <Button
                    type="link"
                    size="small"
                    style={{ padding: 0, height: "auto", fontWeight: 600 }}
                    onClick={() => void openDetail(project.id)}
                  >
                    {project.name}
                  </Button>
                  <Space size={4}>
                    {project.planEnd ? <Tag bordered={false}>计划 {project.planEnd}</Tag> : null}
                    {project.overdueTasks > 0 ? <Tag color="error">逾期 {project.overdueTasks}</Tag> : null}
                  </Space>
                </Space>
                <Progress
                  percent={percent}
                  status={project.overdueTasks > 0 ? "exception" : "active"}
                  format={() => `${project.taskDone}/${project.taskTotal}`}
                  aria-label={`${project.name}进度 ${percent}%，逾期节点 ${project.overdueTasks} 个`}
                />
              </div>
            );
          })}
        </Space>
      </DecisionVisual>

      {evidenceRead.error ? <Alert type="warning" showIcon message="外部佐证暂不可用；不影响项目事实"
        description={evidenceRead.error} action={<Button onClick={evidenceRead.retry}>重试佐证</Button>} style={{ marginTop: 12 }} />
        : evidenceRead.phase === "loading" ? <div role="status" style={{ marginTop: 12 }}>外部佐证正在独立加载，项目可继续查看。</div>
        : evidenceRead.data ? <div style={{ marginTop: 12 }}>
          <LaunchExternalEvidence observations={evidenceRead.data.supportingObservations} />
          <ProductExternalDecisionEvidenceCard evidence={evidenceRead.data.externalDecisionEvidence} />
        </div> : null}
      {selection.present ? <NpdProjectDetail key={selection.id ?? "invalid"} id={selection.id} linkError={selection.error}
        canWrite={canWrite} onClose={() => selection.setId(null)} onChanged={listRead.retry} /> : null}

      <Modal
        title="新建 NPD 项目（按当前节点模板实例化）"
        open={createOpen && canWrite}
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
          <Space style={{ display: "flex" }} align="start" wrap>
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

    </div>
  );
}

/** Remounting by identity isolates drafts, confirmations and mutation completions from another project. */
function NpdProjectDetail({ id, linkError, canWrite, onClose, onChanged }: {
  id: number | null; linkError: string | null; canWrite: boolean; onClose: () => void; onChanged: () => void;
}) {
  const { message } = App.useApp();
  const read = useDocumentRead<ProjectDetail>(id == null ? null : `/api/npd/projects?id=${id}`);
  const detail = read.data;
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [firstOrderOpen, setFirstOrderOpen] = useState(false);
  const [firstOrderQty, setFirstOrderQty] = useState<string | null>(null);
  const [skuDraft, setSkuDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<{ id: number; docNo: string } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (read.phase !== "success") setFirstOrderOpen(false); }, [read.phase]);
  const run = async (action: () => Promise<void>) => {
    if (!canWrite || !detail || inFlight.current) return;
    inFlight.current = true; setBusy(true); setActionError(null);
    try { await action(); }
    catch (error) { if (mounted.current) setActionError((error as Error).message); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const changed = () => { onChanged(); if (mounted.current) read.retry(); };
  const setTask = (taskId: number, status: string) => run(async () => {
    await patchJson("/api/npd/tasks", { taskId, status });
    if (mounted.current) message.success("节点状态已更新");
    changed();
  });
  const saveSku = () => run(async () => {
    const code = skuDraft.trim();
    if (!code) throw Error("请填写目标 SKU 编码");
    await patchJson("/api/npd/projects", { intent: "set_sku", projectId: id, skuCode: code });
    if (mounted.current) { message.success("目标 SKU 已补录"); setSkuDraft(""); } changed();
  });
  const reschedule = () => run(async () => {
    const result = await patchJson<{ changed: number; planEnd: string }>("/api/npd/projects", { intent: "reschedule", projectId: id });
    if (mounted.current) message.success(`计划已重排：${result.changed} 个任务顺延，计划完成 ${result.planEnd}`);
    changed();
  });
  const setProject = (status: string) => run(async () => {
    await patchJson("/api/npd/projects", { projectId: id, status });
    if (mounted.current) message.success("项目状态已更新");
    changed();
  });
  const submitFirstOrder = () => run(async () => {
    if (!firstOrderQty || !/^\d+(\.\d{1,4})?$/.test(firstOrderQty) || Number(firstOrderQty) <= 0) throw Error("请填写大于 0、最多四位小数的数量");
    const result = await postJson<{ id: number; docNo: string }>("/api/npd/projects", { intent: "first_order", projectId: id, qty: firstOrderQty });
    if (mounted.current) { setGenerated(result); setFirstOrderOpen(false); setFirstOrderQty(null); message.success(`首单备货草稿已生成：${result.docNo}`); }
  });
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
            disabled={!canWrite || busy}
            aria-label={`节点 ${r.name} 状态`}
            onChange={(nv) => void setTask(r.id, nv)}
            options={Object.entries(TASK_STATUS).map(([val, m]) => ({ value: val, label: m.label }))}
          />
          {r.doneAt ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.doneAt}</Typography.Text> : null}
        </Space>
      ),
    },
  ];


  return <>
      <DocumentDrawer
        title={detail ? `${detail.project.name}（${detail.tasks.filter((t) => t.status === "done" || t.status === "skipped").length}/${detail.tasks.length}）` : id == null ? "项目链接无效" : `项目 #${id}`}
        open
        onClose={onClose}
        loading={read.phase === "loading"}
        readError={linkError ?? read.error}
        onRetry={id == null ? undefined : read.retry}
        width="min(1080px, 100vw)"
        extra={
          detail && canWrite && detail.project.status === "active" ? (
            <Space>
              <Button loading={busy} onClick={() => void reschedule()}>
                重排计划
              </Button>
              {detail.project.skuCode ? (
                <Button disabled={busy || generated != null} onClick={() => { setFirstOrderQty(null); setFirstOrderOpen(true); }}>
                  {ACTION.createBhDraft}
                </Button>
              ) : null}
              <Popconfirm title="确认整项目完成？" disabled={busy} onConfirm={() => void setProject("done")}>
                <Button type="primary" disabled={busy}>标记完成</Button>
              </Popconfirm>
              <Popconfirm title="确认取消项目？（任务保留，仅状态标记）" disabled={busy} onConfirm={() => void setProject("cancelled")}>
                <Button danger disabled={busy}>取消项目</Button>
              </Popconfirm>
            </Space>
          ) : null
        }
      >
        {!canWrite && detail ? <Alert type="info" showIcon message="只读查看；节点推进与首单操作由运营或计划角色处理。" style={{ marginBottom: 12 }} /> : null}
        {generated ? <Alert type="success" showIcon message={`首单草稿已生成：${generated.docNo}`}
          description={<Link href={documentHref("bh", generated.id)!}>打开备货草稿并核对 / 提交审批</Link>} style={{ marginBottom: 12 }} /> : null}
        {actionError ? <Alert type="error" showIcon message="操作未完成或结果未确认" description={actionError}
          action={<Button onClick={read.retry}>核对项目</Button>} style={{ marginBottom: 12 }} /> : null}
        {detail && canWrite && detail.project.status === "active" && !detail.project.skuCode ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 8 }}
            message="目标 SKU 尚未设置——补录后方可生成新品首单 BH"
            description={
              <Space.Compact style={{ marginTop: 4, width: "100%" }}>
                <Input
                  placeholder="目标 SKU 编码或别名，如 N024-000"
                  value={skuDraft}
                  maxLength={60}
                  style={{ width: "100%", minWidth: 0 }}
                  onChange={(e) => setSkuDraft(e.target.value)}
                  onPressEnter={() => void saveSku()}
                />
                <Button type="primary" loading={busy} onClick={() => void saveSku()}>
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
        <div className={styles.desktopTasks}><Table<TaskRow>
          rowKey="id"
          size="small"
          columns={taskCols}
          dataSource={(detail?.tasks ?? []).filter((t) => !stageFilter || t.stage === stageFilter)}
          loading={read.phase === "loading"}
          pagination={false}
          scroll={{ x: "max-content" }}
          rowClassName={(r) => (r.overdue ? "npd-overdue-row" : "")}
        /></div>
        <div className={styles.mobileTasks} aria-label="项目节点紧凑列表">
          {(detail?.tasks ?? []).filter(task => !stageFilter || task.stage === stageFilter).map(task => <section key={task.id} className={styles.task}>
            <div className={styles.taskHeading}><strong>{task.seq}. {task.name}</strong>{task.overdue ? <Tag color="red">逾期</Tag> : null}</div>
            <Typography.Text type="secondary">{[task.nodeNo, task.stage, task.dept].filter(Boolean).join(" · ") || "阶段/责任部门未提供"}</Typography.Text>
            <div className={styles.taskMeta}><span>{task.planStart ?? "未排期"} → {task.planEnd ?? "未排期"}</span><span>{task.days} 天</span></div>
            <div className={styles.taskMeta}>
              <Select size="small" aria-label={`节点 ${task.name} 状态`} value={task.status} disabled={!canWrite || busy}
                style={{ width: 110 }} onChange={value => void setTask(task.id, value)}
                options={Object.entries(TASK_STATUS).map(([value, meta]) => ({ value, label: meta.label }))} />
              {task.doneAt ? <Typography.Text type="secondary">完成 {task.doneAt}</Typography.Text> : null}
            </div>
          </section>)}
          {detail && !detail.tasks.some(task => !stageFilter || task.stage === stageFilter) ? <Typography.Text type="secondary">当前阶段没有节点。</Typography.Text> : null}
        </div>
        <style dangerouslySetInnerHTML={{ __html: ".npd-overdue-row > td { background: #fff1f0; }" }} />
      </DocumentDrawer>
      <Modal
        title={`生成首单备货草稿 · ${detail?.project.skuCode ?? ""}`}
        open={firstOrderOpen && canWrite}
        onOk={() => void submitFirstOrder()}
        onCancel={() => setFirstOrderOpen(false)}
        confirmLoading={busy}
        okText="生成草稿"
        cancelText="取消"
        width={460}
      >
        {actionError ? <Alert type="error" showIcon message={actionError} style={{ marginBottom: 12 }} /> : null}
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message={ACTION.createBhDraftHint} />
        <Form layout="vertical">
          <Form.Item label={`首单数量（${detail?.project.skuCode ?? ""}，基础单位）`} required>
            <InputNumber
              autoFocus
              stringMode
              min="0.0001"
              style={{ width: "100%" }}
              value={firstOrderQty}
              onChange={value => setFirstOrderQty(value)}
              placeholder="请输入数量"
            />
          </Form.Item>
        </Form>
      </Modal>
  </>;
}
