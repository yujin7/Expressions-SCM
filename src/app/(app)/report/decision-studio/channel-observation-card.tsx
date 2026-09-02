"use client";

/**
 * 全渠道外部观察（近 30 天）：天猫 / 拼多多 / 唯品会 同一张表，加天猫宝贝损益 Top/Bottom。
 * 观察口径，只做"盘子有多大、谁在赚谁在亏"的旁证，不进入任何自动决策。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Col, Row, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import { VISUAL_COLOR } from "@/components/decision-visuals";
import type { ChannelObservation, ChannelPlatformRow, ProductPnlRow } from "@/server/modules/report/channel-observation";

function yuan(value: string | null | undefined): string {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

export default function ChannelObservationCard({ active }: { active: boolean }) {
  const { message } = App.useApp();
  const [data, setData] = useState<ChannelObservation | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchJson<ChannelObservation>("/api/report/channel-observation"));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);
  useEffect(() => { if (active && !data) void load(); }, [active, data, load]);

  const platformCols: ColumnsType<ChannelPlatformRow> = [
    { title: "平台", dataIndex: "platform", width: 90, render: (v: string, r) => <Space size={6}><Typography.Text strong>{v}</Typography.Text><Tag color={r.state === "ready" ? "success" : "default"}>{r.state === "ready" ? "有数" : "缺流"}</Tag></Space> },
    { title: "窗口", key: "window", width: 200, render: (_, r) => r.anchorDate ? `${r.windowFrom} ～ ${r.anchorDate}` : <Typography.Text type="secondary">—</Typography.Text> },
    { title: "近30天件数", dataIndex: "units", width: 120, align: "right", render: (v: number | null) => v == null ? "—" : v.toLocaleString("zh-CN") },
    { title: "近30天金额", dataIndex: "amount", width: 120, align: "right", render: (v: string | null) => v == null ? <Typography.Text type="secondary">无金额字段</Typography.Text> : `¥${yuan(v)}` },
    { title: "退款件数", dataIndex: "refundUnits", width: 100, align: "right", render: (v: number | null) => v == null ? "—" : v.toLocaleString("zh-CN") },
    { title: "按品牌", key: "brand", render: (_, r) => r.byBrand.length ? r.byBrand.slice(0, 5).map((b) => `${b.brand} ${b.units.toLocaleString("zh-CN")}`).join(" · ") : "—" },
    { title: "口径", dataIndex: "gate", ellipsis: true },
  ];
  const pnlCols: ColumnsType<ProductPnlRow> = [
    { title: "店铺 / 商品", key: "p", ellipsis: true, render: (_, r) => <Space direction="vertical" size={0}><Typography.Text ellipsis={{ tooltip: r.productName ?? "" }} style={{ maxWidth: 320 }}>{r.productName ?? r.platformProductId}</Typography.Text><Typography.Text type="secondary">{r.shopName} · {r.platformProductId}</Typography.Text></Space> },
    { title: "真实成交", dataIndex: "actualTransactionAmount", width: 110, align: "right", render: (v: string) => `¥${yuan(v)}` },
    { title: "销售费用", dataIndex: "totalSalesCost", width: 110, align: "right", render: (v: string) => `¥${yuan(v)}` },
    { title: "预估净利", dataIndex: "estimatedNetProfit", width: 110, align: "right", render: (v: string) => <Typography.Text type={Number(v) < 0 ? "danger" : undefined} strong>¥{yuan(v)}</Typography.Text> },
    { title: "支付件数", dataIndex: "paidNumber", width: 90, align: "right" },
  ];
  const pnl = data?.productPnl;
  return (
    <Card
      size="small"
      title={`全渠道外部观察 · 近 ${data?.windowDays ?? 30} 天`}
      extra={<Space><Tag color="warning">观察口径</Tag><Button size="small" onClick={() => void load()} loading={loading}>刷新</Button></Space>}
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Table<ChannelPlatformRow> rowKey="platform" size="small" loading={loading} pagination={false} columns={platformCols} dataSource={data?.platforms ?? []} scroll={{ x: 1100 }} />
        {pnl ? (
          <Card size="small" title="天猫宝贝损益（平台预估，近 30 天）" extra={<Tag color={pnl.state === "ready" ? "success" : "default"}>{pnl.anchorDate ? `截至 ${pnl.anchorDate}` : "缺流"}</Tag>}>
            <Row gutter={[10, 10]} className="compact-kpi-row">
              <Col xs={12} lg={6}><Card size="small"><Statistic title="真实成交" value={`¥${yuan(pnl.totals.actualTransactionAmount)}`} /></Card></Col>
              <Col xs={12} lg={6}><Card size="small"><Statistic title="销售费用" value={`¥${yuan(pnl.totals.totalSalesCost)}`} /></Card></Col>
              <Col xs={12} lg={6}><Card size="small"><Statistic title="预估毛利" value={`¥${yuan(pnl.totals.estimatedGrossProfit)}`} /></Card></Col>
              <Col xs={12} lg={6}><Card size="small"><Statistic title="预估净利" value={`¥${yuan(pnl.totals.estimatedNetProfit)}`} valueStyle={{ color: Number(pnl.totals.estimatedNetProfit) < 0 ? VISUAL_COLOR.warning : VISUAL_COLOR.positive }} /></Card></Col>
            </Row>
            <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
              <Col xs={24} xl={12}><Typography.Text strong>净利最高 10 个商品</Typography.Text><Table<ProductPnlRow> rowKey={(r) => `${r.shopName}|${r.platformProductId}`} size="small" pagination={false} columns={pnlCols} dataSource={pnl.topNetProfit} /></Col>
              <Col xs={24} xl={12}><Typography.Text strong>净利为负的商品（最亏在前）</Typography.Text><Table<ProductPnlRow> rowKey={(r) => `${r.shopName}|${r.platformProductId}`} size="small" pagination={false} columns={pnlCols} dataSource={pnl.bottomNetProfit} /></Col>
            </Row>
            <Alert type="info" showIcon style={{ marginTop: 12 }} message={pnl.gate} />
          </Card>
        ) : null}
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {(data?.limitations ?? []).map((l) => <div key={l}>· {l}</div>)}
        </Typography.Paragraph>
      </Space>
    </Card>
  );
}
