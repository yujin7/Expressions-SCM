"use client";

/** ABC/XYZ 库存分层——近6月销售贡献（ABC）×需求波动（XYZ）3×3 矩阵（只读） */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Input, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";

interface SegRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  sales6m: number;
  avgMonthly: number;
  cv: number;
  abc: "A" | "B" | "C";
  xyz: "X" | "Y" | "Z";
  cell: string;
}

interface MatrixCell {
  count: number;
  salesShare: number;
}

interface SegData {
  months: string[];
  rows: SegRow[];
  total: number;
  matrix: Record<string, MatrixCell>;
  policy: Record<string, string>;
}

const ABC_ROWS = ["A", "B", "C"] as const;
const XYZ_COLS = ["X", "Y", "Z"] as const;

const ABC_COLORS: Record<string, string> = { A: "red", B: "orange", C: "blue" };
const XYZ_COLORS: Record<string, string> = { X: "green", Y: "gold", Z: "volcano" };
const cellColor = (cell: string): string => ABC_COLORS[cell[0]] ?? "default";

export default function SegmentationClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<SegData | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [cell, setCell] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (cell) params.set("cell", cell);
      setData(await fetchJson<SegData>(`/api/report/segmentation?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, cell, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const columns: ColumnsType<SegRow> = [
    { title: "分层", dataIndex: "cell", width: 70, fixed: "left", render: (v: string) => <Tag color={cellColor(v)}>{v}</Tag> },
    {
      title: "SKU 编码", dataIndex: "code", width: 155,
      render: (v: string) => <a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a>,
    },
    { title: "名称", dataIndex: "name", ellipsis: true, width: 240 },
    { title: "品牌", dataIndex: "brand", width: 110, render: (v: string | null) => v ?? "—" },
    { title: "近6月销量", dataIndex: "sales6m", width: 110, align: "right", render: (v: number) => v.toLocaleString("zh-CN") },
    { title: "月均", dataIndex: "avgMonthly", width: 100, align: "right", render: (v: number) => v.toLocaleString("zh-CN") },
    { title: "变异系数", dataIndex: "cv", width: 90, align: "right" },
    { title: "ABC", dataIndex: "abc", width: 70, render: (v: string) => <Tag color={ABC_COLORS[v]}>{v}</Tag> },
    { title: "XYZ", dataIndex: "xyz", width: 70, render: (v: string) => <Tag color={XYZ_COLORS[v]}>{v}</Tag> },
  ];

  const matrix = data?.matrix;
  const policy = data?.policy;

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>库存分层（ABC/XYZ）</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="双维分层（只读建议，不自动开单）：ABC=近6月销售贡献分层（A 前 80% / B 次 15% / C 末 5%）；XYZ=需求波动（变异系数 X≤0.5 稳定 / 0.5<Y≤1.0 中 / Z>1.0 波动）。点击矩阵格可下钻明细。"
        description={data ? <Typography.Text type="secondary">口径窗口：{data.months[0] ?? "—"} ~ {data.months[data.months.length - 1] ?? "—"}（近6月）；成品在架 SKU；单源销量，无金额。</Typography.Text> : null}
      />

      {matrix && policy ? (
        <table style={{ borderCollapse: "separate", borderSpacing: 6, marginBottom: 16, width: "100%", tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th style={{ width: 44 }} />
              {XYZ_COLS.map((x) => (
                <th key={x} style={{ textAlign: "center", fontWeight: 600, paddingBottom: 4 }}>
                  {x}{x === "X" ? "（稳定）" : x === "Y" ? "（中）" : "（波动）"}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ABC_ROWS.map((a) => (
              <tr key={a}>
                <th style={{ textAlign: "center", fontWeight: 600, verticalAlign: "middle" }}>{a}</th>
                {XYZ_COLS.map((x) => {
                  const key = `${a}${x}`;
                  const mc = matrix[key] ?? { count: 0, salesShare: 0 };
                  const selected = cell === key;
                  return (
                    <td key={key} style={{ verticalAlign: "top" }}>
                      <div
                        onClick={() => { setCell(selected ? null : key); setPage(1); }}
                        style={{
                          cursor: "pointer",
                          borderRadius: 8,
                          padding: "10px 12px",
                          minHeight: 108,
                          border: selected ? "2px solid #1677ff" : "1px solid #e8e8e8",
                          background: selected ? "#e6f4ff" : "#fafafa",
                          transition: "all .15s",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <Tag color={cellColor(key)} style={{ marginRight: 0 }}>{key}</Tag>
                          <Typography.Text strong>{mc.count} 个</Typography.Text>
                        </div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>销量占比 {mc.salesShare}%</Typography.Text>
                        <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.4 }}>{policy[key]}</div>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <Space style={{ marginBottom: 12 }} wrap>
        {cell ? (
          <Tag color={cellColor(cell)} closable onClose={() => { setCell(null); setPage(1); }}>
            已筛选：{cell}
          </Tag>
        ) : null}
        <Input.Search allowClear placeholder="搜索编码/名称" style={{ width: 240 }} onSearch={(v) => { setQ(v.trim()); setPage(1); }} />
      </Space>

      <Table<SegRow>
        rowKey="skuId"
        size="small"
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => { setPage(p); setPageSize(ps); },
        }}
      />
    </div>
  );
}
