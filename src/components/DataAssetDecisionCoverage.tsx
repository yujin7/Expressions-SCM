"use client";

import { useMemo } from "react";
import { ArrowRightOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Col, Progress, Row, Space, Table, Tag, Tooltip, Typography } from "antd";

import {
  buildDataAssetDecisionPortfolio,
  type DataAssetDecisionCoverageRow,
  type DataAssetDecisionState,
  type DataAssetImplementationState,
} from "@/components/data-asset-decision-coverage";
import { DATA_PRODUCTS } from "@/components/data-products";
import type { DataSourceReadiness } from "@/server/modules/report/data-source-readiness";
import type { DataProductReleaseReadiness } from "@/server/modules/report/data-product-release";

const STATE_META: Record<DataAssetDecisionState, { label: string; color: string }> = {
  degraded: { label: "当前受限", color: "error" },
  stale: { label: "业务过期", color: "warning" },
  missing: { label: "尚无证据", color: "default" },
  observation: { label: "可解释·仅观察", color: "gold" },
  current: { label: "当前可用", color: "success" },
};

const STATE_ORDER: Record<DataAssetDecisionState, number> = {
  degraded: 0,
  stale: 1,
  missing: 2,
  observation: 3,
  current: 4,
};

const IMPLEMENTATION_META: Record<DataAssetImplementationState, { label: string; color: string }> = {
  implemented: { label: "读取契约已实现", color: "blue" },
  planned: { label: "仅目标·待实现", color: "volcano" },
  unknown: { label: "旧载荷未声明", color: "default" },
};

function pct(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 100);
}

function evidenceLabel(row: DataAssetDecisionCoverageRow): string {
  if (!row.evidence?.lastSuccessAt) return "无成功业务批次";
  const asOf = row.evidence.sourceAsOf ?? "截止日未提供";
  const selection = row.evidence.selectedForSync === false ? "未选定时同步 · " : "";
  return `${selection}${asOf} · ${row.evidence.sourceRows.toLocaleString("zh-CN")} 源行`;
}

function uniqueOwners(row: DataAssetDecisionCoverageRow): string[] {
  return [...new Set(row.dependencies.map((item) => item.owner))];
}

