"use client";

/** E2-07 物料需求展开（MRP）：成品需求（在制 WO 剩余产出 + 成品补货建议）经生效 BOM 展开为物料相关需求（只读） */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Input, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import SkuHoverCard from "@/components/SkuHoverCard";

interface MaterialDemandRow {
  materialSkuId: number;
  code: string;
  name: string;
  baseUom: string;
  grossReq: string;
  fromWip: string;
  fromPlan: string;
  onHand: string;
  inTransit: string;
  netReq: string;
  suggestQty: string;
  sharedCount: number;
  topProducts: string[];
}

interface MaterialDemandData {
  rows: MaterialDemandRow[];
  total: number;
  summary: {
    materialCount: number;
    shortageCount: number;
    wipWoCount: number;
    planSkuCount: number;
    missingBomProducts: string[];
    horizonDays: number;
    today: string;
  };
}

/** 数量展示：去掉 scale=4 尾零，千分位（原始值为十进制字符串，仅展示层转 Number） */
function qty(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export default function MaterialDemandClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<MaterialDemandData | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      setData(await fetchJson<MaterialDemandData>(`/api/report/material-demand?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const columns: ColumnsType<MaterialDemandRow> = [
    {
      title: "物料编码",
      dataIndex: "code",
      width: 160,
      fixed: "left",
      render: (v: string) => <SkuHoverCard code={v} />,
    },
    { title: "名称", dataIndex: "name", ellipsis: true, width: 220 },
    { title: "单位", dataIndex: "baseUom", width: 70 },
    {
      title: "毛需求",
      dataIndex: "grossReq",
      width: 110,
      align: "right",
      render: (v: string) => <Typography.Text strong>{qty(v)}</Typography.Text>,
    },
    {
      title: "其中·在制",
      dataIndex: "fromWip",
      width: 110,
      align: "right",
      render: (v: string) => (Number(v) > 0 ? qty(v) : <Typography.Text type="secondary">—</Typography.Text>),
    },
    {
      title: "其中·计划",
      dataIndex: "fromPlan",
      width: 110,
      align: "right",
      render: (v: string) => (Number(v) > 0 ? qty(v) : <Typography.Text type="secondary">—</Typography.Text>),
    },
    { title: "在库", dataIndex: "onHand", width: 105, align: "right", render: (v: string) => qty(v) },
    { title: "在途", dataIndex: "inTransit", width: 105, align: "right", render: (v: string) => qty(v) },
    {
      title: "净需求",
      dataIndex: "netReq",
      width: 110,
      align: "right",
      render: (v: string) => (Number(v) > 0 ? <Typography.Text type="danger" strong>{qty(v)}</Typography.Text> : <Typography.Text type="secondary">0</Typography.Text>),
    },
    {
      title: "建议采购量",
      dataIndex: "suggestQty",
      width: 120,
      align: "right",
      render: (v: string) =>
        Number(v) > 0 ? (
          <Tag color="orange" style={{ marginInlineEnd: 0, fontWeight: 600 }}>{qty(v)}</Tag>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: "共用成品数",
      dataIndex: "sharedCount",
      width: 110,
      align: "right",
      render: (v: number, r) =>
        v > 1 ? (
          <Tooltip title={`需求贡献 Top：${r.topProducts.join("、") || "—"}（共 ${v} 个成品的生效 BOM 引用该物料）`}>
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>{v} 个共用</Tag>
          </Tooltip>
        ) : (
          <Tooltip title={`需求来自：${r.topProducts.join("、") || "—"}`}>
            <span>{v}</span>
          </Tooltip>
        ),
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>物料需求展开（MRP）</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="相关需求 = 在制 + 计划 两路，经成品生效 BOM 单层展开（双损耗已计：毛 = 净单位用量 ×(1+来料损耗)×(1+生产损耗)× 计划产出，与委外工单快照同一公式）。"
        description={
          data ? (
            <Typography.Text type="secondary">
              在制 = 委外工单（已审批/执行中、未暂停）剩余产出，共 {data.summary.wipWoCount} 单，交期窗口 {data.summary.horizonDays} 天（口径日 {data.summary.today}）；
              计划 = 成品补货建议量，共 {data.summary.planSkuCount} 个成品。
              <b>计划路属建议层——成品建议未必被采纳，故本页为采购前瞻而非承诺</b>：只读不开单，下单仍走 PO 正常审批。
              {data.summary.missingBomProducts.length > 0
                ? `　有需求但无生效 BOM（展开断链，请补 BOM）：${data.summary.missingBomProducts.join("、")}`
                : ""}
            </Typography.Text>
          ) : null
        }
      />
      <Space size={40} style={{ marginBottom: 12 }} wrap>
        <Statistic title="涉及物料数" value={data?.summary.materialCount ?? 0} />
        <Statistic
          title="缺口物料数（净需求 > 0）"
          value={data?.summary.shortageCount ?? 0}
          valueStyle={{ color: (data?.summary.shortageCount ?? 0) > 0 ? "#cf1322" : undefined }}
        />
      </Space>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          allowClear
          placeholder="搜索物料编码/名称"
          style={{ width: 260 }}
          onSearch={(v) => { setQ(v.trim()); setPage(1); }}
        />
      </Space>
      <Table<MaterialDemandRow>
        rowKey="materialSkuId"
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
