"use client";

/** 毛利视角 v1——手工成本基准 × 近3月销量（成本录入=finance/admin；售价源未接入时留白，绝不臆造） */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Col, Input, InputNumber, Row, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import Link from "next/link";
import { fetchJson, postJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import CaliberNote from "@/components/CaliberNote";

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
}

export default function MarginClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<MarginData | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [onlyCosted, setOnlyCosted] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
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

  const columns: ColumnsType<MarginRow> = [
    {
      title: "SKU 编码", dataIndex: "code", width: 150, fixed: "left",
      render: (v: string) => <a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a>,
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
      <Row gutter={16} style={{ marginBottom: 12 }}>
        <Col><Statistic title="已录成本 SKU 数" value={data?.summary.costedSkus ?? 0} /></Col>
        <Col><Statistic title="待录入成本" value={data?.summary.uncostedSkus ?? 0} /></Col>
        <Col>
          {priceAvailable
            ? <Statistic title="近3月毛利合计" value={data?.summary.totalMargin3m ?? 0} precision={2} />
            : <Statistic title="近3月毛利合计" value="售价待接入" valueStyle={{ fontSize: 20, color: "#8c8c8c" }} />}
        </Col>
      </Row>
      <Space style={{ marginBottom: 12 }} wrap>
        <Tag.CheckableTag
          checked={onlyCosted}
          onChange={(c) => { setOnlyCosted(c); setPage(1); }}
          style={{ border: "1px solid #d9d9d9", padding: "2px 10px" }}
        >
          只看已录成本
        </Tag.CheckableTag>
        <Input.Search allowClear placeholder="搜索编码/名称" style={{ width: 240 }} onSearch={(v) => { setQ(v.trim()); setPage(1); }} />
      </Space>
      <Table<MarginRow>
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
