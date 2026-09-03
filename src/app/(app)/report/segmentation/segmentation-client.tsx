"use client";

import SearchInput from "@/components/SearchInput";

/** ABC/XYZ 库存分层——近6月销售贡献（ABC）×需求波动（XYZ）3×3 矩阵（只读） */
import { useCallback, useEffect, useState } from "react";
import { App, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import CaliberNote from "@/components/CaliberNote";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import SkuHoverCard from "@/components/SkuHoverCard";

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
  externalNet90: number | null;
  /** D58 四档 */
  tier: "S" | "A" | "B" | "C";
  xyzRaw: "X" | "Y" | "Z" | null;
  /** D59 权责 */
  ownership: "supply_chain_direct" | "joint_review" | "ops_fallback";
  ownershipReason: string;
  detectorHit: boolean;
  leadDaysKnown: boolean;
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
  xyzUnclassified: number;
  tierCuts: { sPct: number; aPct: number; bPct: number };
  tierDistribution: Record<string, { count: number; value: number; valueSharePct: number }>;
  ownershipMix: Record<string, number>;
}

const TIERS = ["S", "A", "B", "C"] as const;
const TIER_COLORS: Record<string, string> = { S: "magenta", A: "red", B: "orange", C: "default" };
const OWNERSHIP_LABELS: Record<string, string> = { supply_chain_direct: "供应链直出", joint_review: "联合评审", ops_fallback: "运营按需" };
const OWNERSHIP_COLORS: Record<string, string> = { supply_chain_direct: "green", joint_review: "gold", ops_fallback: "default" };

const ABC_ROWS = ["A", "B", "C"] as const;
const XYZ_COLS = ["X", "Y", "Z"] as const;

const ABC_COLORS: Record<string, string> = { A: "red", B: "orange", C: "blue" };
const XYZ_COLORS: Record<string, string> = { X: "green", Y: "gold", Z: "volcano" };
const cellColor = (cell: string): string => ABC_COLORS[cell[0]] ?? "default";

