"use client";

import { useLatestRead } from "@/components/useLatestRead";

/**
 * 运营计划事件（大促 / 上新 / 下架 / 换链接 / 调价 / 其他）维护页。
 *
 * 纪律（D55/D43）：事件只作**上下文展示**——补货建议行上的标签、爆单预警的「预期内」降级、
 * 情景推演的人工预填；绝不自动改建议量、不开单。
 * 服务端 CRUD 与渠道范围裁剪在 `server/modules/planning/plan-events.ts`；本页不重实现任何判定。
 * kind 的中文标签由 GET 接口下发（`kindLabels`）——客户端不得值导入 `@/server/*`。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, DatePicker, Form, InputNumber, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import CaliberNote from "@/components/CaliberNote";
import { fetchJson, patchJson, postJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import RemoteSelect, { type RemoteRow } from "@/components/RemoteSelect";
import SearchInput from "@/components/SearchInput";
import SkuHoverCard from "@/components/SkuHoverCard";
import { useListState } from "@/components/useListState";

type Phase = "upcoming" | "active" | "past";

interface PlanEventRow {
  id: number;
  skuId: number | null;
  skuCode: string | null;
  skuName: string | null;
  spuId: number | null;
  spuCode: string | null;
  channelId: number | null;
  channelName: string | null;
  kind: string;
  kindLabel: string;
  startDate: string;
  endDate: string | null;
  expectedUpliftPct: number | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  phase: Phase;
}

interface PlanEventData {
  rows: PlanEventRow[];
  total: number;
  today: string;
  kindLabels: Record<string, string>;
}

interface FormValues {
  target: "sku" | "spu";
  skuId?: number;
  spuId?: number;
  channelId?: number;
  kind: string;
  range?: [Dayjs, Dayjs] | undefined;
  openEnded: boolean;
  startDate?: Dayjs;
  expectedUpliftPct?: number | null;
  note?: string;
}

const PHASE_TAG: Record<Phase, { color: string; label: string }> = {
  active: { color: "red", label: "进行中" },
  upcoming: { color: "blue", label: "未开始" },
  past: { color: "default", label: "已结束" },
};

export default function PlanEventsClient({ canWrite }: { canWrite: boolean }) {
  const { message } = App.useApp();
  const listState = useListState({
    key: "planning-events",
    defaults: { q: "", kind: "", channelId: "", openOnly: "1" },
    defaultPageSize: 50,
  });
  const { filters, page, pageSize } = listState;
  const [data, setData] = useState<PlanEventData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PlanEventRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<FormValues>();
  const openEnded = Form.useWatch("openEnded", form);
  const target = Form.useWatch("target", form);

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ q: filters.q, page: String(page), pageSize: String(pageSize) });
      if (filters.kind) params.set("kind", filters.kind);
      if (filters.channelId) params.set("channelId", filters.channelId);
      params.set("openOnly", filters.openOnly === "1" ? "1" : "0");
      const latestReadResult = await fetchJson<PlanEventData>(`/api/planning/events?${params.toString()}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setData(latestReadResult);
    } catch (e) {
      if (!readRequest.isCurrent()) return;
      setData(null);
      setLoadError(e instanceof Error ? e.message : "加载失败");
    } finally {
      if (readRequest.isCurrent()) { setLoading(false); }
    }
  }, [beginLoadRead, filters.q, filters.kind, filters.channelId, filters.openOnly, page, pageSize]);
  useEffect(() => { void load(); }, [load]);

  const kindOptions = useMemo(
    () => Object.entries(data?.kindLabels ?? {}).map(([value, label]) => ({ value, label })),
    [data?.kindLabels],
  );

  const openCreate = () => {
    setEditing(null);
    form.resetFields(); // 先清空：setFieldsValue 传 undefined 不会清掉上一次编辑残留的区间
    form.setFieldsValue({
      target: "sku", skuId: undefined, spuId: undefined, channelId: undefined,
      kind: "promo", startDate: dayjs(), openEnded: false, expectedUpliftPct: null, note: "",
    });
    setModalOpen(true);
  };

  const openEdit = useCallback((row: PlanEventRow) => {
    setEditing(row);
    form.resetFields();
    form.setFieldsValue({
      target: row.skuId != null ? "sku" : "spu",
      skuId: row.skuId ?? undefined,
      spuId: row.spuId ?? undefined,
      channelId: row.channelId ?? undefined,
      kind: row.kind,
      startDate: dayjs(row.startDate),
      range: row.endDate ? [dayjs(row.startDate), dayjs(row.endDate)] : undefined,
      openEnded: row.endDate == null,
      expectedUpliftPct: row.expectedUpliftPct,
      note: row.note ?? "",
    });
    setModalOpen(true);
  }, [form]);

  const submit = async () => {
    const v = await form.validateFields();
    const startDate = (v.openEnded ? v.startDate : v.range?.[0])?.format("YYYY-MM-DD");
    if (!startDate) { message.error("请选择开始日期"); return; }
    const payload = {
      skuId: v.target === "sku" ? v.skuId ?? null : null,
      spuId: v.target === "spu" ? v.spuId ?? null : null,
      channelId: v.channelId ?? null,
      kind: v.kind,
      startDate,
      endDate: v.openEnded ? null : v.range?.[1]?.format("YYYY-MM-DD") ?? null,
      expectedUpliftPct: v.expectedUpliftPct ?? null,
      note: v.note?.trim() ? v.note.trim() : null,
    };
    setSaving(true);
    try {
      if (editing) await patchJson(`/api/planning/events/${editing.id}`, payload);
      else await postJson("/api/planning/events", payload);
      message.success(editing ? "已保存" : "已新建计划事件");
      setModalOpen(false);
      void load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = useCallback(async (row: PlanEventRow) => {
    try {
      await fetchJson(`/api/planning/events/${row.id}`, { method: "DELETE" });
      message.success("已删除（审计留痕）");
      void load();
    } catch (e) {
      message.error((e as Error).message);
    }
  }, [load, message]);

  const columns: ColumnsType<PlanEventRow> = useMemo(() => [
    {
      title: "状态", dataIndex: "phase", width: 90, fixed: "left",
      render: (v: Phase) => <Tag color={PHASE_TAG[v].color}>{PHASE_TAG[v].label}</Tag>,
    },
    { title: "类型", dataIndex: "kindLabel", width: 90, render: (v: string) => <Tag>{v}</Tag> },
    {
      title: "对象", dataIndex: "skuCode", width: 200,
      render: (_: unknown, r) => r.skuCode
        ? <Space size={4}><SkuHoverCard code={r.skuCode} />{r.skuName ? <Typography.Text type="secondary" ellipsis>{r.skuName}</Typography.Text> : null}</Space>
        : <Tooltip title="SPU 级事件：补货行标签按 SKU 命中，SPU 级仅作情景与日历上下文"><Tag color="purple">SPU {r.spuCode ?? `#${r.spuId}`}</Tag></Tooltip>,
    },
    { title: "渠道", dataIndex: "channelName", width: 110, render: (v: string | null) => v ?? <Typography.Text type="secondary">不分渠道</Typography.Text> },
    { title: "开始", dataIndex: "startDate", width: 110 },
    { title: "结束", dataIndex: "endDate", width: 110, render: (v: string | null) => v ?? <Typography.Text type="secondary">长期</Typography.Text> },
    {
      title: "预期增幅", dataIndex: "expectedUpliftPct", width: 100, align: "right",
      render: (v: number | null) => v == null ? "—" : <Typography.Text type={v >= 0 ? "success" : "danger"}>{v > 0 ? "+" : ""}{v}%</Typography.Text>,
    },
    { title: "说明", dataIndex: "note", width: 220, ellipsis: true, render: (v: string | null) => v ?? "—" },
    { title: "创建人", dataIndex: "createdBy", width: 100, render: (v: string | null) => v ?? "—" },
    ...(canWrite
      ? [{
          title: "操作", key: "ops", width: 130, fixed: "right" as const,
          render: (_: unknown, r: PlanEventRow) => (
            <Space size={4}>
              <Button size="small" onClick={() => openEdit(r)}>编辑</Button>
              <Popconfirm title="删除该计划事件？" description="事件不是账：物理删除，但审计留 before。" onConfirm={() => void remove(r)} okText="删除" cancelText="取消">
                <Button size="small" danger>删除</Button>
              </Popconfirm>
            </Space>
          ),
        }]
      : []),
  ], [canWrite, openEdit, remove]);

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>大促与计划事件</Typography.Title>
      <CaliberNote
        summary={<>大促 / 上新 / 下架 / 换链接 / 调价的时间窗登记表。事件<b>只作上下文</b>：补货行标签、爆单预警「预期内」降级、情景推演预填，<b>不自动改建议量、不开单</b>（D55/D43）。</>}
        detail={
          <div>
            <p>对象：SKU 或 SPU 至少填一个；补货建议行的事件标签按 <b>SKU</b> 命中（SPU 级事件只进日历与情景）。渠道留空 = 不分渠道（全员可见）；受限渠道用户必须指定本人范围内的渠道。</p>
            <p>预期增幅（%）供人工判断与爆单预警对照，范围 −100 ~ 1000；不进任何公式。日历没人维护时，爆单预警里的「非预期」就不可当真——覆盖率在爆单预警页可见。</p>
            <p>写入权限 ops / pmc（admin 兜底），同事务审计 <code>entity=ops_plan_event</code>；删除为物理删除但审计留 before。</p>
          </div>
        }
      />
      <ListToolbar
        state={listState}
        extra={
          <>
            <Select
              placeholder="类型"
              allowClear
              style={{ width: 120 }}
              value={filters.kind || undefined}
              options={kindOptions}
              onChange={(v) => listState.setFilter({ kind: v ?? "" })}
            />
            <RemoteSelect
              api="/api/master/channel"
              getLabel={(row: RemoteRow) => `${String(row.name)}（${String(row.code)}）`}
              placeholder="渠道"
              allowClear
              style={{ width: 160 }}
              value={filters.channelId ? Number(filters.channelId) : undefined}
              onChange={(v) => listState.setFilter({ channelId: v == null ? "" : String(v) })}
            />
            <span>只看未结束 <Switch size="small" checked={filters.openOnly === "1"} onChange={(v) => listState.setFilter({ openOnly: v ? "1" : "0" })} /></span>
            <SearchInput allowClear placeholder="搜索 SKU/SPU/说明" style={{ width: 200 }} onSearch={(v) => listState.setFilter({ q: v.trim() })} />
          </>
        }
        primaryActions={
          <Space>
            {canWrite ? <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建计划事件</Button> : null}
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
          </Space>
        }
      />
      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="计划事件" />
      <Table<PlanEventRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: data?.total ?? 0 })}
        locale={{ emptyText: loadError ? "数据未加载" : "尚无计划事件；大促日历为空时，爆单预警无法判断「预期内」" }}
      />
      <Modal
        title={editing ? `编辑计划事件 #${editing.id}` : "新建计划事件"}
        open={modalOpen}
        onOk={() => void submit()}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width="min(640px, 100vw)"
      >
        <Form form={form} layout="vertical" initialValues={{ target: "sku", kind: "promo", openEnded: false }}>
          <Form.Item name="target" label="事件对象">
            <Select
              options={[{ value: "sku", label: "按 SKU（补货行标签只认 SKU）" }, { value: "spu", label: "按 SPU（仅日历与情景）" }]}
            />
          </Form.Item>
          {target === "spu"
            ? (
              <Form.Item name="spuId" label="SPU" rules={[{ required: true, message: "请选择 SPU" }]}>
                <RemoteSelect api="/api/master/spu" getLabel={(row: RemoteRow) => `${String(row.code)} · ${String(row.nameCn ?? "")}`} placeholder="搜索 SPU 编码或名称" allowClear />
              </Form.Item>
            )
            : (
              <Form.Item name="skuId" label="SKU" rules={[{ required: true, message: "请选择 SKU" }]}>
                <RemoteSelect api="/api/master/sku" getLabel={(row: RemoteRow) => `${String(row.code)} · ${String(row.name)}`} filterRow={(row: RemoteRow) => row.active !== false} placeholder="搜索 SKU 编码或名称" allowClear />
              </Form.Item>
            )}
          <Form.Item name="channelId" label="渠道" extra="留空 = 不分渠道（全员可见）；受限渠道用户必须选择本人范围内的渠道。">
            <RemoteSelect api="/api/master/channel" getLabel={(row: RemoteRow) => `${String(row.name)}（${String(row.code)}）`} placeholder="不分渠道" allowClear />
          </Form.Item>
          <Form.Item name="kind" label="类型" rules={[{ required: true, message: "请选择类型" }]}>
            <Select options={kindOptions.length ? kindOptions : [{ value: "promo", label: "大促" }]} />
          </Form.Item>
          <Form.Item name="openEnded" label="长期事件（无结束日）" valuePropName="checked">
            <Switch />
          </Form.Item>
          {openEnded
            ? (
              <Form.Item name="startDate" label="开始日期" rules={[{ required: true, message: "请选择开始日期" }]}>
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
            )
            : (
              <Form.Item name="range" label="事件区间" rules={[{ required: true, message: "请选择事件区间" }]}>
                <DatePicker.RangePicker style={{ width: "100%" }} />
              </Form.Item>
            )}
          <Form.Item name="expectedUpliftPct" label="预期增幅（%）" extra="仅供人工判断与爆单对照，不进公式；下架/调价降量填负数。范围 −100 ~ 1000。">
            <InputNumber style={{ width: "100%" }} min={-100} max={1000} precision={0} placeholder="可空" />
          </Form.Item>
          <Form.Item name="note" label="说明">
            <Input.TextArea rows={3} maxLength={500} showCount placeholder="活动名称、投放力度、依据…" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
