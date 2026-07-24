"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Input,
  InputNumber,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { fetchJson, postJson } from "@/components/fetchJson";

interface ReplenishRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  baseUom: string;
  onHand: number;
  inTransit: number;
  daily: number;
  daysCover: number | null;
  suggestQty: string | null;
}

interface ReplenishResult {
  rows: ReplenishRow[];
  total: number;
  meta: {
    coverDaysTarget: number;
    minCoverAlert: number;
    months3: string[];
    snapDate: string | null;
    suggestCount: number;
  };
}

export default function ReplenishClient() {
  const { message } = App.useApp();
  const [coverDays, setCoverDays] = useState<number>(45);
  const [minCover, setMinCover] = useState<number>(30);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [data, setData] = useState<ReplenishResult | null>(null);
  const [loading, setLoading] = useState(false);

  const [selectedRows, setSelectedRows] = useState<ReplenishRow[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [remark, setRemark] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createdDocNo, setCreatedDocNo] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        coverDaysTarget: String(coverDays || 45),
        minCoverAlert: String(minCover || 30),
        q,
        page: String(page),
        pageSize: String(pageSize),
      });
      const res = await fetchJson<ReplenishResult>(`/api/replenish/suggestions?${params.toString()}`);
      setData(res);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [coverDays, minCover, q, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  // 数据刷新后同步勾选：当前页内的行以最新建议量为准，建议消失则剔除；不在当前页的保留（跨页勾选）
  useEffect(() => {
    if (!data) return;
    const byId = new Map(data.rows.map((r) => [r.skuId, r]));
    setSelectedRows((rows) =>
      rows.flatMap((r) => {
        const cur = byId.get(r.skuId);
        if (!cur) return [r];
        return cur.suggestQty == null ? [] : [cur];
      }),
    );
  }, [data]);

  const handleSubmit = async () => {
    if (selectedRows.length === 0) return;
    setSubmitting(true);
    try {
      const res = await postJson<{ id: number; docNo: string }>("/api/replenish/draft", {
        remark: remark.trim() || undefined,
        items: selectedRows.map((r) => ({ skuId: r.skuId, qty: r.suggestQty })),
      });
      setCreatedDocNo(res.docNo);
      setConfirmOpen(false);
      setSelectedRows([]);
      setRemark("");
      message.success(`备货申请草稿已生成：${res.docNo}`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const columns: ColumnsType<ReplenishRow> = useMemo(
    () => [
      { title: "SKU 编码", dataIndex: "code", width: 110, fixed: "left" },
      { title: "名称", dataIndex: "name", ellipsis: true },
      { title: "品牌", dataIndex: "brand", width: 100, render: (v: string | null) => v ?? "—" },
      {
        title: "在库（全网）",
        dataIndex: "onHand",
        width: 110,
        align: "right",
        render: (v: number) => v.toLocaleString("zh-CN"),
      },
      {
        title: "在途（PO）",
        dataIndex: "inTransit",
        width: 100,
        align: "right",
        render: (v: number) => v.toLocaleString("zh-CN"),
      },
      { title: "日均销（近3月）", dataIndex: "daily", width: 120, align: "right" },
      {
        title: "可销天数",
        dataIndex: "daysCover",
        width: 100,
        align: "right",
        render: (v: number | null) =>
          v == null ? (
            <Typography.Text type="secondary">无动销</Typography.Text>
          ) : v < 15 ? (
            <Typography.Text type="danger" strong>
              {v}
            </Typography.Text>
          ) : (
            v
          ),
      },
      {
        title: "建议补货量",
        dataIndex: "suggestQty",
        width: 130,
        align: "right",
        render: (v: string | null, r) =>
          v == null ? "—" : (
            <Space size={4}>
              <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                {Number(v).toLocaleString("zh-CN")}
              </Tag>
              <Typography.Text type="secondary">{r.baseUom}</Typography.Text>
            </Space>
          ),
      },
    ],
    [],
  );

  return (
    <div>
      <style>{`.replenish-danger-row td { background: #fff1f0 !important; }`}</style>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        补货建议（R11）
      </Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="建议基于全网口径在库（实时账+最新快照）+ PO 在途与近 3 月销速；生成的是草稿，走正常审批（R13 人工闸）。"
        description={
          data?.meta ? (
            <Typography.Text type="secondary">
              销速窗口：{data.meta.months3.length ? data.meta.months3.join("、") : "无销量数据"}
              {data.meta.snapDate ? `；快照数据日期：${data.meta.snapDate}` : ""}
              ；在途口径 v1 仅含已审批/执行中 PO 未收量（不含委外工单计划产出）；触发建议 {data.meta.suggestCount} 个 SKU。
            </Typography.Text>
          ) : null
        }
      />
      <Space style={{ marginBottom: 16, display: "flex", justifyContent: "space-between" }} wrap>
        <Space wrap>
          <span>
            目标覆盖天数{" "}
            <InputNumber
              min={1}
              max={365}
              precision={0}
              value={coverDays}
              onChange={(v) => {
                setCoverDays(v ?? 45);
                setPage(1);
              }}
              style={{ width: 90 }}
            />
          </span>
          <span>
            预警阈值（天）{" "}
            <InputNumber
              min={1}
              max={365}
              precision={0}
              value={minCover}
              onChange={(v) => {
                setMinCover(v ?? 30);
                setPage(1);
              }}
              style={{ width: 90 }}
            />
          </span>
          <Input.Search
            allowClear
            placeholder="搜索 SKU 编码/名称"
            style={{ width: 220 }}
            onSearch={(value) => {
              setQ(value.trim());
              setPage(1);
            }}
          />
        </Space>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      </Space>
      {createdDocNo ? (
        <Alert
          type="success"
          showIcon
          closable
          onClose={() => setCreatedDocNo(null)}
          style={{ marginBottom: 16 }}
          message={
            <span>
              备货申请草稿 {createdDocNo} 已生成，
              <a href="/outsource/bh">前往备货申请列表提交审批 →</a>
            </span>
          }
        />
      ) : null}
      <Table<ReplenishRow>
        rowKey="skuId"
        size="middle"
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        rowClassName={(r) => (r.daysCover != null && r.daysCover < 15 ? "replenish-danger-row" : "")}
        rowSelection={{
          selectedRowKeys: selectedRows.map((r) => r.skuId),
          preserveSelectedRowKeys: true,
          onChange: (_keys, rows) => setSelectedRows(rows.filter((r) => r != null)),
          getCheckboxProps: (r) => ({ disabled: r.suggestQty == null }),
        }}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
      />
      <div
        style={{
          position: "sticky",
          bottom: 0,
          padding: "12px 0",
          background: "var(--ant-color-bg-container, #fff)",
          display: "flex",
          justifyContent: "flex-end",
          gap: 12,
          alignItems: "center",
        }}
      >
        <Typography.Text>已选 {selectedRows.length} 项</Typography.Text>
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          disabled={selectedRows.length === 0}
          onClick={() => setConfirmOpen(true)}
        >
          生成备货申请草稿（BH）
        </Button>
      </div>

      <Modal
        title="确认生成备货申请草稿（BH）"
        open={confirmOpen}
        onOk={() => void handleSubmit()}
        onCancel={() => setConfirmOpen(false)}
        confirmLoading={submitting}
        okText="生成草稿"
        cancelText="取消"
        width="min(640px, 100vw)"
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="将按下表建议量生成一张 BH 草稿（不自动提交），提交与审批在备货申请页完成。"
        />
        <Table<ReplenishRow>
          rowKey="skuId"
          size="small"
          pagination={false}
          dataSource={selectedRows}
          columns={[
            { title: "SKU 编码", dataIndex: "code", width: 110 },
            { title: "名称", dataIndex: "name", ellipsis: true },
            {
              title: "建议补货量",
              dataIndex: "suggestQty",
              width: 130,
              align: "right",
              render: (v: string | null, r) => `${Number(v ?? 0).toLocaleString("zh-CN")} ${r.baseUom}`,
            },
          ]}
          style={{ marginBottom: 12 }}
        />
        <Input.TextArea
          rows={2}
          maxLength={200}
          placeholder="备注（可选，默认注明来源为补货建议页）"
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
        />
      </Modal>
    </div>
  );
}
