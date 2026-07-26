"use client";

import SearchInput from "@/components/SearchInput";

/** E7-05 预测复盘：滚动回测线上 Holt 算法——不存历史预测也能回答「准不准」 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Card, Col, Row, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { fetchJson } from "@/components/fetchJson";
import DecisionVisual from "@/components/DecisionVisual";
import { VISUAL_COLOR } from "@/components/decision-visuals";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import SkuHoverCard from "@/components/SkuHoverCard";

interface Point { ym: string; actual: number; forecast: number; error: number; ape: number | null }
interface Row0 {
  skuId: number; code: string; name: string; brand: string | null;
  n: number; mape: number | null; wape: number | null; bias: number | null;
  hitRate: number | null; reliable: boolean; biasText: string; points: Point[];
  naiveWape: number | null; fva: number | null; fvaText: string;
}
interface Data {
  rows: Row0[];
  total: number;
  summary: {
    evaluated: number; overallWape: number | null; overallBias: number | null;
    overallBiasText: string; overCount: number; underCount: number; months: string[];
    overallNaiveWape: number | null; overallFva: number | null;
    overallFvaText: string; worseThanNaiveCount: number;
  };
}

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

export default function ForecastAccuracyClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ key: "forecast-accuracy", defaults: { q: "", onlyReliable: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const onlyReliable = filters.onlyReliable === "1";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (onlyReliable) p.set("onlyReliable", "1");
      setData(await fetchJson<Data>(`/api/report/forecast-accuracy?${p.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, onlyReliable, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const s = data?.summary;
  const columns: ColumnsType<Row0> = [
    {
      title: "SKU 编码", dataIndex: "code", width: 130,
      render: (v: string) => (
        <SkuHoverCard code={v}>
          <a href={`/report/sku-360?sku=${encodeURIComponent(v)}`}>{v}</a>
        </SkuHoverCard>
      ),
    },
    { title: "名称", dataIndex: "name", ellipsis: true, width: 200 },
    { title: "品牌", dataIndex: "brand", width: 95, render: (v: string | null) => v ?? "—" },
    { title: "回测期数", dataIndex: "n", width: 90, align: "right", render: (v: number, r) => (r.reliable ? v : <Tooltip title="样本不足 3 期，结论参考价值有限"><span style={{ color: "#faad14" }}>{v} ⚠</span></Tooltip>) },
    {
      title: "WAPE", dataIndex: "wape", width: 95, align: "right",
      render: (v: number | null) => (
        <Tooltip title="加权绝对百分误差 = Σ|误差| / Σ实际——对零值稳健，稀疏序列更可信">
          <span style={{ color: v != null && v > 0.5 ? "#cf1322" : undefined }}>{pct(v)}</span>
        </Tooltip>
      ),
    },
    {
      title: "vs 朴素", dataIndex: "fva", width: 130, align: "right",
      render: (v: number | null, r) => (
        <Tooltip title={r.fvaText}>
          {v == null ? <span style={{ color: "#999" }}>—</span> : v < -0.02 ? (
            <Tag color="red" style={{ marginInlineEnd: 0 }}>做负功 {pct(Math.abs(v))}</Tag>
          ) : v > 0.02 ? (
            <Tag color="green" style={{ marginInlineEnd: 0 }}>优于 {pct(v)}</Tag>
          ) : (
            <Tag style={{ marginInlineEnd: 0 }}>持平</Tag>
          )}
        </Tooltip>
      ),
    },
    { title: "MAPE", dataIndex: "mape", width: 90, align: "right", render: (v: number | null) => pct(v) },
    {
      title: "偏差", dataIndex: "bias", width: 200,
      render: (_: unknown, r) => (
        <Tooltip title={r.biasText}>
          <Tag color={r.bias == null ? "default" : r.bias > 0.1 ? "orange" : r.bias < -0.1 ? "red" : "green"}>
            {r.bias == null ? "—" : `${r.bias > 0 ? "+" : ""}${(r.bias * 100).toFixed(1)}%`}
          </Tag>
        </Tooltip>
      ),
    },
    { title: "命中率(±20%)", dataIndex: "hitRate", width: 115, align: "right", render: (v: number | null) => pct(v) },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>预测复盘</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="滚动回测：对每个月只用「该月之前」的数据跑一次线上 Holt 预测，再与实际比较——复现了当时的信息集，比事后看更严格。"
        description={s ? <Typography.Text type="secondary">窗口 {s.months[0]} ~ {s.months[s.months.length - 1]}；可回测 {s.evaluated} 个成品；整体判定：{s.overallBiasText}</Typography.Text> : null}
      />
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col><Card size="small"><Statistic title="整体 WAPE" value={s?.overallWape != null ? (s.overallWape * 100).toFixed(1) : "—"} suffix="%" /></Card></Col>
        <Col>
          <Card size="small">
            <Tooltip title={s?.overallFvaText ?? ""}>
              <Statistic
                title="朴素基准 WAPE"
                value={s?.overallNaiveWape != null ? (s.overallNaiveWape * 100).toFixed(1) : "—"}
                suffix="%"
                valueStyle={{ color: (s?.overallFva ?? 0) < -0.02 ? "#cf1322" : (s?.overallFva ?? 0) > 0.02 ? "#3f8600" : undefined }}
              />
            </Tooltip>
          </Card>
        </Col>
        <Col><Card size="small"><Statistic title="预测做负功 SKU" value={s?.worseThanNaiveCount ?? 0} valueStyle={{ color: (s?.worseThanNaiveCount ?? 0) > 0 ? "#cf1322" : "#999" }} /></Card></Col>
        <Col><Card size="small"><Statistic title="整体偏差" value={s?.overallBias != null ? (s.overallBias * 100).toFixed(1) : "—"} suffix="%" valueStyle={{ color: (s?.overallBias ?? 0) > 0.1 ? "#fa8c16" : (s?.overallBias ?? 0) < -0.1 ? "#cf1322" : "#3f8600" }} /></Card></Col>
        <Col><Card size="small"><Statistic title="系统性高估 SKU" value={s?.overCount ?? 0} valueStyle={{ color: "#fa8c16" }} /></Card></Col>
        <Col><Card size="small"><Statistic title="系统性低估 SKU" value={s?.underCount ?? 0} valueStyle={{ color: "#cf1322" }} /></Card></Col>
      </Row>
      <ListToolbar
        state={listState}
        extra={
          <>
            <SearchInput
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索编码/名称"
              style={{ width: 240 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
            <Tag.CheckableTag
              checked={onlyReliable}
              onChange={(c) => listState.setFilter({ onlyReliable: c ? "1" : "" })}
              style={{ border: "1px solid #d9d9d9", padding: "2px 10px" }}
            >
              只看样本充足（≥3 期）
            </Tag.CheckableTag>
          </>
        }
      />
      <Table<Row0>
        rowKey="skuId"
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        expandable={{
          expandedRowRender: (r) => (
            <DecisionVisual
              title={`${r.code} 实际 vs 回测预测`}
              question="该 SKU 的预测在哪些月份偏离实际，偏差方向是否持续？"
              metricId="wape"
              grain="SKU × 月"
              unit="基础单位数量"
              source={{
                tier: "derived",
                source: "销售月事实滚动回测 Holt 预测",
                asOf: r.points.at(-1)?.ym,
              }}
              coverage={{ covered: r.n, total: Math.max(r.n, 3), label: "回测月份" }}
              summary={`${r.code} 回测 ${r.n} 期，WAPE ${pct(r.wape)}，偏差 ${pct(r.bias)}，${r.fvaText}。`}
              caveat="每月只使用此前月份训练；少于 3 个回测期时样本不足，不应据此切换算法。"
              state={r.points.length === 0 ? "empty" : r.reliable ? "ready" : "insufficient"}
              stateDetail={r.points.length === 0 ? "没有可回测月份。" : "回测期少于 3，暂不下可靠结论。"}
              height={210}
              dataView={
                <Table<Point>
                  rowKey="ym"
                  size="small"
                  pagination={false}
                  dataSource={r.points}
                  columns={[
                    { title: "月份", dataIndex: "ym" },
                    { title: "实际", dataIndex: "actual", align: "right" },
                    { title: "回测预测", dataIndex: "forecast", align: "right" },
                    { title: "误差", dataIndex: "error", align: "right" },
                  ]}
                />
              }
            >
              <ResponsiveContainer>
                <LineChart data={r.points} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <XAxis dataKey="ym" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={56} />
                  <RTooltip formatter={(v, n) => [Number(v).toLocaleString("zh-CN"), n === "actual" ? "实际" : "回测预测"]} />
                  <Line type="monotone" dataKey="actual" stroke={VISUAL_COLOR.primary} strokeWidth={2} dot={false} name="actual" />
                  <Line type="monotone" dataKey="forecast" stroke={VISUAL_COLOR.warning} strokeDasharray="4 2" strokeWidth={2} dot={false} name="forecast" />
                </LineChart>
              </ResponsiveContainer>
            </DecisionVisual>
          ),
        }}
        pagination={listState.paginationProps({ total: data?.total ?? 0 })}
      />
    </div>
  );
}
