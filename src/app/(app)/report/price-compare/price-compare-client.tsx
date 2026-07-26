"use client";

import SearchInput from "@/components/SearchInput";

/** E5-08 物料比价：同一物料多供应商基准价并排，价差最大者优先（只读；R1 防买贵，本页防买错家） */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";

interface PriceQuote {
  supplierId: number;
  supplierName: string;
  price: string;
  effectiveDate: string;
  isBest: boolean;
}

interface PriceCompareRow {
  skuId: number;
  code: string;
  name: string;
  baseUom: string;
  quotes: PriceQuote[];
  bestPrice: string;
  worstPrice: string;
  spreadPct: number;
  currentSupplierHint: string | null;
}

interface PriceCompareData {
  rows: PriceCompareRow[];
  total: number;
  summary: { skuCount: number; avgSpreadPct: number; maxSpreadPct: number };
}

/** 价差红线：超过此值即视为「值得立刻去谈」 */
const SPREAD_ALERT_PCT = 20;

const money = (v: string): string => Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PriceCompareClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<PriceCompareData | null>(null);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ key: "price-compare", defaults: { q: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      setData(await fetchJson<PriceCompareData>(`/api/report/price-compare?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const columns: ColumnsType<PriceCompareRow> = [
    {
      title: "SKU 编码",
      dataIndex: "code",
      width: 150,
      fixed: "left",
      render: (v: string) => <a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a>,
    },
    { title: "名称", dataIndex: "name", ellipsis: true, width: 220 },
    {
      title: "报价家数",
      dataIndex: "quotes",
      width: 95,
      align: "right",
      render: (v: PriceQuote[]) => `${v.length} 家`,
    },
    {
      title: "最低价 / 供应商",
      dataIndex: "bestPrice",
      width: 220,
      render: (v: string, r) => {
        const best = r.quotes.find((x) => x.isBest);
        return (
          <Space size={4}>
            <Typography.Text type="success" strong>{money(v)}</Typography.Text>
            <Typography.Text type="secondary">/{r.baseUom}</Typography.Text>
            <Typography.Text type="secondary">· {best?.supplierName ?? "—"}</Typography.Text>
          </Space>
        );
      },
    },
    {
      title: "最高价 / 供应商",
      dataIndex: "worstPrice",
      width: 220,
      render: (v: string, r) => {
        const worst = r.quotes[r.quotes.length - 1];
        return (
          <Space size={4}>
            <span>{money(v)}</span>
            <Typography.Text type="secondary">/{r.baseUom}</Typography.Text>
            <Typography.Text type="secondary">· {worst?.supplierName ?? "—"}</Typography.Text>
          </Space>
        );
      },
    },
    {
      title: "价差",
      dataIndex: "spreadPct",
      width: 100,
      align: "right",
      render: (v: number) =>
        v > SPREAD_ALERT_PCT ? (
          <Typography.Text type="danger" strong>{v.toFixed(1)}%</Typography.Text>
        ) : (
          <span>{v.toFixed(1)}%</span>
        ),
    },
    {
      title: "近期在跟谁买",
      dataIndex: "currentSupplierHint",
      width: 160,
      ellipsis: true,
      render: (v: string | null, r) => {
        if (!v) return <Typography.Text type="secondary">无 PO 记录</Typography.Text>;
        const best = r.quotes.find((x) => x.isBest);
        return best && best.supplierName !== v ? (
          <Space size={4}>
            <span>{v}</span>
            <Tag color="orange" style={{ marginInlineEnd: 0 }}>非最低价</Tag>
          </Space>
        ) : (
          <span>{v}</span>
        );
      },
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>物料比价</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="R1 价格硬门防的是「买贵了」（单据比基准价异动）；本页挣的是「买对家」——同一物料多家横向比，价差最大的最该先谈。"
        description={
          <Typography.Text type="secondary">
            价格为<b>采购基准价</b>（价目表登记的基础单位未税价），<b>不是售价</b>，也不含税费/运费/账期成本——
            实际最优家还需结合质量、交期与结算方式判断。
            <br />
            同一供应商同一物料有多条历史价时，<b>取生效日 ≤ 今天中最新的一条</b>（与开单现价查询同口径；未来生效价不参与比价）。
            <br />
            仅显示<b>有 2 家及以上报价</b>的物料——单一供应商无从比较。「近期在跟谁买」取最近一张已审批及以后状态 PO 的供应商，仅作参考。
          </Typography.Text>
        }
      />

      {data ? (
        <Space size="large" style={{ marginBottom: 12 }} wrap>
          <Statistic title="可比物料数" value={data.summary.skuCount} valueStyle={{ fontSize: 20 }} />
          <Statistic title="平均价差" value={data.summary.avgSpreadPct} suffix="%" precision={1} valueStyle={{ fontSize: 20 }} />
          <Statistic
            title="最大价差"
            value={data.summary.maxSpreadPct}
            suffix="%"
            precision={1}
            valueStyle={{ fontSize: 20, color: data.summary.maxSpreadPct > SPREAD_ALERT_PCT ? "#cf1322" : undefined }}
          />
        </Space>
      ) : null}

      <ListToolbar
        state={listState}
        extra={
          <SearchInput
            key={q}
            allowClear
            defaultValue={q}
            placeholder="搜索 SKU 编码 / 名称"
            style={{ width: 280 }}
            onSearch={(v) => listState.setFilter({ q: v.trim() })}
          />
        }
      />

      <Table<PriceCompareRow>
        rowKey="skuId"
        size={listState.tableSize}
        loading={loading}
        columns={columns}
        dataSource={data?.rows ?? []}
        scroll={{ x: 1200 }}
        expandable={{
          expandedRowRender: (r) => (
            <Table<PriceQuote>
              rowKey="supplierId"
              size="small"
              pagination={false}
              dataSource={r.quotes}
              columns={[
                {
                  title: "供应商",
                  dataIndex: "supplierName",
                  render: (v: string, qr) => (
                    <Space size={6}>
                      <span>{v}</span>
                      {qr.isBest ? <Tag color="green" style={{ marginInlineEnd: 0 }}>最优</Tag> : null}
                      {r.currentSupplierHint === v ? <Tag style={{ marginInlineEnd: 0 }}>近期在买</Tag> : null}
                    </Space>
                  ),
                },
                {
                  title: `基准价（元/${r.baseUom}，未税）`,
                  dataIndex: "price",
                  width: 200,
                  align: "right",
                  render: (v: string, qr) =>
                    qr.isBest ? <Typography.Text type="success" strong>{money(v)}</Typography.Text> : money(v),
                },
                {
                  title: "较最低价",
                  dataIndex: "price",
                  width: 130,
                  align: "right",
                  render: (v: string) => {
                    const base = Number(r.bestPrice);
                    const diff = base > 0 ? ((Number(v) - base) / base) * 100 : 0;
                    return diff <= 0 ? (
                      <Typography.Text type="secondary">—</Typography.Text>
                    ) : (
                      <Typography.Text type={diff > SPREAD_ALERT_PCT ? "danger" : undefined}>
                        +{diff.toFixed(1)}%
                      </Typography.Text>
                    );
                  },
                },
                { title: "生效日", dataIndex: "effectiveDate", width: 130 },
              ]}
            />
          ),
        }}
        pagination={listState.paginationProps({ total: data?.total ?? 0 })}
      />
    </div>
  );
}
