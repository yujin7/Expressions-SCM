"use client";

import SearchInput from "@/components/SearchInput";

/** SKU 360 · 事件时间轴——单 SKU 全生命周期事件融合（只读）。
 *  四源：库存流水 × 在途存量单 × 效期批次 × 处置决定。
 *  2026-09-04：头部挂来源/截至芯片；每条事件回链来源单据或来源列表（服务端给 href）。 */
import { useCallback, useEffect, useState } from "react";
import { App, Empty, Space, Spin, Tag, Timeline, Tooltip, Typography } from "antd";
import { fetchJson } from "@/components/fetchJson";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { useLatestRead } from "@/components/useLatestRead";

type TimelineCategory = "stock" | "order" | "expiry" | "disposal" | "other";

interface TimelineEvent {
  date: string;
  type: string;
  category: TimelineCategory;
  title: string;
  detail: string | null;
  qty: number | null;
  href: string | null;
}

interface TimelineSource {
  key: string;
  label: string;
  events: number;
}

interface SkuTimeline {
  sku: { id: number; code: string; name: string };
  events: TimelineEvent[];
  sources: TimelineSource[];
  asOf: string;
  ledgerLimit: number;
}

const CATEGORY_COLORS: Record<TimelineCategory, string> = {
  stock: "blue",
  order: "cyan",
  expiry: "orange",
  disposal: "red",
  other: "gray",
};

export default function Sku360Client({ initialSku = "" }: { initialSku?: string }) {
  const { message } = App.useApp();
  const [data, setData] = useState<SkuTimeline | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [lastCode, setLastCode] = useState(initialSku);

  const beginLoadRead = useLatestRead();
  const load = useCallback(
    async (sku: string) => {
      const code = sku.trim();
      if (!code) return;
      const readRequest = beginLoadRead();
      setLoading(true);
      setData(null);
      setSearched(true);
      setLastCode(code);
      setLoadError(null);
      try {
        const result = await fetchJson<SkuTimeline>(`/api/report/sku-timeline?sku=${encodeURIComponent(code)}`, { signal: readRequest.signal });
        if (!readRequest.isCurrent()) return;
        setData(result);
      } catch (e) {
        if (!readRequest.isCurrent()) return;
        setData(null);
        setLoadError((e as Error).message);
        message.error((e as Error).message);
      } finally {
        if (readRequest.isCurrent()) setLoading(false);
      }
    },
    [beginLoadRead, message],
  );
  useEffect(() => {
    if (initialSku) void load(initialSku);
  }, [initialSku, load]);

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        SKU 360 · 事件时间轴
      </Typography.Title>
      <SearchInput
        allowClear
        enterButton
        defaultValue={initialSku}
        placeholder="输入 SKU 编码查看全生命周期事件"
        style={{ maxWidth: 420, marginBottom: 16 }}
        onSearch={(v) => void load(v)}
      />
      <LoadErrorAlert error={loadError} onRetry={() => void load(lastCode)} subject="SKU 事件轴" retrying={loading} />

      {data ? (
        <div style={{ marginBottom: 12 }}>
          <Typography.Paragraph style={{ marginBottom: 6 }}>
            <Typography.Text strong>{data.sku.code}</Typography.Text>
            <Typography.Text style={{ marginLeft: 8 }}>{data.sku.name || "—"}</Typography.Text>
            <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
              共 {data.events.length} 条事件
            </Typography.Text>
          </Typography.Paragraph>
          {/* 来源 / 截至芯片：四源各纳入多少条、数据截至哪一天——报表数字必须能回答「从哪来、多新」 */}
          <Space size={6} wrap className="sku-360-source-chips">
            <Tag color="geekblue">来源：{data.sources.map((s) => `${s.label} ${s.events}`).join(" × ")}</Tag>
            <Tooltip title={`事实表实时读取；库存流水只取最近 ${data.ledgerLimit} 条，更早的请到库存流水页查看`}>
              <Tag>截至 {data.asOf}</Tag>
            </Tooltip>
          </Space>
        </div>
      ) : null}

      {loading ? (
        <div style={{ padding: 40, textAlign: "center" }}>
          <Spin />
        </div>
      ) : data && data.events.length > 0 ? (
        <Timeline
          items={data.events.map((e) => ({
            color: CATEGORY_COLORS[e.category],
            children: (
              <div>
                <Space size={8} wrap>
                  <Typography.Text type="secondary">{e.date}</Typography.Text>
                  <Tag color={CATEGORY_COLORS[e.category]}>{e.type}</Tag>
                  {e.href ? (
                    <a href={e.href} title="查看来源单据 / 来源列表">{e.title}</a>
                  ) : (
                    <Typography.Text>{e.title}</Typography.Text>
                  )}
                  {e.qty != null ? (
                    <Typography.Text strong>{e.qty.toLocaleString("zh-CN")}</Typography.Text>
                  ) : null}
                </Space>
                {e.detail ? (
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {e.detail}
                    </Typography.Text>
                  </div>
                ) : null}
              </div>
            ),
          }))}
        />
      ) : searched && !loadError ? (
        <Empty description={data ? "该 SKU 暂无事件" : "未找到数据"} />
      ) : null}
    </div>
  );
}
