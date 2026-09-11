"use client";

/**
 * D61 供应链目标：按部门（=角色）Tab；本部门可编辑，其他部门只读；admin 全部可编辑。
 * 自动取值指标从已登记读模型取；取不到显示「来源未就绪」，不编造。
 * 指标下拉列出指标注册表（components/metrics）全部指标，按「自动取值 / 手工填报」分组并带一句话说明。
 */
import { useMemo, useRef, useState } from "react";
import {
  Alert, App, Button, Col, DatePicker, Drawer, Form, Grid, InputNumber, Input, Popconfirm, Row, Segmented, Select, Space, Table, Tabs, Tag, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { patchJson, postJson } from "@/components/fetchJson";
import CaliberNote from "@/components/CaliberNote";
import ContextHelp from "@/components/ContextHelp";
import { GOAL_SOURCE, goalSourceKey, roleLabel } from "@/components/dictionary";
import { exportCsv } from "@/components/exportCsv";
import { formatMetricValue } from "@/components/format";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { METRICS, metricTooltip } from "@/components/metrics";
import { useListState } from "@/components/useListState";
import { useDocumentRead } from "@/components/useDocumentRead";
import GoalProgressCard from "./GoalProgressCard";

interface GoalRow {
  id: number;
  deptKey: string;
  period: string;
  metricKey: string;
  metricLabel: string;
  unit: string | null;
  targetValue: string;
  direction: "up" | "down";
  actualValue: string | null;
  actualSource: "auto" | "manual" | null;
  autoStatus: "ok" | "unavailable" | "withheld" | "n/a";
  valueWithheld?: boolean;
  attainment: string | null;
  attained: boolean | null;
  note: string | null;
  editable: boolean;
  updatedAt: string;
}

interface GoalsData {
  rows: GoalRow[];
  deptKeys: string[];
  editableDepts: string[];
  autoMetrics: { metricKey: string; label: string; defaultDirection: "up" | "down" }[];
}

/** 期间字符串 ↔ DatePicker：YYYY-MM 为月，YYYY-Qn 为季 */
type PeriodKind = "month" | "quarter";
function periodToDayjs(p: string): { kind: PeriodKind; value: Dayjs } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(p);
  if (m) return { kind: "month", value: dayjs(`${m[1]}-${m[2]}-01`) };
  const q = /^(\d{4})-Q([1-4])$/.exec(p);
  if (q) return { kind: "quarter", value: dayjs(`${q[1]}-${String((Number(q[2]) - 1) * 3 + 1).padStart(2, "0")}-01`) };
  return null;
}
export function dayjsToPeriod(kind: PeriodKind, v: Dayjs | null): string {
  if (!v) return "";
  return kind === "month" ? v.format("YYYY-MM") : `${v.year()}-Q${Math.floor(v.month() / 3) + 1}`;
}

function attainTag(r: GoalRow) {
  if (r.autoStatus === "withheld") return <Tag>金额·无权限</Tag>;
  if (r.actualValue == null) return <Tag>{r.autoStatus === "unavailable" ? "来源未就绪" : "待填报"}</Tag>;
  return <Tag color={r.attained ? "green" : "red"}>{r.attained ? "已达成" : "未达成"} {r.attainment != null ? `${r.attainment}%` : ""}</Tag>;
}

type Filters = { period?: string; dept?: string };

