"use client";

/**
 * D61 供应链目标：按部门（=角色）Tab；本部门可编辑，其他部门只读；admin 全部可编辑。
 * auto 实际值从已登记读模型取；取不到显示「读模型暂无值」，不编造。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert, App, Button, Col, Drawer, Form, Input, InputNumber, Row, Select, Space, Table, Tabs, Tag, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { fetchJson, patchJson, postJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
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
  autoStatus: "ok" | "unavailable" | "n/a";
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

const ROLE_LABEL: Record<string, string> = {
  ops: "运营", purchasing: "采购", warehouse: "仓管", quality: "质量合规", pmc: "生产计划", finance: "财务", admin: "管理员",
};
const UNIT_SUFFIX: Record<string, string> = { pct: "%", days: "天", qty: "", count: "", money: "元", ratio: "", minutes: "分", hours: "时" };

function attainTag(r: GoalRow) {
  if (r.actualValue == null) return <Tag>{r.autoStatus === "unavailable" ? "读模型暂无值" : "待填报"}</Tag>;
  return <Tag color={r.attained ? "green" : "red"}>{r.attained ? "已达成" : "未达成"} {r.attainment != null ? `${r.attainment}%` : ""}</Tag>;
}

type Filters = { period?: string; dept?: string };

export default function GoalsClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<GoalsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [drawer, setDrawer] = useState<{ mode: "create"; dept: string } | { mode: "edit"; row: GoalRow } | null>(null);
  const [form] = Form.useForm();
  const listState = useListState<Filters>({ key: "goals", defaults: { period: "", dept: "" }, paginated: false, paramPrefix: "g" });
  const { filters } = listState;

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.period) params.set("period", filters.period);
      if (refresh) params.set("refresh", "1");
      setData(await fetchJson<GoalsData>(`/api/goals?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters.period, message]);
  useEffect(() => { void load(); }, [load]);

  const deptKeys = useMemo(() => data?.deptKeys ?? [], [data?.deptKeys]);
  const activeDept = filters.dept && deptKeys.includes(filters.dept) ? filters.dept : (deptKeys[0] ?? "");
  const editable = !!data?.editableDepts.includes(activeDept);

  const submit = async () => {
    const v = await form.validateFields();
    try {
      if (drawer?.mode === "create") {
        await postJson("/api/goals", { ...v, deptKey: drawer.dept, targetValue: String(v.targetValue) });
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
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const columns: ColumnsType<GoalRow> = [
    { title: "期间", dataIndex: "period", width: 90 },
    { title: "指标", dataIndex: "metricLabel", width: 160, render: (v: string, r) => <span>{v} <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.metricKey}</Typography.Text></span> },
    { title: "目标", dataIndex: "targetValue", width: 110, align: "right", render: (v: string, r) => `${v}${UNIT_SUFFIX[r.unit ?? ""] ?? ""}` },
    { title: "实际", dataIndex: "actualValue", width: 110, align: "right", render: (v: string | null, r) => (v == null ? "—" : `${v}${UNIT_SUFFIX[r.unit ?? ""] ?? ""}`) },
    { title: "达成", key: "attain", width: 150, render: (_, r) => attainTag(r) },
    { title: "方向", dataIndex: "direction", width: 90, render: (v: string) => (v === "up" ? "↑ 越高越好" : "↓ 越低越好") },
    { title: "来源", dataIndex: "actualSource", width: 90, render: (v: string | null, r) => (v === "auto" ? <Tag color="blue">auto</Tag> : v === "manual" ? <Tag color="gold">manual</Tag> : r.autoStatus === "unavailable" ? <Tag>auto·待读模型</Tag> : <Tag>manual·待填</Tag>) },
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
    label: `${ROLE_LABEL[d] ?? d}${data?.editableDepts.includes(d) ? "" : "（只读）"}`,
  })), [deptKeys, data?.editableDepts]);

  const rows = (data?.rows ?? []).filter((r) => r.deptKey === activeDept);

  return (
    <div>
      <Row justify="space-between" align="middle" style={{ marginBottom: 8 }}>
        <Col><Typography.Title level={4} style={{ margin: 0 }}>供应链目标</Typography.Title></Col>
        <Col>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => load(true)}>回填 auto 实际值</Button>
            <Button type="primary" icon={<PlusOutlined />} disabled={!editable} onClick={() => {
              form.resetFields();
              setDrawer({ mode: "create", dept: activeDept });
            }}>设置目标</Button>
          </Space>
        </Col>
      </Row>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="部门 = 角色（D61）；本部门可编辑，其他部门只读；管理员全部可编辑。"
        description="auto 指标（库存占比 / 库存周转 / 账期达成率 / OTIF）从已登记读模型缓存取值，取不到留空不编造；手工填报实际值必须附证据说明并留审计。"
      />
      <GoalProgressCard refreshKey={data?.rows.length ?? 0} />
      <ListToolbar
        state={listState}
        extra={(
          <Input
            allowClear
            placeholder="期间 YYYY-MM / YYYY-Qn"
            style={{ width: 180 }}
            defaultValue={filters.period}
            onPressEnter={(e) => listState.setFilter({ period: (e.target as HTMLInputElement).value.trim() })}
            onBlur={(e) => listState.setFilter({ period: e.target.value.trim() })}
          />
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
      />
      <Drawer
        title={drawer?.mode === "create" ? `设置目标 · ${ROLE_LABEL[drawer.dept] ?? drawer.dept}` : drawer?.mode === "edit" ? `编辑 · ${drawer.row.metricLabel} ${drawer.row.period}` : ""}
        open={!!drawer}
        onClose={() => setDrawer(null)}
        width={480}
        extra={<Button type="primary" onClick={submit}>保存</Button>}
      >
        <Form form={form} layout="vertical" initialValues={{ direction: "up" }}>
          {drawer?.mode === "create" ? (
            <>
              <Form.Item name="period" label="期间" rules={[{ required: true, pattern: /^(\d{4}-(0[1-9]|1[0-2])|\d{4}-Q[1-4])$/, message: "YYYY-MM 或 YYYY-Qn" }]}>
                <Input placeholder="2026-09 或 2026-Q3" />
              </Form.Item>
              <Form.Item name="metricKey" label="指标" rules={[{ required: true, message: "必选指标" }]}>
                <Select
                  showSearch
                  options={(data?.autoMetrics ?? []).map((m) => ({ value: m.metricKey, label: `${m.label}（auto · ${m.metricKey}）` }))}
                  onChange={(k) => {
                    const m = data?.autoMetrics.find((x) => x.metricKey === k);
                    if (m) form.setFieldValue("direction", m.defaultDirection);
                  }}
                />
              </Form.Item>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>其他已登记指标可直接输入 metricKey（manual 填报）。</Typography.Paragraph>
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
