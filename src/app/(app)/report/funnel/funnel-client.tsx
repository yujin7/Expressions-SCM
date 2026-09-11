"use client";

import { useLatestRead } from "@/components/useLatestRead";

/**
 * E7-06 全链达成漏斗：需求 → 计划 → 下单 → 到货 → 动销 五级量级 + 级间转化率（只读）。
 * 横向条形（recharts layout="vertical"）看量级落差，条右侧标注到下一级的转化率；
 * 下方表格逐级列出量 / 单据数 / 取数口径——口径与时间窗不对齐的诚实标注在顶部 Alert。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Card, Radio, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fetchJson } from "@/components/fetchJson";
import DecisionVisual from "@/components/DecisionVisual";
import { formatQty } from "@/components/format";
import { useListState } from "@/components/useListState";

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

/** YYYY-MM → 该月首日 / 末日（纯字符串算术，不引入本地时区） */
const monthStart = (ym: string): string => `${ym}-01`;
const monthEnd = (ym: string): string => {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, "0")}`;
};

/**
 * 每一级数字回链到它的取数来源（口径见各级 note）：
 * 计划/下单/到货 = BH/WO/SH 列表按单据创建时间窗（from/to，上海业务日）筛选；
 * 需求 = 需求登记页；动销 = 经营分析总览。列表页不支持的筛选不假装带上。
 */
function stageHref(key: StageKey, data: FunnelData): string {
  const from = monthStart(data.docWindow.from);
  const to = monthEnd(data.docWindow.to);
  const window = `from=${from}&to=${to}`;
  switch (key) {
    case "demand": return "/report/demand";
    case "plan": return `/outsource/bh?${window}`;
    case "order": return `/outsource/wo?${window}`;
    case "receipt": return `/matflow/sh?${window}`;
    case "sales": return "/report/dashboard";
  }
}

export default function FunnelClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);
  const viewState = useListState({
    key: "funnel",
    defaults: { months: "3" },
    paginated: false,
  });
  const months = Number(viewState.filters.months) || 3;

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    try {
      const latestReadResult = await fetchJson<FunnelData>(`/api/report/funnel?months=${months}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setData(latestReadResult);
    } catch (e) {
      if (!readRequest.isCurrent()) return;
      message.error((e as Error).message);
    } finally {
      if (readRequest.isCurrent()) { setLoading(false); }
    }
  }, [beginLoadRead, months, message]);
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
        {data ? (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            自然月窗（需求/动销）：{data.monthList.length ? `${data.monthList[0]} ~ ${data.monthList[data.monthList.length - 1]}` : "无销量数据"}
            　单据创建时间窗（计划/下单/到货）：{data.docWindow.from} ~ {data.docWindow.to}
          </Typography.Text>
        ) : null}
      </Space>

      <div style={{ marginBottom: 12 }}>
        <DecisionVisual
          title="需求到动销的全链量级"
          question="从需求到最终动销，量级在哪一级出现最大落差？"
          metricId="flowStageQty"
          grain="流程阶段"
          unit="基础单位数量"
          source={{
            tier: "derived",
            source: "需求登记、BH/WO/PO、收货台账与销售月事实",
            asOf: data?.docWindow.to,
          }}
          coverage={{ covered: data?.stages.length ?? 0, total: 5, label: "流程阶段" }}
          activeFilters={[`近 ${months} 月`]}
          summary={data ? `${data.stages.map((stage) => `${stage.label} ${qty(stage.qty)}`).join("；")}。` : "全链数据尚未加载。"}
          caveat={data?.caveat ?? "各阶段时间窗与事实粒度不同，不是严格的一一转化或损耗率。"}
          state={loading && !data ? "loading" : chartRows.length === 0 ? "empty" : "ready"}
          stateDetail="当前窗口内没有可形成全链量级的数据。"
          height={360}
          extra={
            <Radio.Group
              value={String(months)}
              onChange={(event) => viewState.setFilter({ months: String(event.target.value) })}
              optionType="button"
              buttonStyle="solid"
              size="small"
              options={[
                { label: "3 月", value: "3" },
                { label: "6 月", value: "6" },
                { label: "12 月", value: "12" },
              ]}
            />
          }
          dataView={
            <Table<FunnelStage>
              rowKey="key"
              size="small"
              columns={columns}
              dataSource={data?.stages ?? []}
              pagination={false}
              scroll={{ x: "max-content", y: 250 }}
            />
          }
        >
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
        </DecisionVisual>
      </div>

      {/* 每级数字可点：回链到取数来源列表（BH/WO/SH 带单据创建时间窗 from/to），不再是死胡同 */}
      <Space className="compact-stat-strip" wrap>
        {data ? data.stages.map((s) => (
          <Card key={s.key} size="small">
            <a href={stageHref(s.key, data)} title={`查看「${s.label}」级来源明细`} style={{ display: "block" }}>
              <Statistic title={s.label} value={s.qty} formatter={() => qty(s.qty)} valueStyle={{ color: STAGE_COLOR[s.key] }} />
            </a>
            <Typography.Link href={stageHref(s.key, data)} style={{ fontSize: 12 }}>{s.docCount.toLocaleString("zh-CN")} 单/条 →</Typography.Link>
          </Card>
        )) : null}
      </Space>

    </div>
  );
}