export default function GoalsClient() {
  const { message } = App.useApp();
  const compact = !Grid.useBreakpoint().md;
  const [writing, setWriting] = useState<"refresh" | "save" | null>(null);
  const writeLock = useRef(false);
  const [writeResult, setWriteResult] = useState<{ type: "success" | "warning"; message: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ mode: "create"; dept: string } | { mode: "edit"; row: GoalRow } | null>(null);
  const [form] = Form.useForm();
  // 单调计数：每次写入后 +1，进度卡据此重取（行数不变的编辑也要刷新——审计 #11）
  const [tick, setTick] = useState(0);
  const [periodKind, setPeriodKind] = useState<PeriodKind>("month");
  const listState = useListState<Filters>({ key: "goals", defaults: { period: "", dept: "" }, paginated: false, paramPrefix: "g" });
  const { filters } = listState;

  const params = new URLSearchParams({ refresh: String(tick) });
  if (filters.period) params.set("period", filters.period);
  const { data, error, phase, retry } = useDocumentRead<GoalsData>(`/api/goals?${params}`);
  const loading = phase === "loading";

  const deptKeys = useMemo(() => data?.deptKeys ?? [], [data?.deptKeys]);
  const activeDept = filters.dept && deptKeys.includes(filters.dept) ? filters.dept : (deptKeys[0] ?? "");
  const editable = !!data?.editableDepts.includes(activeDept);
  const canRefresh = !!data?.editableDepts.length && !writing;
  const refreshScope = filters.period || "全部期间";
  const autoKeys = useMemo(() => new Set((data?.autoMetrics ?? []).map((m) => m.metricKey)), [data?.autoMetrics]);

  const metricOptions = useMemo(() => {
    const auto = (data?.autoMetrics ?? []).map((m) => ({ value: m.metricKey, label: m.label, desc: METRICS[m.metricKey]?.short ?? "" }));
    const manual = Object.values(METRICS)
      .filter((m) => !autoKeys.has(m.id))
      .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"))
      .map((m) => ({ value: m.id, label: m.label, desc: m.short }));
    return [
      { label: `自动取值（从读模型回填，${auto.length} 项）`, options: auto },
      { label: `手工填报（${manual.length} 项，需附证据）`, options: manual },
    ];
  }, [data?.autoMetrics, autoKeys]);

  const refreshActuals = async () => {
    if (writeLock.current || !canRefresh) return;
    writeLock.current = true;
    setWriting("refresh"); setWriteResult(null);
    try {
      const result = await postJson<{ scanned: number; updated: number; unavailable: number }>("/api/goals/refresh", filters.period ? { period: filters.period } : {});
      if (!result || ![result.scanned, result.updated, result.unavailable].every(v => Number.isInteger(v) && v >= 0)) {
        throw new Error("未收到有效回填回执，请先重新读取核对结果，勿重复提交");
      }
      setWriteResult({ type: "success", message: `${refreshScope}回填已完成：检查 ${result.scanned} 项，更新 ${result.updated} 项，来源未就绪 ${result.unavailable} 项。` });
    } catch (e) {
      setWriteResult({ type: "warning", message: `${refreshScope}回填未确认完成：${(e as Error).message}。请先重新读取核对，勿直接再次回填。` });
    } finally {
      // The write may have succeeded (or partially completed) even when its response was lost.
      // Invalidating GETs never retries the mutation; its receipt remains visible if reading fails.
      setTick(t => t + 1); setWriting(null); writeLock.current = false;
    }
  };

  const submit = async () => {
    if (writeLock.current || !drawer) return;
    writeLock.current = true; setWriting("save"); setSaveError(null);
    let submitted = false;
    try {
      const v = await form.validateFields();
      if (drawer?.mode === "create") {
        const period = dayjsToPeriod(v.periodKind ?? "month", v.periodDate ?? null);
        if (!period) { message.error("期间必填"); return; }
        submitted = true;
        await postJson("/api/goals", { period, metricKey: v.metricKey, direction: v.direction, note: v.note, deptKey: drawer.dept, targetValue: String(v.targetValue) });
        message.success("已创建目标");
      } else if (drawer?.mode === "edit") {
        const patch: Record<string, unknown> = { expectedUpdatedAt: drawer.row.updatedAt };
        if (v.targetValue != null && String(v.targetValue) !== drawer.row.targetValue) patch.targetValue = String(v.targetValue);
        if (v.direction !== drawer.row.direction) patch.direction = v.direction;
        if ((v.note ?? "").trim() !== (drawer.row.note ?? "").trim()) patch.note = v.note?.trim() || null;
        if (v.actualValue != null && v.actualValue !== "") {
          patch.actualValue = String(v.actualValue); patch.evidence = v.evidence;
        }
        if (Object.keys(patch).length === 1) { message.info("未修改任何内容"); return; }
        submitted = true;
        await patchJson(`/api/goals/${drawer.row.id}`, patch);
        message.success("已更新");
      }
      setDrawer(null);
      form.resetFields();
      setWriteResult({ type: "success", message: "目标已保存；正在重新读取最新列表与摘要。" });
    } catch (e) {
      // Form validation already renders field-level errors; do not turn it into an unhandled rejection.
      if (submitted) {
        message.error((e as Error).message);
        setSaveError((e as Error).message);
        setWriteResult({ type: "warning", message: `保存未确认完成：${(e as Error).message}。请先重新读取核对结果。` });
      }
    } finally {
      if (submitted) setTick(t => t + 1);
      setWriting(null); writeLock.current = false;
    }
  };

  const editAction = (r: GoalRow) => r.editable ? (
    <Button size="small" disabled={!!writing} onClick={() => {
      setSaveError(null);
      form.setFieldsValue({ targetValue: r.targetValue, direction: r.direction, note: r.note ?? "", actualValue: undefined, evidence: "" });
      setDrawer({ mode: "edit", row: r });
    }}>编辑</Button>
  ) : <Typography.Text type="secondary">只读</Typography.Text>;

  const columns: ColumnsType<GoalRow> = [
    ...(!compact ? [{ title: "期间", dataIndex: "period", width: 90, fixed: "left" as const, sorter: (a: GoalRow, b: GoalRow) => a.period.localeCompare(b.period) }] : []),
    {
      title: compact ? "期间 / 指标" : "指标", dataIndex: "metricLabel", width: compact ? 160 : 200, fixed: compact ? "left" : undefined,
      sorter: compact ? (a, b) => a.period.localeCompare(b.period) || a.metricLabel.localeCompare(b.metricLabel, "zh-CN") : undefined,
      render: (v: string, r) => (
        <div style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
          {compact && <Typography.Text type="secondary">{r.period}</Typography.Text>}
          <div><span>{v}</span> <ContextHelp label={`查看${v}说明`} title={v} content={metricTooltip(r.metricKey) || r.metricKey} /></div>
          {compact && <div style={{ marginTop: 6 }}>{editAction(r)}</div>}
        </div>
      ),
    },
    { title: "目标", dataIndex: "targetValue", width: 110, align: "right", render: (v: string, r) => formatMetricValue(v, r.unit) },
    { title: "实际", dataIndex: "actualValue", width: 110, align: "right", render: (v: string | null, r) => (v == null ? (r.autoStatus === "withheld" ? "无权限" : "—") : formatMetricValue(v, r.unit)) },
    { title: "达成", key: "attain", width: 150, sorter: (a, b) => Number(a.attainment ?? -1) - Number(b.attainment ?? -1), render: (_, r) => attainTag(r) },
    { title: "方向", dataIndex: "direction", width: 100, render: (v: string) => (v === "up" ? "↑ 越高越好" : "↓ 越低越好") },
    { title: "来源", key: "src", width: 130, render: (_, r) => { const k = goalSourceKey(r.actualSource, r.autoStatus); return <Tag color={GOAL_SOURCE[k].color}>{GOAL_SOURCE[k].label}</Tag>; } },
    { title: "备注 / 证据", dataIndex: "note", ellipsis: true, render: (v: string | null) => v ?? "—" },
    ...(!compact ? [{ title: "操作", key: "ops", width: 90, fixed: "right" as const, render: (_: unknown, r: GoalRow) => editAction(r) }] : []),
  ];

  const tabs = useMemo(() => deptKeys.map((d) => ({
    key: d,
    label: `${roleLabel(d)}${data?.editableDepts.includes(d) ? "" : "（只读）"}`,
  })), [deptKeys, data?.editableDepts]);

  const rows = (data?.rows ?? []).filter((r) => r.deptKey === activeDept);
  const filterPeriod = filters.period ? periodToDayjs(filters.period) : null;

  const onExport = () => {
    exportCsv(
      `供应链目标-${roleLabel(activeDept)}-${filters.period || "全部期间"}`,
      ["部门", "期间", "指标", "指标键", "目标", "实际", "单位", "达成", "达成度%", "方向", "来源", "备注"],
      rows.map((r) => [roleLabel(r.deptKey), r.period, r.metricLabel, r.metricKey, r.targetValue, r.actualValue, r.unit, r.attained == null ? "" : r.attained ? "已达成" : "未达成", r.attainment, r.direction === "up" ? "越高越好" : "越低越好", GOAL_SOURCE[goalSourceKey(r.actualSource, r.autoStatus)].label, r.note]),
    );
  };

  return (
    <div>
      <Row justify="space-between" align="middle" style={{ marginBottom: 8 }}>
        <Col><Typography.Title level={4} style={{ margin: 0 }}>供应链目标</Typography.Title></Col>
        <Col>
          <Space wrap>
            <Popconfirm title="确认回填自动实际值？" description={`${refreshScope} · 所有可编辑部门（不限当前页签）；不覆盖手工值，来源失效时撤下旧自动值。`}
              onConfirm={refreshActuals} okText="确认回填" cancelText="取消" disabled={!canRefresh}>
              <Button icon={<ReloadOutlined />} loading={writing === "refresh"} disabled={!canRefresh}>回填自动实际值</Button>
            </Popconfirm>
            <Button type="primary" icon={<PlusOutlined />} disabled={!editable || !!writing} onClick={() => {
              setSaveError(null);
              form.resetFields();
              form.setFieldsValue({ periodKind: filterPeriod?.kind ?? periodKind, periodDate: filterPeriod?.value, direction: "up" });
              setDrawer({ mode: "create", dept: activeDept });
            }}>设置目标</Button>
          </Space>
        </Col>
      </Row>
      <CaliberNote
        summary="部门 = 角色（D61）；本部门可编辑，其他部门只读，管理员全部可编辑。"
        detail={<div>自动取值指标（库存占比 / 库存周转 / DIO / 账期达成率 / OTIF 等）从已登记读模型缓存取值，取不到留空不编造；手工填报实际值必须附证据说明并留审计。达成度：越高越好 = 实际 ÷ 目标，越低越好 = 目标 ÷ 实际。</div>}
      />
      {writeResult && <Alert type={writeResult.type} message={writeResult.message} showIcon style={{ marginBottom: 12 }} />}
      <LoadErrorAlert error={error} onRetry={retry} subject="供应链目标" retrying={loading} />
      <GoalProgressCard refreshKey={tick} />
      <ListToolbar
        state={listState}
        onExport={data && !writing ? onExport : undefined}
        primaryActions={<Button size="small" loading={loading} disabled={!!writing} onClick={retry}>重新读取</Button>}
        extra={(
          <Space wrap>
            <Segmented size="small" disabled={!!writing} value={filterPeriod?.kind ?? periodKind} options={[{ value: "month", label: "月" }, { value: "quarter", label: "季" }]} onChange={(v) => { setPeriodKind(v as PeriodKind); listState.setFilter({ period: "" }); }} />
            <DatePicker
              size="small"
              allowClear
              disabled={!!writing}
              picker={filterPeriod?.kind ?? periodKind}
              value={filterPeriod?.value ?? null}
              placeholder={(filterPeriod?.kind ?? periodKind) === "month" ? "期间（月）" : "期间（季）"}
              onChange={(v) => listState.setFilter({ period: dayjsToPeriod(filterPeriod?.kind ?? periodKind, v) })}
            />
          </Space>
        )}
      />
      <Tabs
        activeKey={activeDept}
        onChange={(k) => listState.setFilter({ dept: k })}
        items={tabs.map((t) => ({ ...t, children: null }))}
      />
      <Table<GoalRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: compact ? 1040 : "max-content" }}
        pagination={false}
        locale={{ emptyText: loading ? "正在读取目标…" : error ? "数据未加载" : "本部门在该期间尚未设置目标" }}
      />
      <Drawer
        title={drawer?.mode === "create" ? `设置目标 · ${roleLabel(drawer.dept)}` : drawer?.mode === "edit" ? `编辑 · ${drawer.row.metricLabel} ${drawer.row.period}` : ""}
        open={!!drawer}
        onClose={() => { if (!writeLock.current) setDrawer(null); }}
        closable={!writing}
        maskClosable={!writing}
        keyboard={!writing}
        width={compact ? "100%" : 520}
        extra={<Button type="primary" loading={writing === "save"} disabled={writing === "refresh"} onClick={submit}>保存</Button>}
      >
        {saveError && <Alert type="error" showIcon message="目标未确认保存" description={saveError} style={{ marginBottom: 12 }} />}
        {drawer?.mode === "edit" && <Typography.Paragraph type="secondary">
          当前实际：{drawer.row.autoStatus === "withheld" ? "无权限" : formatMetricValue(drawer.row.actualValue, drawer.row.unit)} · {GOAL_SOURCE[goalSourceKey(drawer.row.actualSource, drawer.row.autoStatus)].label}。不填新的实际值即保留；填报后转为人工值，不再自动覆盖。
        </Typography.Paragraph>}
        <Form form={form} disabled={!!writing} layout="vertical" initialValues={{ direction: "up", periodKind: "month" }}>
          {drawer?.mode === "create" ? (
            <>
              <Form.Item label="期间" required>
                <Space wrap>
                  <Form.Item name="periodKind" noStyle>
                    <Segmented options={[{ value: "month", label: "月" }, { value: "quarter", label: "季" }]} />
                  </Form.Item>
                  <Form.Item noStyle shouldUpdate={(a, b) => a.periodKind !== b.periodKind}>
                    {({ getFieldValue }) => (
                      <Form.Item name="periodDate" noStyle rules={[{ required: true, message: "期间必选" }]}>
                        <DatePicker picker={getFieldValue("periodKind") === "quarter" ? "quarter" : "month"} />
                      </Form.Item>
                    )}
                  </Form.Item>
                </Space>
              </Form.Item>
              <Form.Item name="metricKey" label="指标" rules={[{ required: true, message: "必选指标" }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  options={metricOptions}
                  listHeight={360}
                  optionRender={(opt) => (
                    <div>
                      <div>{opt.label}</div>
                      <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: "normal" }}>{String((opt.data as { desc?: string }).desc ?? "")}</Typography.Text>
                    </div>
                  )}
                  onChange={(k) => {
                    const m = data?.autoMetrics.find((x) => x.metricKey === k);
                    if (m) form.setFieldValue("direction", m.defaultDirection);
                  }}
                />
              </Form.Item>
            </>
          ) : null}
          <Form.Item name="targetValue" label="目标值" rules={[{ required: drawer?.mode === "create", message: "目标值必填" }]}>
            <InputNumber stringMode style={{ width: "100%" }} precision={4} />
          </Form.Item>
          <Form.Item name="direction" label="方向"><Select options={[{ value: "up", label: "↑ 越高越好" }, { value: "down", label: "↓ 越低越好" }]} /></Form.Item>
          <Form.Item name="note" label="备注"><Input.TextArea rows={2} maxLength={500} /></Form.Item>
          {drawer?.mode === "edit" ? (
            <>
              <Form.Item name="actualValue" label="手工填报实际值（可选）"><InputNumber stringMode style={{ width: "100%" }} precision={4} /></Form.Item>
              <Form.Item name="evidence" label="证据说明（填报实际值时必填）" dependencies={["actualValue"]}
                rules={[({ getFieldValue }) => ({ validator: (_, value) => {
                  const actual = getFieldValue("actualValue");
                  return actual != null && actual !== "" && !String(value ?? "").trim() ? Promise.reject(new Error("请填写实际值的证据说明")) : Promise.resolve();
                } })]}><Input.TextArea rows={2} maxLength={500} /></Form.Item>
            </>
          ) : null}
        </Form>
      </Drawer>
    </div>
  );
}