export default function DataAssetDecisionCoverage({
  dataSources,
  dataProductReleases,
}: {
  dataSources: DataSourceReadiness[];
  dataProductReleases: DataProductReleaseReadiness[];
}) {
  const portfolio = useMemo(
    () => buildDataAssetDecisionPortfolio(DATA_PRODUCTS, dataSources, dataProductReleases),
    [dataSources, dataProductReleases],
  );

  return (
    <Card
      size="small"
      title="数据资产 → 业务决策覆盖图"
      style={{ marginTop: 16 }}
      extra={(
        <Space size={4} wrap>
          <Tag color="blue">目录资产 {portfolio.requiredAssetCount}</Tag>
          <Tag color="cyan">读取已实现 {portfolio.implementedAssetCount}</Tag>
          <Tag color={portfolio.plannedAssetCount > 0 ? "volcano" : "default"}>
            待实现 {portfolio.plannedAssetCount}
          </Tag>
          <Tag color={portfolio.unusedObservedCount > 0 ? "gold" : "default"}>
            已读取未编入 {portfolio.unusedObservedCount}
          </Tag>
        </Space>
      )}
    >
      <Alert
        banner
        showIcon
        type="info"
        message={`目录所需 ${portfolio.requiredAssetCount} 条外部资产中，${portfolio.implementedAssetCount} 条已有受控读取契约、${portfolio.plannedAssetCount} 条仍只有目标定义；当前 ${portfolio.explanationUsableCount} 条可用于带口径解释，${portfolio.operationalReadyCount} 条满足运营就绪。`}
        description={`每条 API 数据流都反向关联到使用它的产品、决策、Owner 和 SLA；${portfolio.affectedProductCount} 个数据产品仍受门禁影响。成功但无人使用的数据会单独暴露，未实现契约不会被误报成“只差授权”。`}
        style={{ marginBottom: 12 }}
      />
      <Row gutter={[10, 10]} style={{ marginBottom: 12 }}>
        {portfolio.sources.map((source) => (
          <Col xs={24} md={8} key={source.source}>
            <Card size="small" styles={{ body: { padding: 12 } }}>
              <Space direction="vertical" size={5} style={{ width: "100%" }}>
                <Space style={{ width: "100%", justifyContent: "space-between" }}>
                  <Typography.Text strong>{source.sourceLabel}</Typography.Text>
                  <Typography.Text type="secondary">影响 {source.affectedProductCount} 个产品</Typography.Text>
                </Space>
                <div>
                  <Typography.Text type="secondary">可解释资产</Typography.Text>
                  <Progress
                    size="small"
                    percent={pct(source.explanationUsableCount, source.requiredAssetCount)}
                    format={() => `${source.explanationUsableCount}/${source.requiredAssetCount}`}
                  />
                </div>
                <Typography.Text type="secondary">
                  读取已实现 {source.implementedAssetCount}/{source.requiredAssetCount}
                  {source.plannedAssetCount > 0 ? ` · 待实现 ${source.plannedAssetCount}` : ""}
                </Typography.Text>
                <Typography.Text type="secondary">
                  运营就绪 {source.operationalReadyCount}/{source.requiredAssetCount}
                  {source.unusedObservedCount > 0 ? ` · 已读取未编入 ${source.unusedObservedCount}` : ""}
                </Typography.Text>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>
      <Table
        rowKey="key"
        size="small"
        dataSource={portfolio.rows}
        pagination={{ pageSize: 8, showSizeChanger: false, hideOnSinglePage: true }}
        scroll={{ x: 1_210 }}
        showSorterTooltip={{ target: "sorter-icon" }}
        columns={[
          {
            title: "来源 / 数据资产",
            key: "asset",
            width: 230,
            fixed: "left",
            sorter: (a, b) => a.sourceLabel.localeCompare(b.sourceLabel, "zh-CN")
              || a.streamLabel.localeCompare(b.streamLabel, "zh-CN"),
            render: (_, row) => (
              <Space direction="vertical" size={1}>
                <Typography.Text strong>{row.streamLabel}</Typography.Text>
                <Typography.Text type="secondary">{row.sourceLabel} · {row.stream}</Typography.Text>
              </Space>
            ),
          },
          {
            title: "当前证据",
            key: "state",
            width: 190,
            sorter: (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state],
            render: (_, row) => (
              <Space direction="vertical" size={2}>
                <Tag color={IMPLEMENTATION_META[row.implementationState].color}>
                  {IMPLEMENTATION_META[row.implementationState].label}
                </Tag>
                <Tag color={STATE_META[row.state].color}>{STATE_META[row.state].label}</Tag>
                <Typography.Text type="secondary">{evidenceLabel(row)}</Typography.Text>
              </Space>
            ),
          },
          {
            title: "决策利用",
            key: "dependencies",
            width: 250,
            sorter: (a, b) => a.dependencyCount - b.dependencyCount,
            render: (_, row) => row.cataloged ? (
              <Space direction="vertical" size={2}>
                <Tooltip title={row.dependencies.map((item) => `${item.title}：${item.decision}`).join("\n")}>
                  <Typography.Text>
                    影响 {row.dependencyCount} 个产品 · 已放行 {row.releasedDependencyCount}
                  </Typography.Text>
                </Tooltip>
                <Typography.Text type="secondary" ellipsis={{ tooltip: row.dependencies.map((item) => item.title).join("、") }} style={{ maxWidth: 225 }}>
                  {row.dependencies.map((item) => item.title).join("、")}
                </Typography.Text>
              </Space>
            ) : (
              <Tag color="gold">运行已见 · 尚未编入数据产品</Tag>
            ),
          },
          {
            title: "Owner / 最短 SLA",
            key: "owner",
            width: 190,
            sorter: (a, b) => (a.minDecisionSlaHours ?? Number.MAX_SAFE_INTEGER)
              - (b.minDecisionSlaHours ?? Number.MAX_SAFE_INTEGER),
            render: (_, row) => {
              const owners = uniqueOwners(row);
              if (owners.length === 0) return "待指定";
              return (
                <Space direction="vertical" size={2}>
                  <Tooltip title={owners.join("；")}>
                    <Space size={4} wrap={false}>
                      <Typography.Text ellipsis style={{ maxWidth: 112 }}>{owners[0]}</Typography.Text>
                      {owners.length > 1 ? <Tag style={{ marginInlineEnd: 0 }}>+{owners.length - 1} 组</Tag> : null}
                    </Space>
                  </Tooltip>
                  <Typography.Text type="secondary">{row.minDecisionSlaHours} 小时</Typography.Text>
                </Space>
              );
            },
          },
          {
            title: "门禁与下一步",
            dataIndex: "stateReason",
            width: 300,
            render: (value: string) => (
              <Typography.Paragraph ellipsis={{ rows: 2, tooltip: value }} style={{ marginBottom: 0 }}>
                {value}
              </Typography.Paragraph>
            ),
          },
          {
            title: "行动",
            key: "action",
            width: 125,
            fixed: "right",
            render: (_, row) => (
              <Button type="link" size="small" href={row.actionHref} style={{ paddingInline: 0 }}>
                {row.actionLabel} <ArrowRightOutlined />
              </Button>
            ),
          },
        ]}
      />
    </Card>
  );
}
