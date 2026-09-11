"use client";

import { useLatestRead } from "@/components/useLatestRead";

/**
 * 采购价目表维护（W2 审计 2）。
 *
 * 为什么必须有这一页：`price_lists` 同时是 R1 比价基准的兜底、`/report/price-compare` 的唯一数据源、
 * 结算扣款单价的代理，而在此之前它**只有 seed 脚本写过**——上线之后基准价永远是种子数据。
 *
 * 页面纪律：
 * - 改价 = **新增一条更晚生效日的行**（历史行留痕；同 SKU×供应商×渠道×生效日唯一）；
 * - 「当前生效」标记按 po.ts 取基准价的同一规则（生效日 ≤ 今日中最新的一行），一个组合只会有一行被标；
 * - 已生效行只有管理员能删（删了会静默改写 R1 基准与扣款代理价，且无版本链可回溯）。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Space, Table, Tag, Typography } from "antd";
import SearchInput from "@/components/SearchInput";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { fetchJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import RemoteSelect from "@/components/RemoteSelect";
import { hasAnyRole, useMe } from "@/components/useMe";
import { useListState } from "@/components/useListState";

interface Row {
  id: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  price: string;
  currency: string;
  channelId: number | null;
  effectiveDate: string;
  isCurrent: boolean;
  isFuture: boolean;
}
interface Data { rows: Row[]; total: number; today: string }
type Filters = { q: string; effective: string };

const money = (v: string): string =>
  Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PriceListClient() {
  const { message } = App.useApp();
  const me = useMe();
  // 与 API（PRICE_VISIBLE_ROLES）同口径
  const canView = hasAnyRole(me, "purchasing", "pmc", "finance");
  // 与服务层 requireAnyRole(user, "purchasing") 同口径（hasAnyRole 内含 admin 放行）
  const canWrite = hasAnyRole(me, "purchasing");
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const listState = useListState<Filters>({
    key: "purchase-price-list",
    defaults: { q: "", effective: "" },
    defaultPageSize: 20,
  });
  const { filters, page, pageSize } = listState;
  const { q, effective } = filters;

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (effective) params.set("effective", effective);
      const latestReadResult = await fetchJson<Data>(`/api/outsource/price-list?${params.toString()}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setData(latestReadResult);
    } catch (e) {
      if (!readRequest.isCurrent()) return;
      setLoadError((e as Error).message);
    } finally {
      if (readRequest.isCurrent()) { setLoading(false); }
    }
  }, [beginLoadRead, q, effective, page, pageSize]);
  useEffect(() => { if (canView) void load(); }, [load, canView]);

  const handleCreate = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await fetchJson("/api/outsource/price-list", {
        method: "POST",
        body: JSON.stringify({
          skuId: v.skuId,
          supplierId: v.supplierId,
          price: Number(v.price).toFixed(2),
          currency: (v.currency ?? "CNY").toUpperCase(),
          effectiveDate: dayjs(v.effectiveDate).format("YYYY-MM-DD"),
        }),
      });
      message.success("已新增基准价（改价请再新增一条更晚生效日的行，历史行保留）");
      setCreateOpen(false);
      form.resetFields();
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row: Row) => {
    try {
      await fetchJson(`/api/outsource/price-list/${row.id}`, { method: "DELETE" });
      message.success("已删除");
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  if (me && !canView) {
    return (
      <div>
        <Typography.Title level={4} style={{ marginTop: 0 }}>采购价目表</Typography.Title>
        <Alert type="warning" showIcon message="无权查看" description="采购基准价属敏感金额，仅采购 / 生产计划 / 财务 / 管理员可见。" />
      </div>
    );
  }

  const columns: ColumnsType<Row> = [
    { title: "物料编码", dataIndex: "skuCode", width: 150, fixed: "left" },
    { title: "物料名称", dataIndex: "skuName", ellipsis: true },
    { title: "供应商", dataIndex: "supplierName", width: 180, render: (v: string, r) => `${r.supplierCode} ${v}` },
    {
      title: "基准价（基础单位未税）", dataIndex: "price", width: 180, align: "right",
      render: (v: string, r) => `${money(v)} ${r.currency}`,
    },
    { title: "生效日", dataIndex: "effectiveDate", width: 120 },
    {
      title: "状态", key: "state", width: 130,
      render: (_: unknown, r) => (r.isCurrent
        ? <Tag color="green">当前生效</Tag>
        : r.isFuture ? <Tag color="blue">未来生效</Tag> : <Tag>历史</Tag>),
    },
    ...(canWrite
      ? [{
        title: "操作", key: "op", width: 100, fixed: "right" as const,
        render: (_: unknown, r: Row) => (
          <Popconfirm
            title="删除该基准价行？"
            description={r.isFuture ? "该行尚未生效，删除不影响任何已发生的判定。" : "该行已生效：删除会改写 R1 比价基准与结算扣款代理价，仅管理员可删。"}
            onConfirm={() => void handleDelete(r)}
          >
            <Button type="link" danger size="small">删除</Button>
          </Popconfirm>
        ),
      }]
      : []),
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>采购价目表</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="这张表同时驱动三处决策：R1 比价基准（PO 提交是否强制走 PC 调价单）、物料比价报表、委外结算的扣款单价代理。"
        description={
          <Typography.Text type="secondary">
            取价规则与 PO 比价完全一致：同一「物料 × 供应商 × 渠道」下，<strong>生效日 ≤ 今日</strong>中生效日最新的那一行为准
            （今日 {data?.today ?? "—"}）。改价请<strong>新增一条更晚生效日的行</strong>，不要改历史行——历史行是「当时按哪个价判的」唯一证据。
          </Typography.Text>
        }
      />
      {loadError ? <LoadErrorAlert error={loadError} onRetry={() => void load()} /> : null}

      <ListToolbar
        state={listState}
        extra={
          <Space>
            {/* SSR 安全的搜索组合（护栏 tests/architecture/ui-runtime-contract）：禁止 Input.Search */}
            <SearchInput
              allowClear
              placeholder="物料编码/名称、供应商编码/名称"
              defaultValue={q}
              style={{ width: 260 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
            <Button
              size="small"
              type={effective === "current" ? "primary" : "default"}
              onClick={() => listState.setFilter({ effective: effective === "current" ? "" : "current" })}
            >
              只看已生效
            </Button>
            <Button
              size="small"
              type={effective === "future" ? "primary" : "default"}
              onClick={() => listState.setFilter({ effective: effective === "future" ? "" : "future" })}
            >
              只看未来生效
            </Button>
            {canWrite ? <Button type="primary" onClick={() => setCreateOpen(true)}>新增基准价</Button> : null}
          </Space>
        }
      />

      <Table<Row>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={data?.rows ?? []}
        scroll={{ x: 1100 }}
        pagination={listState.paginationProps({ total: data?.total, showTotal: (t) => `共 ${t} 行基准价` })}
      />

      <Modal
        title="新增采购基准价"
        open={createOpen}
        onOk={() => void handleCreate()}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        forceRender
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="生效日一到，这个价就会成为 R1 比价基准与结算扣款代理价；填未来日期可以提前把谈好的价排进去。"
        />
        <Form form={form} layout="vertical" initialValues={{ currency: "CNY", effectiveDate: dayjs() }}>
          <Form.Item name="skuId" label="物料" rules={[{ required: true, message: "必须选择物料" }]}>
            <RemoteSelect api="/api/master/sku" getLabel={(r) => `${String(r.code)} ${String(r.name)}`} placeholder="选择物料" />
          </Form.Item>
          <Form.Item name="supplierId" label="供应商" rules={[{ required: true, message: "必须选择供应商" }]}>
            <RemoteSelect api="/api/master/supplier" getLabel={(r) => `${String(r.code)} ${String(r.name)}`} placeholder="选择供应商" />
          </Form.Item>
          <Form.Item name="price" label="基准价（基础单位未税）" rules={[{ required: true, message: "价格必填" }]}>
            <InputNumber min={0} precision={2} style={{ width: "100%" }} placeholder="例如 10.00" />
          </Form.Item>
          <Form.Item name="currency" label="币种">
            <Input maxLength={3} style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name="effectiveDate" label="生效日" rules={[{ required: true, message: "生效日必填" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
