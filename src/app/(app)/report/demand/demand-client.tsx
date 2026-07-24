"use client";

/**
 * 月度需求达成参考（demand 域 P1.5 前的登记层）：SKU×渠道 需求/期初/期末/销售达成。
 * 达成率=达成/需求 前端现算（源文件公式未缓存——不落假数）；月度重导整类替换。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Input, Select, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";

interface Row {
  id: number;
  brandRaw: string | null;
  skuCode: string | null;
  skuId: number | null;
  materialName: string | null;
  orderType: string | null; // 产品类型
  qty: string | null; // 需求
  doneQty: string | null; // 销售达成
  usedQty: string | null; // 期初（槽位映射）
  remainQty: string | null; // 期末
  follower: string | null; // 渠道
  progress: string | null; // YYYY-MM
}

export default function DemandClient() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [importedAt, setImportedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [q, setQ] = useState("");
  const [channel, setChannel] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ kind: "demand", q, page: String(page), pageSize: String(pageSize) });
      const res = await fetchJson<{ rows: Row[]; total: number; importedAt: string | null }>(
        `/api/report/transit?${params.toString()}`,
      );
      // 渠道过滤（v1 前端过滤——单月数据量 ≤ 万级）
      setRows(channel ? res.rows.filter((r) => r.follower === channel) : res.rows);
      setTotal(res.total);
      setImportedAt(res.importedAt);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, channel, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const month = rows[0]?.progress ?? "—";
  const rate = (r: Row): string | null => {
    const d = Number(r.qty ?? 0);
    const a = Number(r.doneQty ?? 0);
    if (d <= 0) return null;
    return `${Math.round((a / d) * 1000) / 10}%`;
  };

  const columns: ColumnsType<Row> = [
    { title: "品牌", dataIndex: "brandRaw", width: 110 },
    {
      title: "编码",
      dataIndex: "skuCode",
      width: 130,
      render: (v: string | null, r) =>
        v ? (
          <Space size={4}>
            <a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a>
            {r.skuId == null ? <Tag>未建档</Tag> : null}
          </Space>
        ) : (
          "—"
        ),
    },
    { title: "名称", dataIndex: "materialName", ellipsis: true, width: 210 },
    { title: "类型", dataIndex: "orderType", width: 80, render: (v: string | null) => v ?? "—" },
    { title: "渠道", dataIndex: "follower", width: 110, render: (v: string | null) => <Tag>{v}</Tag> },
    { title: "需求", dataIndex: "qty", width: 90, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    { title: "销售达成", dataIndex: "doneQty", width: 100, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    {
      title: "达成率",
      width: 90,
      align: "right",
      render: (_, r) => {
        const s = rate(r);
        if (s == null) return "—";
        const n = parseFloat(s);
        return <Tag color={n >= 100 ? "green" : n >= 60 ? "orange" : "red"}>{s}</Tag>;
      },
    },
    { title: "期初", dataIndex: "usedQty", width: 90, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    { title: "期末", dataIndex: "remainQty", width: 90, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        需求达成参考（{month}）
      </Typography.Title>
      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="口径：月度「需求&计划&达成统计表」重导登记（整类替换）；达成率=销售达成÷需求 现算。源文件的总需求/动销率等公式列未缓存值——本页只呈现字面数据，不造数（D30 销售金额域 P1）。"
      />
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          allowClear
          placeholder="搜索编码/名称"
          style={{ width: 260 }}
          onSearch={(v) => {
            setQ(v.trim());
            setPage(1);
          }}
        />
        <Select
          allowClear
          placeholder="全部渠道"
          style={{ width: 160 }}
          value={channel}
          onChange={(v) => setChannel(v)}
          options={["天猫", "拼多多", "唯品会", "京东", "抖音商品卡", "私域", "商务", "品牌中心", "海外运营部"].map((v) => ({ value: v, label: v }))}
        />
        {importedAt ? <Tag color="green">导入于 {new Date(importedAt).toLocaleDateString("zh-CN")}</Tag> : <Tag>尚未导入</Tag>}
      </Space>
      <Table<Row>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (n) => `共 ${n} 条（SKU×渠道）`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
      />
    </div>
  );
}
