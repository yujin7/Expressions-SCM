"use client";

import { Col, Row, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { VISUAL_COLOR } from "@/components/decision-visuals";
import { formatCount, formatPct, formatYuan } from "@/components/format";
import type { Block } from "@/server/modules/report/cockpit";
import type { ChannelMatrixBlock, ChannelShopRow } from "@/server/modules/report/cockpit-trends";
import type { BrandPlatformRow, ChannelPlatform } from "@/server/modules/report/channel-observation";
import { metricLabel, Muted, TrendCard } from "./shared";

const PLATFORMS: ChannelPlatform[] = ["天猫", "拼多多", "唯品会"];

function GuessTag({ share }: { share: number | null }) {
  if (share == null) return <Tag>归属未知</Tag>;
  return <Tag color={share >= 20 ? "warning" : share > 0 ? "processing" : "success"}>店铺名猜测 {formatPct(share, 1)}</Tag>;
}

/** 渠道观察 · 品牌 × 平台矩阵（并列列，不跨平台相加；受限账号只见本渠道店铺行） */
export function ChannelMatrixCard({ block }: { block: Block<ChannelMatrixBlock> }) {
  const d = block.data;
  const matrixCols: ColumnsType<BrandPlatformRow> = [
    { title: "品牌", dataIndex: "brand", width: 140, fixed: "left" },
    ...PLATFORMS.map((p) => ({
      title: p, key: p, align: "right" as const, width: 170,
      render: (_: unknown, r: BrandPlatformRow) => {
        const cell = r.platforms[p];
        if (!cell || cell.units == null) return <Typography.Text type="secondary">缺流</Typography.Text>;
        return <span>{formatCount(cell.units)} 件{cell.amount != null ? <Typography.Text type="secondary"> · {formatYuan(cell.amount)}</Typography.Text> : null}</span>;
      },
    })),
  ];
  const shopCols: ColumnsType<ChannelShopRow> = [
    { title: "平台", dataIndex: "platform", width: 80 },
    { title: "店铺", dataIndex: "shop", ellipsis: true },
    { title: "近 30 天件数", dataIndex: "units", align: "right", width: 120, render: (v: number) => formatCount(v) },
    { title: "金额", dataIndex: "amount", align: "right", width: 120, render: (v: string | null) => v == null ? <Typography.Text type="secondary">—</Typography.Text> : formatYuan(v) },
  ];
  return (
    <TrendCard
      block={block}
      title={`${metricLabel("channelBrandUnits", "品牌 × 平台件数")} · 近 30 天`}
      question="哪个品牌 × 平台组合在扛量？其中有多少归属是猜出来的而不是映射出来的？"
      metricId="channelBrandUnits"
      grain="品牌 × 平台（件数按各平台口径）"
      unit="各平台口径件数（不相加）"
      contentIsTable
      fitContent
      height={260}
      summary={d ? (d.platforms ? `${d.platforms.map((p) => `${p.platform} ${p.state === "ready" ? `${formatCount(p.units)} 件（猜测 ${formatPct(p.nameGuessSharePct, 1)}）` : "缺流"}`).join("；")}；矩阵 ${d.brandMatrix?.length ?? 0} 个品牌` : `本渠道范围店铺 ${d.shops.length} 家（未映射店铺 ${d.unmappedShops} 家已剔除）`) : "无数据"}
    >
      {(data) => (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Space wrap size={[6, 4]}>
            <Tag color="blue">观察口径 · 不进过账不进补货</Tag>
            {data.scope.forced ? <Tag color="warning">受限渠道范围：只显示映射到本渠道的店铺行，跨店铺品牌矩阵不下发（D62）</Tag> : null}
          </Space>
          {data.platforms ? (
            <Row gutter={[12, 12]}>
              {data.platforms.map((p) => (
                <Col xs={24} md={8} key={p.platform}>
                  <Statistic title={`${p.platform}（${p.grain}）`} value={p.state === "ready" ? formatCount(p.units) : "缺流"} suffix={p.state === "ready" ? "件" : ""} valueStyle={{ fontSize: 20, color: p.state === "ready" ? undefined : VISUAL_COLOR.neutral }} />
                  <Space wrap size={[4, 4]}>
                    <GuessTag share={p.nameGuessSharePct} />
                    {p.refundUnits != null ? <Tag>退款 {formatCount(p.refundUnits)}</Tag> : null}
                    {p.amount != null ? <Tag>{formatYuan(p.amount)}</Tag> : null}
                    {p.sourceAsOf ? <Tag>截至 {p.sourceAsOf}</Tag> : null}
                  </Space>
                  <Muted>{p.state === "ready" ? `归属：映射 SKU ${p.attribution.mappedSku} · 店铺档案 ${p.attribution.shopMaster} · 店铺名猜测 ${p.attribution.nameGuess} · 未归属 ${p.attribution.unattributed}` : p.gate}</Muted>
                </Col>
              ))}
            </Row>
          ) : null}
          {data.brandMatrix ? (
            <Table<BrandPlatformRow> rowKey="brand" size="small" pagination={{ pageSize: 15, size: "small" }} scroll={{ x: 680 }} dataSource={data.brandMatrix} columns={matrixCols} />
          ) : null}
          {data.shops.length ? (
            <div>
              <Typography.Text strong style={{ fontSize: 12 }}>店铺行{data.scope.forced ? "（本渠道范围）" : ""}</Typography.Text>
              <Table<ChannelShopRow> rowKey={(r) => `${r.platform}|${r.shop}`} size="small" pagination={{ pageSize: 10, size: "small" }} dataSource={data.shops} columns={shopCols} />
            </div>
          ) : null}
          <Muted>件数口径按平台各异（天猫 = 支付 − 成功退款子订单；拼多多 = 有效订单件数；唯品会 = 销售量），列并列不相加；店铺名猜测占比越高，品牌行越不可靠。</Muted>
        </Space>
      )}
    </TrendCard>
  );
}
