"use client";

import SearchInput from "@/components/SearchInput";

/** 毛利视角 v1——手工成本基准 × 近3月销量（成本录入=finance/admin；售价源未接入时留白，绝不臆造） */
import { useCallback, useEffect, useState } from "react";
import { App, Col, InputNumber, Row, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";

import DecisionVisual from "@/components/DecisionVisual";
import { fetchJson, postJson } from "@/components/fetchJson";
import { exportCsv } from "@/components/exportCsv";
import { formatQty } from "@/components/format";
import { buildPlatformFeeUatExport } from "@/components/platform-fee-export";
import SkuHoverCard from "@/components/SkuHoverCard";
import CaliberNote from "@/components/CaliberNote";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import { VISUAL_COLOR } from "@/components/decision-visuals";
import type {
  JiandaoyunPlatformFeeObservation,
  PlatformFeeDimensionRow,
} from "@/server/modules/report/platform-fee-observation";

interface MarginRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  unitCost: number | null;
  sales3m: number;
  price: number | null;
  unitMargin: number | null;
  marginPct: number | null;
  margin3m: number | null;
}

interface MarginData {
  months: string[];
  rows: MarginRow[];
  total: number;
  summary: { costedSkus: number; uncostedSkus: number; totalMargin3m: number | null };
  priceAvailable: boolean;
  platformFee: JiandaoyunPlatformFeeObservation;
}

function amountNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatAmount(value: string | number): string {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(value);
}