export default function SegmentationClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<SegData | null>(null);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ key: "segmentation", defaults: { q: "", cell: "", tier: "", ownership: "" }, defaultPageSize: 50 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const cell = filters.cell;
  const tier = filters.tier;
  const ownership = filters.ownership;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (cell) params.set("cell", cell);
      if (tier) params.set("tier", tier);
      if (ownership) params.set("ownership", ownership);
      setData(await fetchJson<SegData>(`/api/report/segmentation?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, cell, tier, ownership, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const columns: ColumnsType<SegRow> = [
    { title: "分层", dataIndex: "cell", width: 70, fixed: "left", render: (v: string) => <Tag color={cellColor(v)}>{v}</Tag> },
    {
      title: "SKU 编码", dataIndex: "code", width: 155,
      render: (v: string) => <SkuHoverCard code={v} />,
    },
    { title: "名称", dataIndex: "name", ellipsis: true, width: 240 },
    { title: "品牌", dataIndex: "brand", width: 110, render: (v: string | null) => v ?? "—" },
    { title: "近6月销量", dataIndex: "sales6m", width: 110, align: "right", render: (v: number) => v.toLocaleString("zh-CN") },
    {
      title: "外部近90天",
      dataIndex: "externalNet90",
      width: 105,
      align: "right",
      render: (v: number | null) => v == null ? <Typography.Text type="secondary">未映射</Typography.Text> : v.toLocaleString("zh-CN"),
    },
    { title: "月均", dataIndex: "avgMonthly", width: 100, align: "right", render: (v: number) => v.toLocaleString("zh-CN") },
    { title: "变异系数", dataIndex: "cv", width: 90, align: "right" },
    { title: "ABC", dataIndex: "abc", width: 70, render: (v: string) => <Tag color={ABC_COLORS[v]}>{v}</Tag> },
    {
      title: "XYZ", dataIndex: "xyz", width: 70,
      render: (v: string, r: SegRow) => r.xyzRaw == null
        ? <Tooltip title="样本不足（<6 月）或无动销：规则层未分级，按历史口径记 Z"><Tag color={XYZ_COLORS[v]}>{v}?</Tag></Tooltip>
        : <Tag color={XYZ_COLORS[v]}>{v}</Tag>,
    },
    {
      title: "四档", dataIndex: "tier", width: 70,
      render: (v: string) => <Tooltip title={data ? `切点 S≤${data.tierCuts.sPct}% / A≤${data.tierCuts.aPct}% / B≤${data.tierCuts.bPct}%（近 6 月销量件数累计占比）` : undefined}><Tag color={TIER_COLORS[v]}>{v}</Tag></Tooltip>,
    },
    {
      title: "权责", dataIndex: "ownership", width: 110,
      render: (v: string, r: SegRow) => <Tooltip title={r.ownershipReason}><Tag color={OWNERSHIP_COLORS[v]}>{OWNERSHIP_LABELS[v] ?? v}</Tag></Tooltip>,
    },
  ];

  const matrix = data?.matrix;
  const policy = data?.policy;

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>库存分层（ABC/XYZ）</Typography.Title>
      <CaliberNote
        summary={<>ABC＝销售贡献分层，XYZ＝需求波动；分层已驱动补货目标覆盖（A 60 / B 45 / C 25 天，运行参数可调）。{data ? <>　窗口 {data.months[0]} ~ {data.months[data.months.length - 1]}。</> : null}</>}
        detail={<div><p>ABC：近 6 月销售贡献分层（A 前 80% / B 次 15% / C 末 5%）；XYZ：需求波动（变异系数 X≤0.5 稳定 / Y≤1.0 中 / Z&gt;1.0 波动）。点击矩阵格可下钻明细。</p><p>D58 四档 S/A/B/C：同一窗口按累计占比切点（运行参数 grade_s/a/b_pct，缺省 50/80/95）；S 折回 ABC 的 A。D59 权责：S/A/B ∧ X ∧ 无异动 ∧ 周期已维护 → 供应链直出；S/A/B 其余 → 联合评审；C → 运营按需。月度固化与人工覆写在「补货试点候选」页。</p><p>调整 C 类目标即情景推演——一键收紧长尾库存、放宽 A 类缓冲。口径：成品在架 SKU、单源销量、无金额。</p></div>}
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
                        onClick={() => listState.setFilter({ cell: selected ? "" : key })}
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

      {data ? (
        <Space wrap style={{ marginBottom: 12 }}>
          {TIERS.map((t) => {
            const d = data.tierDistribution[t] ?? { count: 0, valueSharePct: 0 };
            const selected = tier === t;
            return (
              <Tag
                key={t}
                color={selected ? "blue" : TIER_COLORS[t]}
                style={{ cursor: "pointer", padding: "2px 10px" }}
                onClick={() => listState.setFilter({ tier: selected ? "" : t })}
              >
                {t} 级 {d.count} 个 · 销量 {d.valueSharePct}%
              </Tag>
            );
          })}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            权责：供应链直出 {data.ownershipMix.supply_chain_direct ?? 0} / 联合评审 {data.ownershipMix.joint_review ?? 0} / 运营按需 {data.ownershipMix.ops_fallback ?? 0}
            {data.xyzUnclassified > 0 ? `；XYZ 样本不足 ${data.xyzUnclassified}` : ""}
          </Typography.Text>
        </Space>
      ) : null}
      <ListToolbar
        state={listState}
        extra={
          <>
            <Select
              allowClear
              placeholder="权责"
              style={{ width: 120 }}
              value={ownership || undefined}
              options={Object.entries(OWNERSHIP_LABELS).map(([value, label]) => ({ value, label }))}
              onChange={(v) => listState.setFilter({ ownership: v ?? "" })}
            />
            {cell ? (
              <Tag color={cellColor(cell)} closable onClose={() => listState.setFilter({ cell: "" })}>
                已筛选：{cell}
              </Tag>
            ) : null}
            <SearchInput
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索编码/名称"
              style={{ width: 240 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
          </>
        }
      />

      <Table<SegRow>
        rowKey="skuId"
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: data?.total ?? 0 })}
      />
    </div>
  );
}
