"use client";

/**
 * D61 供应链目标：按部门（=角色）Tab；本部门可编辑，其他部门只读；admin 全部可编辑。
 * 自动取值指标从已登记读模型取；取不到显示「来源未就绪」，不编造。
 * 指标下拉列出指标注册表（components/metrics）全部指标，按「自动取值 / 手工填报」分组并带一句话说明。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  App, Button, Col, DatePicker, Drawer, Form, InputNumber, Input, Row, Segmented, Select, Space, Table, Tabs, Tag, Tooltip, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { InfoCircleOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { fetchJson, patchJson, postJson } from "@/components/fetchJson";
import CaliberNote from "@/components/CaliberNote";
import { GOAL_SOURCE, goalSourceKey, roleLabel } from "@/components/dictionary";
import { exportCsv } from "@/components/exportCsv";
import { formatMetricValue } from "@/components/format";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { METRICS, metricTooltip } from "@/components/metrics";
import { useListState } from "@/components/useListState";
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
  const [data, setData] = useState<GoalsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ mode: "create"; dept: string } | { mode: "edit"; row: GoalRow } | null>(null);
  const [form] = Form.useForm();
  // 单调计数：每次写入后 +1，进度卡据此重取（行数不变的编辑也要刷新——审计 #11）
  const [tick, setTick] = useState(0);
  const [periodKind, setPeriodKind] = useState<PeriodKind>("month");
  const listState = useListState<Filters>({ key: "goals", defaults: { period: "", dept: "" }, paginated: false, paramPrefix: "g" });
  const { filters } = listState;

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.period) params.set("period", filters.period);
      if (refresh) await fetchJson("/api/goals/refresh", { method: "POST", body: JSON.stringify({}) });
      setData(await fetchJson<GoalsData>(`/api/goals?${params.toString()}`));
      if (refresh) setTick((t) => t + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters.period]);
  useEffect(() => { void load(); }, [load]);

  const deptKeys = useMemo(() => data?.deptKeys ?? [], [data?.deptKeys]);
  const activeDept = filters.dept && deptKeys.includes(filters.dept) ? filters.dept : (deptKeys[0] ?? "");
  const editable = !!data?.editableDepts.includes(activeDept);
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

  const submit = async () => {
    const v = await form.validateFields();
    try {
      if (drawer?.mode === "create") {
        const period = dayjsToPeriod(v.periodKind ?? "month", v.periodDate ?? null);
        if (!period) { message.error("期间必填"); return; }
        await postJson("/api/goals", { period, metricKey: v.metricKey, direction: v.direction, note: v.note, deptKey: drawer.dept, targetValue: String(v.targetValue) });
        message.success("已创建目标");
      } else if (drawer?.mode === "edit") {
        await patchJson(`/api/goals/${drawer.row.id}`, {
          targetValue: v.targetValue != null ? String(v.targetValue) : undefined,
          direction: v.direction,
          note: v.note,
          actualValue: v.actualValue != null && v.actualValue !== "" ? String(v.actualValue) : undefined,
          evidence: v.evidence,
        });
        message.success("已更新");
      }
      setDrawer(null);
      form.resetFields();
      setTick((t) => t + 1);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const columns: ColumnsType<GoalRow> = [
    { title: "期间", dataIndex: "period", width: 90, fixed: "left", sorter: (a, b) => a.period.localeCompare(b.period) },
    {
      title: "指标", dataIndex: "metricLabel", width: 200,
      render: (v: string, r) => (
        <Space size={4}>
          <span>{v}</span>
          <Tooltip title={metricTooltip(r.metricKey) || r.metricKey}><InfoCircleOutlined style={{ color: "#8c8c8c" }} /></Tooltip>
        </Space>
      ),
    },
    { title: "目标", dataIndex: "targetValue", width: 110, align: "right", render: (v: string, r) => formatMetricValue(v, r.unit) },
    { title: "实际", dataIndex: "actualValue", width: 110, align: "right", render: (v: string | null, r) => (v == null ? (r.autoStatus === "withheld" ? "无权限" : "—") : formatMetricValue(v, r.unit)) },
    { title: "达成", key: "attain", width: 150, sorter: (a, b) => Number(a.attainment ?? -1) - Number(b.attainment ?? -1), render: (_, r) => attainTag(r) },
    { title: "方向", dataIndex: "direction", width: 100, render: (v: string) => (v === "up" ? "↑ 越高越好" : "↓ 越低越好") },
    { title: "来源", key: "src", width: 130, render: (_, r) => { const k = goalSourceKey(r.actualSource, r.autoStatus); return <Tag color={GOAL_SOURCE[k].color}>{GOAL_SOURCE[k].label}</Tag>; } },
    { title: "备注 / 证据", dataIndex: "note", ellipsis: true, render: (v: string | null) => v ?? "—" },
    {
      title: "操作", key: "ops", width: 90, fixed: "right",
      render: (_, r) => (r.editable ? (
        <Button size="small" onClick={() => {
          form.setFieldsValue({ targetValue: Number(r.targetValue), direction: r.direction, note: r.note ?? "", actualValue: undefined, evidence: "" });
          setDrawer({ mode: "edit", row: r });
        }}>编辑</Button>
      ) : <Typography.Text type="secondary">只读</Typography.Text>),
    },
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
          <Space>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load(true)}>回填自动实际值</Button>
            <Button type="primary" icon={<PlusOutlined />} disabled={!editable} onClick={() => {
              form.resetFields();
              form.setFieldsValue({ periodKind: "month", direction: "up" });
              setDrawer({ mode: "create", dept: activeDept });
            }}>设置目标</Button>
          </Space>
        </Col>
      </Row>
      <CaliberNote
        summary="部门 = 角色（D61）；本部门可编辑，其他部门只读，管理员全部可编辑。"
        detail={<div>自动取值指标（库存占比 / 库存周转 / DIO / 账期达成率 / OTIF 等）从已登记读模型缓存取值，取不到留空不编造；手工填报实际值必须附证据说明并留审计。达成度：越高越好 = 实际 ÷ 目标，越低越好 = 目标 ÷ 实际。</div>}
      />
      <LoadErrorAlert error={error} onRetry={() => void load()} subject="供应链目标" retrying={loading} />
      <GoalProgressCard refreshKey={tick} />
      <ListToolbar
        state={listState}
        onExport={data ? onExport : undefined}
        extra={(
          <Space wrap>
            <Segmented size="small" value={filterPeriod?.kind ?? periodKind} options={[{ value: "month", label: "月" }, { value: "quarter", label: "季" }]} onChange={(v) => { setPeriodKind(v as PeriodKind); listState.setFilter({ period: "" }); }} />
            <DatePicker
              size="small"
              allowClear
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
        scroll={{ x: "max-content" }}
        pagination={false}
        locale={{ emptyText: error ? "数据未加载" : "本部门在该期间尚未设置目标" }}
      />
      <Drawer
        title={drawer?.mode === "create" ? `设置目标 · ${roleLabel(drawer.dept)}` : drawer?.mode === "edit" ? `编辑 · ${drawer.row.metricLabel} ${drawer.row.period}` : ""}
        open={!!drawer}
        onClose={() => setDrawer(null)}
        width={520}
        extra={<Button type="primary" onClick={submit}>保存</Button>}
      >
        <Form form={form} layout="vertical" initialValues={{ direction: "up", periodKind: "month" }}>
          {drawer?.mode === "create" ? (
            <>
              <Form.Item label="期间" required>
                <Space>
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
            <InputNumber style={{ width: "100%" }} precision={4} />
          </Form.Item>
          <Form.Item name="direction" label="方向"><Select options={[{ value: "up", label: "↑ 越高越好" }, { value: "down", label: "↓ 越低越好" }]} /></Form.Item>
          <Form.Item name="note" label="备注"><Input.TextArea rows={2} maxLength={500} /></Form.Item>
          {drawer?.mode === "edit" ? (
            <>
              <Form.Item name="actualValue" label="手工填报实际值（可选）"><InputNumber style={{ width: "100%" }} precision={4} /></Form.Item>
              <Form.Item name="evidence" label="证据说明（填报实际值时必填）"><Input.TextArea rows={2} maxLength={500} /></Form.Item>
            </>
          ) : null}
        </Form>
      </Drawer>
    </div>
  );
}