function shortAmount(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (absolute >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return formatAmount(value);
}

export default function MarginClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<MarginData | null>(null);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ key: "margin", defaults: { q: "", onlyCosted: "" }, defaultPageSize: 50 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const onlyCosted = filters.onlyCosted === "1";
  const [edits, setEdits] = useState<Record<number, number | null>>({});
  const [saving, setSaving] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (onlyCosted) params.set("onlyCosted", "1");
      setData(await fetchJson<MarginData>(`/api/report/margin?${params.toString()}`));
      setEdits({});
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, onlyCosted, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const saveCost = async (r: MarginRow) => {
    const v = edits[r.skuId] ?? r.unitCost;
    if (v == null || !(v > 0)) { message.warning("请填写正数单位成本"); return; }
    setSaving(r.skuId);
    try {
      await postJson<{ ok: true }>("/api/report/margin", { skuCode: r.code, unitCost: String(v) });
      message.success(`${r.code} 单位成本已保存`);
      void load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const priceAvailable = data?.priceAvailable ?? false;
  const platformFee = data?.platformFee;
  const monthlyFeeChart = (platformFee?.monthly ?? []).map((row) => ({
    ...row,
    label: platformFee && platformFee.currencies.length > 1 ? `${row.key} · ${row.currency}` : row.key,
    billing: amountNumber(row.billingAmount),
    paid: amountNumber(row.paidAmount),
  }));
  const feeItemChart = (platformFee?.feeItems ?? []).slice(0, 10).map((row) => ({
    ...row,
    label: row.key.length > 16 ? `${row.key.slice(0, 15)}…` : row.key,
    paid: amountNumber(row.paidAmount),
  }));
  const platformFeeState = loading && !data
    ? "loading"
    : platformFee?.state === "preview" ? "ready" : "insufficient";

  const exportPlatformFee = () => {
    if (!platformFee) return;
    const output = buildPlatformFeeUatExport(platformFee);
    exportCsv(output.filename, output.headers, output.rows);
  };

  const feeColumns: ColumnsType<PlatformFeeDimensionRow> = [
    { title: "费用项", dataIndex: "key", ellipsis: true, sorter: (a, b) => a.key.localeCompare(b.key, "zh-CN") },
    { title: "币种", dataIndex: "currency", width: 76, sorter: (a, b) => a.currency.localeCompare(b.currency) },
    { title: "行数", dataIndex: "rows", width: 82, align: "right", sorter: (a, b) => a.rows - b.rows },
    { title: "计费金额", dataIndex: "billingAmount", width: 128, align: "right", sorter: (a, b) => amountNumber(a.billingAmount) - amountNumber(b.billingAmount), render: formatAmount },
    { title: "支付金额", dataIndex: "paidAmount", width: 128, align: "right", defaultSortOrder: "descend", sorter: (a, b) => amountNumber(a.paidAmount) - amountNumber(b.paidAmount), render: formatAmount },
    { title: "冲销/退回", dataIndex: "reversalPaidAmount", width: 128, align: "right", sorter: (a, b) => amountNumber(a.reversalPaidAmount) - amountNumber(b.reversalPaidAmount), render: formatAmount },
  ];

  const columns: ColumnsType<MarginRow> = [
    {
      title: "SKU 编码", dataIndex: "code", width: 150, fixed: "left",
      render: (v: string) => <SkuHoverCard code={v} />,
    },
    { title: "名称", dataIndex: "name", ellipsis: true, width: 220 },
    { title: "品牌", dataIndex: "brand", width: 100, render: (v: string | null) => v ?? "—" },
    {
      title: "单位成本", dataIndex: "unitCost", width: 210, align: "right",
      render: (v: number | null, r) => (
        <Space size={6}>
          <InputNumber
            size="small"
            min={0}
            step={0.01}
            style={{ width: 110 }}
            value={edits[r.skuId] !== undefined ? edits[r.skuId] : v}
            placeholder={v == null ? "待录入" : undefined}
            onChange={(val) => setEdits((s) => ({ ...s, [r.skuId]: val as number | null }))}
          />
          <a onClick={() => void saveCost(r)} style={{ pointerEvents: saving === r.skuId ? "none" : "auto", opacity: saving === r.skuId ? 0.5 : 1 }}>保存</a>
        </Space>
      ),
    },
    { title: "近3月销量", dataIndex: "sales3m", width: 105, align: "right", render: (v: number) => formatQty(v) },
    ...(priceAvailable
      ? ([
          { title: "单位售价", dataIndex: "price", width: 100, align: "right" as const, render: (v: number | null) => (v == null ? "—" : formatQty(v)) },
          { title: "单位毛利", dataIndex: "unitMargin", width: 100, align: "right" as const, render: (v: number | null) => (v == null ? "—" : formatQty(v)) },
          { title: "毛利率", dataIndex: "marginPct", width: 95, align: "right" as const, render: (v: number | null) => (v == null ? "—" : `${v}%`) },
          {
            title: "近3月毛利", dataIndex: "margin3m", width: 120, align: "right" as const,
            render: (v: number | null) => (v == null ? "—" : formatQty(v)),
          },
        ] as ColumnsType<MarginRow>)
      : []),
    {
      title: "状态", width: 110, fixed: "right",
      render: (_, r) => (r.unitCost == null ? <Tag color="default">待录入成本</Tag> : <Tag color="green">已录成本</Tag>),
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>毛利视角（手工成本 v1）</Typography.Title>
      <CaliberNote
        summary={<>手工成本 v1：成本人工录入，未录入不臆造；售价源未接入，毛利列暂缓点亮。批量导入：数据中心 → 文件上传（模板：SKU 成本导入）。</>}
        detail={<div><p>诚实口径声明：成本自动核算口径（D2）尚未裁定，本页单位成本为「手工录入基准」，非系统自动核算。</p><p>库内唯一价格表为供应商采购基准价（非售价），用它算毛利属臆造——故 priceAvailable=false；接入真实售价源后，单位毛利/毛利率/近3月毛利自动点亮。</p></div>}
      />
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={24} xl={14}>
          <DecisionVisual
            title="天猫平台费用月度控制（财务 UAT 预览）"
            question="每月平台计费与实际支付金额如何变化，冲销是否被完整保留？"
            metricId="platformFeePaidAmount"
            grain="月份 × 币种"
            unit="原币金额"
            source={{
              tier: "reference",
              source: "简道云天猫账单费用项目汇总（最新成功批次）",
              asOf: platformFee?.businessDateThrough,
              note: platformFee?.selectedForSync ? "当前部署已选" : "当前部署未选，仅 UAT 预览",
            }}
            coverage={{
              covered: platformFee?.totals.validRows ?? 0,
              total: platformFee?.totals.sourceRows ?? 0,
              label: "通过字段与币种校验的记录",
            }}
            activeFilters={[
              "平台：天猫",
              "权限：只读观察",
              platformFee?.businessDateFrom && platformFee?.businessDateThrough
                ? `统计期：${platformFee.businessDateFrom} 至 ${platformFee.businessDateThrough}`
                : "统计期：待核实",
              platformFee?.sourceAsOf ? `批次源更新：${platformFee.sourceAsOf}` : "批次源更新：未提供",
              platformFee?.selectedForSync ? "同步：当前已选" : "同步：当前未选",
            ]}
            summary={platformFee?.currencies.length
              ? platformFee.currencies.map((row) => `${row.currency} 支付 ${formatAmount(row.paidAmount)}，其中冲销/退回 ${formatAmount(row.reversalPaidAmount)}`).join("；")
              : platformFee?.gate ?? "正在读取费用观察证据。"}
            caveat={platformFee?.limitations.join(" ")}
            state={platformFeeState}
            stateDetail={platformFee?.gate}
            height={320}
            onExport={platformFee?.state === "preview" ? exportPlatformFee : undefined}
            exportLabel="导出财务 UAT 控制总量"
            dataView={(
              <Table
                rowKey={(row) => `${row.key}:${row.currency}`}
                size="small"
                pagination={false}
                dataSource={platformFee?.monthly ?? []}
                columns={[
                  { title: "月份", dataIndex: "key", sorter: (a, b) => a.key.localeCompare(b.key) },
                  { title: "币种", dataIndex: "currency", width: 76 },
                  { title: "计费金额", dataIndex: "billingAmount", align: "right", render: formatAmount },
                  { title: "支付金额", dataIndex: "paidAmount", align: "right", render: formatAmount },
                  { title: "冲销/退回", dataIndex: "reversalPaidAmount", align: "right", render: formatAmount },
                  { title: "负数行", dataIndex: "negativeRows", align: "right" },
                ] as ColumnsType<PlatformFeeDimensionRow>}
              />
            )}
          >
            <ResponsiveContainer minWidth={0} minHeight={1}>
              <BarChart data={monthlyFeeChart} margin={{ top: 8, right: 18, left: 8, bottom: 28 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" minTickGap={18} />
                <YAxis tickFormatter={shortAmount} />
                <RechartsTooltip formatter={(value) => formatAmount(Number(value))} />
                <Bar dataKey="billing" name="计费金额" fill={VISUAL_COLOR.compare} radius={[3, 3, 0, 0]} />
                <Bar dataKey="paid" name="支付金额" fill={VISUAL_COLOR.primary} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </DecisionVisual>
        </Col>
        <Col xs={24} xl={10}>
          <DecisionVisual
            title="平台费用项结构"
            question="哪些费用项目构成当前支付金额，优先核对哪些项目？"
            metricId="platformFeePaidAmount"
            grain="费用项 × 币种"
            unit="原币金额"
            source={{
              tier: "reference",
              source: "简道云天猫账单费用项目汇总（最新成功批次）",
              asOf: platformFee?.businessDateThrough,
            }}
            activeFilters={["TOP 10 图；表格与导出保留全部费用项"]}
            summary={platformFee?.feeItems.length
              ? `共 ${platformFee.feeItems.length} 个费用项；图中按支付金额展示前 10 项。`
              : platformFee?.gate ?? "正在读取费用项结构。"}
            caveat="排序用于确定核对优先级，不代表费用合理性；负数仍按冲销/退回解释。"
            state={platformFeeState}
            stateDetail={platformFee?.gate}
            height={320}
            dataView={(
              <Table
                rowKey={(row) => `${row.key}:${row.currency}`}
                size="small"
                pagination={{ pageSize: 10, showSizeChanger: false }}
                dataSource={platformFee?.feeItems ?? []}
                columns={feeColumns}
                scroll={{ x: 720 }}
              />
            )}
          >
            <ResponsiveContainer minWidth={0} minHeight={1}>
              <BarChart data={feeItemChart} layout="vertical" margin={{ top: 4, right: 18, left: 20, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tickFormatter={shortAmount} />
                <YAxis type="category" dataKey="label" width={110} />
                <RechartsTooltip formatter={(value) => formatAmount(Number(value))} />
                <Bar dataKey="paid" name="支付金额" fill={VISUAL_COLOR.primary} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </DecisionVisual>
        </Col>
      </Row>
      <Row gutter={[10, 10]} className="compact-kpi-row">
        <Col><Statistic title="已录成本 SKU 数" value={data?.summary.costedSkus ?? 0} /></Col>
        <Col><Statistic title="待录入成本" value={data?.summary.uncostedSkus ?? 0} /></Col>
        <Col>
          {priceAvailable
            ? <Statistic title="近3月毛利合计" value={data?.summary.totalMargin3m ?? 0} precision={2} />
            : <Statistic title="近3月毛利合计" value="售价待接入" valueStyle={{ fontSize: 20, color: "#8c8c8c" }} />}
        </Col>
      </Row>
      <ListToolbar
        state={listState}
        extra={
          <>
            <Tag.CheckableTag
              checked={onlyCosted}
              onChange={(c) => listState.setFilter({ onlyCosted: c ? "1" : "" })}
              style={{ border: "1px solid #d9d9d9", padding: "2px 10px" }}
            >
              只看已录成本
            </Tag.CheckableTag>
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
      <Table<MarginRow>
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
