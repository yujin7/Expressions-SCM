"use client";

/**
 * E6-P3 迷你 360 悬停速览：全站 SKU 编码链接的"即时之窗"。
 * 悬停 0.4s 才拉数（懒加载），模块级 Map 缓存 60s——同页多次悬停同一编码不重复请求。
 * 点击行为不变（仍跳 /inventory/balance?q=CODE），hover 只是叠加信息层。
 */
import { useCallback, useState } from "react";
import { Popover, Spin, Tag, Typography } from "antd";
import { Line, LineChart, ResponsiveContainer, Tooltip as RTooltip } from "recharts";
import { fetchJson } from "@/components/fetchJson";
import { LIFECYCLE_LABELS } from "@/components/format";
import { SKU_TYPE_LABELS } from "@/components/labels";

export interface SkuBriefDto {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  baseUom: string;
  skuType: string;
  lifecycle: string | null;
  active: boolean;
  onHand: number;
  daily: number;
  daysCover: number | null;
  leadDays: number | null;
  minDaysLeft: number | null;
  nearExpiryDays: number;
  openSupply: number;
  spark: { ym: string; qty: number }[];
}

/** 模块作用域缓存：code → {至 60s 后失效的数据 | 进行中的 Promise} */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; data?: SkuBriefDto; p?: Promise<SkuBriefDto> }>();

function loadBrief(code: string): Promise<SkuBriefDto> {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < TTL_MS) {
    if (hit.data) return Promise.resolve(hit.data);
    if (hit.p) return hit.p; // 并发悬停合流，不重复发请求
  }
  const p = fetchJson<SkuBriefDto>(`/api/master/sku-brief?sku=${encodeURIComponent(code)}`)
    .then((d) => {
      cache.set(code, { at: Date.now(), data: d });
      return d;
    })
    .catch((e) => {
      cache.delete(code); // 失败不缓存，下次悬停可重试
      throw e;
    });
  cache.set(code, { at: Date.now(), p });
  return p;
}

const nf = (v: number | null | undefined): string =>
  v == null ? "—" : v.toLocaleString("zh-CN", { maximumFractionDigits: 1 });

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ minWidth: 78 }}>
      <div style={{ fontSize: 11, color: "#8c8c8c", lineHeight: "16px" }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, lineHeight: "20px" }}>
        {value}
        {hint ? <span style={{ fontSize: 11, fontWeight: 400, color: "#8c8c8c" }}> {hint}</span> : null}
      </div>
    </div>
  );
}

function BriefBody({ data }: { data: SkuBriefDto }) {
  const expired = data.minDaysLeft != null && data.minDaysLeft <= 0;
  const near = data.minDaysLeft != null && data.minDaysLeft > 0 && data.minDaysLeft <= data.nearExpiryDays;
  const hasSales = data.spark.some((p) => p.qty > 0);
  const cq = encodeURIComponent(data.code);
  return (
    <div style={{ width: 300, fontSize: 12 }}>
      <div style={{ marginBottom: 6 }}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          {data.code}
        </Typography.Text>
        <div style={{ color: "#595959", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={data.name}>
          {data.name || "—"}
        </div>
      </div>
      <div style={{ marginBottom: 8 }}>
        {data.brand ? <Tag style={{ fontSize: 11, marginInlineEnd: 4 }}>{data.brand}</Tag> : null}
        <Tag style={{ fontSize: 11, marginInlineEnd: 4 }}>{SKU_TYPE_LABELS[data.skuType] ?? data.skuType}</Tag>
        {data.lifecycle ? (
          <Tag color="blue" style={{ fontSize: 11, marginInlineEnd: 4 }}>
            {LIFECYCLE_LABELS[data.lifecycle] ?? data.lifecycle}
          </Tag>
        ) : null}
        {!data.active ? (
          <Tag color="red" style={{ fontSize: 11, marginInlineEnd: 0 }}>
            已停用
          </Tag>
        ) : null}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", rowGap: 6, columnGap: 8, marginBottom: 6 }}>
        <Metric label="全网在库" value={nf(data.onHand)} hint={data.baseUom} />
        <Metric label="日均销" value={nf(data.daily)} />
        <Metric label="可销天数" value={data.daysCover == null ? "无动销" : nf(data.daysCover)} hint={data.daysCover == null ? undefined : "天"} />
        <Metric label="未结供给" value={nf(data.openSupply)} hint={data.baseUom} />
        <Metric label="生产周期" value={data.leadDays == null ? "未维护" : String(data.leadDays)} hint={data.leadDays == null ? undefined : "天"} />
      </div>
      {expired ? (
        <div style={{ color: "#cf1322", marginBottom: 6 }}>已过期 {Math.abs(data.minDaysLeft as number)} 天（最早批次）</div>
      ) : near ? (
        <div style={{ color: "#fa8c16", marginBottom: 6 }}>
          最短剩余效期 {data.minDaysLeft} 天（阈值 {data.nearExpiryDays} 天）
        </div>
      ) : null}
      <div
        style={{ height: 48, marginBottom: 6 }}
        role={hasSales ? "img" : undefined}
        aria-label={hasSales ? `${data.code} 近 ${data.spark.length} 个月销量趋势：${data.spark.map((point) => `${point.ym} ${nf(point.qty)}`).join("，")}` : undefined}
      >
        {hasSales ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.spark} margin={{ top: 4, right: 2, left: 2, bottom: 0 }}>
              <RTooltip
                contentStyle={{ fontSize: 11, padding: "2px 6px" }}
                formatter={(v) => [nf(Number(v)), "月销"]}
                labelFormatter={(l) => String(l)}
              />
              <Line type="monotone" dataKey="qty" stroke="#1677ff" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ color: "#bfbfbf", lineHeight: "48px", textAlign: "center" }}>近 6 月无销量记录</div>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, borderTop: "1px solid #f0f0f0", paddingTop: 6 }}>
        <a href={`/report/sku-360?q=${cq}`}>SKU 360</a>
        <a href={`/replenish?q=${cq}`}>未来曲线</a>
        <a href={`/inventory/expiry?q=${cq}`}>效期批次</a>
      </div>
    </div>
  );
}

export default function SkuHoverCard({ code, children }: { code: string; children?: React.ReactNode }) {
  const [data, setData] = useState<SkuBriefDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open || !code || data || loading) return;
      setFailed(false);
      setLoading(true);
      loadBrief(code)
        .then((d) => setData(d))
        .catch(() => setFailed(true))
        .finally(() => setLoading(false));
    },
    [code, data, loading],
  );

  const content = failed ? (
    <div style={{ width: 300, fontSize: 12, color: "#cf1322" }}>加载失败</div>
  ) : data ? (
    <BriefBody data={data} />
  ) : (
    <div style={{ width: 300, textAlign: "center", padding: "12px 0" }}>
      <Spin size="small" />
    </div>
  );

  return (
    <Popover trigger="hover" mouseEnterDelay={0.4} placement="rightTop" content={content} onOpenChange={onOpenChange}>
      {children ?? <a href={`/inventory/balance?q=${encodeURIComponent(code)}`}>{code}</a>}
    </Popover>
  );
}
