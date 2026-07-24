"use client";

/**
 * E7-06 全链达成漏斗：需求 → 计划 → 下单 → 到货 → 动销 五级量级 + 级间转化率（只读）。
 * 横向条形（recharts layout="vertical"）看量级落差，条右侧标注到下一级的转化率；
 * 下方表格逐级列出量 / 单据数 / 取数口径——口径与时间窗不对齐的诚实标注在顶部 Alert。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Card, Radio, Skeleton, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";

type StageKey = "demand" | "plan" | "order" | "receipt" | "sales";

interface FunnelStage {
  key: StageKey;
  label: string;
  qty: number;
  docCount: number;
  note: string;
}
interface FunnelConversion {
  from: StageKey;
  to: StageKey;
  rate: number | null;
}
interface FunnelData {
  stages: FunnelStage[];
  conversions: FunnelConversion[];
  months: number;
  monthList: string[];
  docWindow: { from: string; to: string };
  caveat: string;
}

const STAGE_COLOR: Record<StageKey, string> = {
  demand: "#8c8c8c",
  plan: "#722ed1",
  order: "#2f54eb",
  receipt: "#13c2c2",
  sales: "#52c41a",
};

/** 数量展示：万级折「万」便于口播（与销量瀑布图一致） */
const qty = (v: number): string =>
  Math.abs(v) >= 10000 ? `${formatQty(Math.round(v / 1000) / 10)} 万` : formatQty(Math.round(v * 100) / 100);

const pct = (r: number | null): string => (r == null ? "—" : `${Math.round(r * 1000) / 10}%`);

export default function FunnelClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState(3);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchJson<FunnelData>(`/api/report/funnel?months=${months}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [months, message]);
  useEffect(() => { void load(); }, [load]);

  /** 条形数据（含到下一级的转化率，用于条右侧标注） */
  const chartRows = useMemo(() => {
    if (!data) return [];
    return data.stages.map((s, i) => ({
      key: s.key,
      label: s.label,
      qty: s.qty,
      next: data.conversions.find((c) => c.from === s.key)?.rate ?? null,
      isLast: i === data.stages.length - 1,
    }));
  }, [data]);

  const columns: ColumnsType<FunnelStage> = [
    {
      title: "层级",
      dataIndex: "label",
      width: 110,
      render: (v: string, r) => <Tag color={STAGE_COLOR[r.key]}>{v}</Tag>,
    },
    {
      title: "数量合计",
      dataIndex: "qty",
      width: 140,
      align: "right",
      render: (v: number) => (v > 0 ? <b>{qty(v)}</b> : <Typography.Text type="secondary">0</Typography.Text>),
    },
    {
      title: "单据 / 记录数",
      dataIndex: "docCount",
      width: 120,
      align: "right",
      render: (v: number) => (v > 0 ? v.toLocaleString("zh-CN") : <Typography.Text type="secondary">0</Typography.Text>),
    },
    {
      title: "到下一级转化率",
      dataIndex: "key",
      width: 130,
      align: "right",
      render: (k: StageKey) => {
        const c = data?.conversions.find((x) => x.from === k);
        if (!c) return <Typography.Text type="secondary">—</Typography.Text>;
        return c.rate == null ? <Typography.Text type="secondary">上游为 0，不计算</Typography.Text> : <span>{pct(c.rate)}</span>;
      },
    },
    {
      title: "取数口径",
      dataIndex: "note",
      render: (v: string) => <span style={{ fontSize: 12, color: "rgba(0,0,0,0.65)", lineHeight: 1.7 }}>{v}</span>,
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>全链达成漏斗</Typography.Title>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="转化率仅供趋势参考，不是精确损耗率"
        description={data?.caveat ?? "各级口径与时间窗不完全对齐，五级并非严格一一对应。"}
      />
      <Space size={12} wrap style={{ marginBottom: 12 }}>
        <Radio.Group
          value={months}
          onChange={(e) => setMonths(Number(e.target.value))}
          optionType="button"
          buttonStyle="solid"
          options={[
            { label: "近 3 月", value: 3 },
            { label: "近 6 月", value: 6 },
            { label: "近 12 月", value: 12 },
          ]}
        />
        {data ? (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            自然月窗（需求/动销）：{data.monthList.length ? `${data.monthList[0]} ~ ${data.monthList[data.monthList.length - 1]}` : "无销量数据"}
            　单据创建时间窗（计划/下单/到货）：{data.docWindow.from} ~ {data.docWindow.to}
          </Typography.Text>
        ) : null}
      </Space>

      <Card size="small" style={{ marginBottom: 12 }}>
        {loading && !data ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : (
          <>
            <div style={{ width: "100%", height: 300 }}>
              <ResponsiveContainer>
                <BarChart data={chartRows} layout="vertical" margin={{ top: 8, right: 96, left: 8, bottom: 8 }}>
                  <XAxis type="number" tickFormatter={(v: number) => qty(v)} />
                  <YAxis type="category" dataKey="label" width={64} />
                  <Tooltip
                    formatter={(v: unknown) => [qty(Number(v)), "数量"] as [string, string]}
                    labelFormatter={(l: React.ReactNode) => `${String(l)}级`}
                  />
                  <Bar dataKey="qty" barSize={30} isAnimationActive={false}>
                    {chartRows.map((r) => (
                      <Cell key={r.key} fill={STAGE_COLOR[r.key]} />
                    ))}
                    <LabelList
                      dataKey="qty"
                      position="right"
                      formatter={(v: unknown) => qty(Number(v))}
                      style={{ fontSize: 12, fill: "#595959" }}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {/* 级间转化率链（图内不便叠标，单独一行看得清） */}
            <Space size={4} wrap style={{ marginTop: 4 }}>
              {data?.stages.map((s, i) => {
                const c = data.conversions.find((x) => x.from === s.key);
                return (
                  <span key={s.key} style={{ fontSize: 13 }}>
                    <Tag color={STAGE_COLOR[s.key]} style={{ marginInlineEnd: 4 }}>{s.label}</Tag>
                    {i < data.stages.length - 1 ? (
                      <Typography.Text type={c?.rate == null ? "secondary" : undefined} style={{ marginInlineEnd: 4 }}>
                        —— {c?.rate == null ? "不计算" : pct(c.rate)} →
                      </Typography.Text>
                    ) : null}
                  </span>
                );
              })}
            </Space>
          </>
        )}
      </Card>

      <Space size={12} wrap style={{ marginBottom: 12 }}>
        {(data?.stages ?? []).map((s) => (
          <Card key={s.key} size="small" style={{ minWidth: 150 }}>
            <Statistic title={s.label} value={s.qty} formatter={() => qty(s.qty)} valueStyle={{ color: STAGE_COLOR[s.key] }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.docCount.toLocaleString("zh-CN")} 单/条</Typography.Text>
          </Card>
        ))}
      </Space>

      <Table<FunnelStage>
        rowKey="key"
        size="middle"
        columns={columns}
        dataSource={data?.stages ?? []}
        loading={loading}
        pagination={false}
        scroll={{ x: "max-content" }}
      />
    </div>
  );
}
