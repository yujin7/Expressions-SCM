"use client";

import { useSearchParams } from "next/navigation";

/**
 * 月度需求达成参考（demand 域 P1.5 前的登记层）：SKU×渠道 需求/期初/期末/销售达成。
 * 达成率=达成/需求 前端现算（源文件公式未缓存——不落假数）；月度重导整类替换。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Input, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from "antd";
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

function DemandTab() {
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


interface PalletRow {
  id: number;
  brandRaw: string | null;
  skuCode: string | null;
  skuId: number | null;
  materialName: string | null;
  qty: string | null; // 当前库存（月末）
  doneQty: string | null; // 月销量
  exception: string | null; // 处置注记
  progress: string | null;
  extra: { 近三月日均销?: number | null; 可销天数_文件口径?: number | null; 是否滞销_文件口径?: string | null } | null;
}

/** 货盘处置参考：PMC 月度货盘 + 处置注记（R14 备注字典源）；文件口径指标并列供与系统口径对照 */
function PalletTab({ initialQ = "" }: { initialQ?: string }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<PalletRow[]>([]);
  const [total, setTotal] = useState(0);
  const [importedAt, setImportedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [q, setQ] = useState(initialQ);
  const [onlyRemark, setOnlyRemark] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ kind: "pallet", q, page: String(page), pageSize: String(pageSize) });
      const res = await fetchJson<{ rows: PalletRow[]; total: number; importedAt: string | null }>(
        `/api/report/transit?${params.toString()}`,
      );
      setRows(onlyRemark ? res.rows.filter((r) => r.exception) : res.rows);
      setTotal(res.total);
      setImportedAt(res.importedAt);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, onlyRemark, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const remarkColor = (v: string): string =>
    v.includes("报废") || v.includes("过期") ? "red" : v.includes("临期") ? "volcano" : v.includes("停") ? "orange" : "blue";

  const cols: ColumnsType<PalletRow> = [
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
    { title: "名称", dataIndex: "materialName", ellipsis: true, width: 220 },
    { title: "月末库存", dataIndex: "qty", width: 100, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    { title: "月销量", dataIndex: "doneQty", width: 90, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    {
      title: "可销天数（文件口径）",
      width: 150,
      align: "right",
      render: (_, r) => {
        const d = r.extra?.可销天数_文件口径;
        if (d == null) return "—";
        const n = Math.round(d);
        return (
          <Tooltip title="货盘文件当月口径；系统实时口径见驾驶舱/补货建议">
            <Tag color={n < 30 ? "red" : n > 180 ? "orange" : "green"}>{n.toLocaleString("zh-CN")}天</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: "滞销（文件）",
      width: 100,
      render: (_, r) => {
        const v = r.extra?.是否滞销_文件口径;
        return v ? <Tag color={v === "是" ? "orange" : "default"}>{v}</Tag> : "—";
      },
    },
    {
      title: "处置注记",
      dataIndex: "exception",
      width: 220,
      render: (v: string | null) => (v ? <Tag color={remarkColor(v)}>{v}</Tag> : "—"),
    },
  ];

  return (
    <div>
      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="口径：PMC 月度货盘登记（整类替换）。处置注记（过期待报废/临期禁售/商务库存…）为业务处置依据；可销天数/滞销为文件当月口径，与系统实时口径（驾驶舱/补货建议）并存对照。成本单价列按 D2 裁决不入库。"
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
        <Tag.CheckableTag checked={onlyRemark} onChange={(c) => setOnlyRemark(c)} style={{ border: "1px solid #d9d9d9", padding: "2px 10px" }}>
          只看有处置注记
        </Tag.CheckableTag>
        {importedAt ? <Tag color="green">导入于 {new Date(importedAt).toLocaleDateString("zh-CN")}</Tag> : <Tag>尚未导入</Tag>}
      </Space>
      <Table<PalletRow>
        rowKey="id"
        size="small"
        columns={cols}
        dataSource={rows}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (n) => `共 ${n} 条`,
          onChange: (p2, ps) => {
            setPage(p2);
            setPageSize(ps);
          },
        }}
      />
    </div>
  );
}

interface SummaryRow {
  id: number;
  skuCode: string | null;
  skuId: number | null;
  materialName: string | null;
  orderType: string | null;
  qty: string | null; // 文件商品数量（全公司口径）
  inboundQty: string | null; // 已下单未出货
  progress: string | null;
  extra: { 总日均销量?: number | null; 总计划可销天数?: number | null } | null;
  /** E1-02：查询时实时计算（不再读烘焙值） */
  sysQty?: number | null;
  diffQty?: number | null;
}

/** 总库存核对：文件=全公司口径 vs 系统=自有+电商部快照——差异主因=海外/其他部门仓不在快照源（覆盖缺口已量化） */
function StockSummaryTab() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [q, setQ] = useState("");
  const [onlyDiff, setOnlyDiff] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ kind: "stock_summary", q, page: String(page), pageSize: String(pageSize) });
      const res = await fetchJson<{ rows: SummaryRow[]; total: number }>(`/api/report/transit?${params.toString()}`);
      setRows(onlyDiff ? res.rows.filter((r) => Math.abs(r.diffQty ?? 0) >= 0.5) : res.rows);
      setTotal(res.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, onlyDiff, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const cols: ColumnsType<SummaryRow> = [
    { title: "编码", dataIndex: "skuCode", width: 130, render: (v: string | null, r) => v ? <Space size={4}><a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a>{r.skuId == null ? <Tag>未建档</Tag> : null}</Space> : "—" },
    { title: "名称", dataIndex: "materialName", ellipsis: true, width: 210 },
    { title: "类型", dataIndex: "orderType", width: 90, render: (v: string | null) => v ?? "—" },
    { title: "文件总库存", dataIndex: "qty", width: 110, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    { title: "系统数（核对时）", width: 130, align: "right", render: (_, r) => (r.sysQty != null ? formatQty(String(r.sysQty)) : "—") },
    {
      title: "差异（系统−文件）", width: 140, align: "right",
      render: (_, r) => {
        const d = r.diffQty;
        if (d == null) return "—";
        if (Math.abs(d) < 0.5) return <Tag color="green">一致</Tag>;
        return <Tooltip title="差异主因：海外/其他部门仓不在电商部快照源内（覆盖口径），非记账错误"><Tag color={d < 0 ? "orange" : "blue"}>{d > 0 ? "+" : ""}{formatQty(String(d))}</Tag></Tooltip>;
      },
    },
    { title: "在订未出", dataIndex: "inboundQty", width: 100, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    { title: "总日均销（文件）", width: 120, align: "right", render: (_, r) => r.extra?.总日均销量 != null ? String(Math.round((r.extra.总日均销量 as number) * 100) / 100) : "—" },
  ];

  return (
    <div>
      <Alert style={{ marginBottom: 12 }} type="warning" showIcon
        message="口径：文件「商品数量」=全公司口径（含海外/其他部门仓）；系统数=自有实时账+电商部快照。核对结论（2026-07-21）：775 可比 SKU 中 301 一致、474 差异——差异集中于快照源未覆盖的非电商部仓，属覆盖缺口而非记账错误（全量差异 reports/总库存核对-2026-07-21.json；扩源方案见 CURRENT 已知余量）。" />
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search allowClear placeholder="搜索编码/名称" style={{ width: 260 }} onSearch={(v) => { setQ(v.trim()); setPage(1); }} />
        <Tag.CheckableTag checked={onlyDiff} onChange={setOnlyDiff} style={{ border: "1px solid #d9d9d9", padding: "2px 10px" }}>只看差异</Tag.CheckableTag>
      </Space>
      <Table<SummaryRow> rowKey="id" size="small" columns={cols} dataSource={rows} loading={loading} scroll={{ x: "max-content" }}
        pagination={{ current: page, pageSize, total, showSizeChanger: true, showTotal: (n) => `共 ${n} 条`, onChange: (p2, ps) => { setPage(p2); setPageSize(ps); } }} />
    </div>
  );
}

export default function DemandClient() {
  const searchParams = useSearchParams();
  const initialTab = ["demand", "pallet", "stock_summary"].includes(searchParams.get("tab") ?? "") ? (searchParams.get("tab") as string) : "demand";
  const initialQ = searchParams.get("q") ?? "";
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        需求达成与货盘参考
      </Typography.Title>
      <Tabs
        defaultActiveKey={initialTab}
        items={[
          { key: "demand", label: "需求达成", children: <DemandTab /> },
          { key: "pallet", label: "货盘处置", children: <PalletTab initialQ={initialQ} /> },
          { key: "stock_summary", label: "总库存核对", children: <StockSummaryTab /> },
        ]}
      />
    </div>
  );
}
