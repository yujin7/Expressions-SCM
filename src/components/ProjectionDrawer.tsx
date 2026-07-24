"use client";

/** #1 库存未来曲线抽屉：projected on-hand 逐日曲线 + 断货日/建议下单日标注（对标 Kinaxis projected on-hand）。 */
import { useEffect, useState } from "react";
import { Alert, App, Drawer, Empty, Space, Spin, Statistic, Tag, Typography } from "antd";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchJson } from "@/components/fetchJson";

interface Point { date: string; onHand: number; arrival: number }
interface Projection {
  skuId: number; code: string; name: string;
  startOnHand: number; daily: number; leadDays: number | null; undatedInbound: number; today: string;
  points: Point[];
  stockoutDate: string | null; daysToStockout: number | null;
  orderByDate: string | null; orderWindowMissed: boolean;
}

export default function ProjectionDrawer({
  skuCode,
  open,
  onClose,
}: {
  skuCode: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [data, setData] = useState<Projection | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !skuCode) return;
    setLoading(true);
    setData(null);
    fetchJson<Projection>(`/api/replenish/projection?sku=${encodeURIComponent(skuCode)}&horizon=120`)
      .then(setData)
      .catch((e) => message.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [open, skuCode, message]);

  return (
    <Drawer
      title={data ? `库存未来曲线 · ${data.code} ${data.name}` : "库存未来曲线"}
      open={open}
      onClose={onClose}
      width="min(920px, 100vw)"
    >
      {loading ? (
        <div style={{ textAlign: "center", padding: 60 }}><Spin /></div>
      ) : !data ? (
        <Empty description="无数据" />
      ) : (
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Space size="large" wrap>
            <Statistic title="当前在库（全网）" value={data.startOnHand} />
            <Statistic title="日均消耗" value={data.daily} />
            <Statistic
              title="预计断货"
              value={data.stockoutDate ?? "120天内不断货"}
              valueStyle={{ color: data.stockoutDate ? "#cf1322" : "#3f8600", fontSize: 18 }}
              suffix={data.daysToStockout != null ? `（${data.daysToStockout}天后）` : ""}
            />
            <Statistic
              title="最晚下单日"
              value={data.orderByDate ?? "—"}
              valueStyle={{ color: data.orderWindowMissed ? "#cf1322" : undefined, fontSize: 18 }}
            />
          </Space>
          {data.orderWindowMissed ? (
            <Alert type="error" showIcon message={`已错过下单窗口：生产周期 ${data.leadDays} 天，现在下单也赶不上断货日 ${data.stockoutDate}——建议紧急插单或调货。`} />
          ) : data.stockoutDate && data.orderByDate ? (
            <Alert type="warning" showIcon message={`须在 ${data.orderByDate} 前下单（断货日 ${data.stockoutDate} 倒推生产周期 ${data.leadDays} 天）。`} />
          ) : data.stockoutDate ? (
            <Alert type="warning" showIcon message={`预计 ${data.stockoutDate} 断货${data.daysToStockout != null ? `（${data.daysToStockout} 天后）` : ""}；该 SKU 无生产周期记录，无法倒推下单日——建议补录生产周期。`} />
          ) : (
            <Alert type="success" showIcon message="120 天视野内不断货。" />
          )}
          {data.undatedInbound > 0 ? (
            <Alert
              type="info"
              showIcon
              message={`另有 ${data.undatedInbound.toLocaleString("zh-CN")} 在途量无确认到货日，未计入曲线（补录 PO 预计到货日后可纳入推演）。`}
            />
          ) : null}
          <div style={{ width: "100%", height: 320 }}>
            <ResponsiveContainer>
              <AreaChart data={data.points} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="ohFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#1677ff" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#1677ff" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={40} />
                <YAxis tick={{ fontSize: 11 }} width={56} />
                <RTooltip
                  formatter={(v) => [Number(v).toLocaleString("zh-CN"), "投影在库"]}
                  labelFormatter={(l) => `日期 ${l}`}
                />
                <ReferenceLine y={0} stroke="#cf1322" strokeDasharray="4 2" />
                {data.stockoutDate ? <ReferenceLine x={data.stockoutDate} stroke="#cf1322" label={{ value: "断货", fontSize: 11, fill: "#cf1322" }} /> : null}
                {data.orderByDate && !data.orderWindowMissed ? <ReferenceLine x={data.orderByDate} stroke="#fa8c16" label={{ value: "下单", fontSize: 11, fill: "#fa8c16" }} /> : null}
                <Area type="monotone" dataKey="onHand" stroke="#1677ff" fill="url(#ohFill)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            口径：投影在库 = 当前在库 + 各日到货（有确认到货日的 PO/存量在途）− 日均消耗；曲线可为负（真实缺口，不夹到 0）。基准日 {data.today}。
          </Typography.Text>
        </Space>
      )}
    </Drawer>
  );
}
