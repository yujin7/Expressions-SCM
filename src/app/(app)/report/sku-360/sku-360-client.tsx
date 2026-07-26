"use client";

import SearchInput from "@/components/SearchInput";

/** SKU 360 · 事件时间轴——单 SKU 全生命周期事件融合（只读）。
 *  四源：库存流水 × 在途存量单 × 效期批次 × 处置决定。 */
import { useCallback, useEffect, useState } from "react";
import { App, Empty, Space, Spin, Tag, Timeline, Typography } from "antd";
import { fetchJson } from "@/components/fetchJson";

type TimelineCategory = "stock" | "order" | "expiry" | "disposal" | "other";

interface TimelineEvent {
  date: string;
  type: string;
  category: TimelineCategory;
  title: string;
  detail: string | null;
  qty: number | null;
}

interface SkuTimeline {
  sku: { id: number; code: string; name: string };
  events: TimelineEvent[];
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
  const [searched, setSearched] = useState(false);

  const load = useCallback(
    async (sku: string) => {
      const code = sku.trim();
      if (!code) return;
      setLoading(true);
      setSearched(true);
      try {
        setData(await fetchJson<SkuTimeline>(`/api/report/sku-timeline?sku=${encodeURIComponent(code)}`));
      } catch (e) {
        setData(null);
        message.error((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [message],
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

      {data ? (
        <Typography.Paragraph>
          <Typography.Text strong>{data.sku.code}</Typography.Text>
          <Typography.Text style={{ marginLeft: 8 }}>{data.sku.name || "—"}</Typography.Text>
          <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
            共 {data.events.length} 条事件
          </Typography.Text>
        </Typography.Paragraph>
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
                  <Typography.Text>{e.title}</Typography.Text>
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
      ) : searched ? (
        <Empty description={data ? "该 SKU 暂无事件" : "未找到数据"} />
      ) : null}
    </div>
  );
}
