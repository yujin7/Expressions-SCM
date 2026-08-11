"use client";

import { Alert, Card, Col, Progress, Row, Space, Table, Tag, Typography } from "antd";
import {
  capabilityReadiness,
  DECISION_CAPABILITIES,
  type CapabilityReadiness,
} from "@/components/decision-capabilities";
import {
  DATA_PRODUCTS,
  DATA_PRODUCT_AUTHORITY_LABEL,
  DATA_PRODUCT_SOURCE_LABEL,
  type DataProductAuthority,
} from "@/components/data-products";

const STATE_META: Record<CapabilityReadiness, { label: string; color: string; stroke: string }> = {
  ready: { label: "当前可用", color: "success", stroke: "#16a34a" },
  partial: { label: "部分可用", color: "warning", stroke: "#d97706" },
  blocked: { label: "尚未解锁", color: "error", stroke: "#dc2626" },
};

export default function DecisionReadinessPanel() {
  const ready = DECISION_CAPABILITIES.filter((item) => capabilityReadiness(item) === "ready").length;
  const partial = DECISION_CAPABILITIES.filter((item) => capabilityReadiness(item) === "partial").length;

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={`决策能力门禁：${ready} 项当前可用，${partial} 项部分可用`}
        description="这里衡量的是数据前提是否成立，不是图表数量。未满足前提的能力必须留白或显示数据不足，禁止用 0、估算值或演示数据伪装完成。"
      />
      <Row gutter={[12, 12]}>
        {DECISION_CAPABILITIES.map((capability) => {
          const state = capabilityReadiness(capability);
          const meta = STATE_META[state];
          const percent = Math.round((capability.proven.length / capability.required.length) * 100);
          const missing = capability.required.filter((item) => !capability.proven.includes(item));
          return (
            <Col xs={24} xl={12} key={capability.id}>
              <Card
                size="small"
                title={capability.title}
                extra={<Tag color={meta.color}>{meta.label}</Tag>}
                style={{ height: "100%" }}
              >
                <Typography.Paragraph style={{ marginBottom: 8 }}>
                  <Typography.Text strong>要回答：</Typography.Text>
                  {capability.decision}
                </Typography.Paragraph>
                <Progress
                  percent={percent}
                  strokeColor={meta.stroke}
                  format={() => `${capability.proven.length}/${capability.required.length} 前提`}
                  aria-label={`${capability.title}已满足 ${capability.proven.length} 项，共 ${capability.required.length} 项前提`}
                />
                <Typography.Text type="secondary">已证明</Typography.Text>
                <div style={{ marginTop: 4, marginBottom: 8 }}>
                  <Space size={[4, 4]} wrap>
                    {capability.proven.map((item) => <Tag color="green" key={item}>{item}</Tag>)}
                  </Space>
                </div>
                {missing.length > 0 ? (
                  <>
                    <Typography.Text type="secondary">待解锁</Typography.Text>
                    <div style={{ marginTop: 4, marginBottom: 8 }}>
                      <Space size={[4, 4]} wrap>
                        {missing.map((item) => <Tag key={item}>{item}</Tag>)}
                      </Space>
                    </div>
                  </>
                ) : null}
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  <Typography.Text strong>下一步（{capability.owner}）：</Typography.Text>
                  {capability.nextAction}
                </Typography.Paragraph>
              </Card>
            </Col>
          );
        })}
      </Row>
      <Card
        size="small"
        title="三方数据产品目录"
        style={{ marginTop: 16 }}
        extra={<Tag color="blue">10 个目标契约</Tag>}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="目录定义不等于当前已解锁"
          description="每个产品列出目标粒度、来源、责任人与放行门禁；当前是否可用仍以上方能力证据、连接器运行证据和 UAT 为准。"
        />
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={DATA_PRODUCTS}
          scroll={{ x: 1080 }}
          columns={[
            {
              title: "数据产品",
              dataIndex: "title",
              width: 150,
              fixed: "left",
              render: (value: string, row) => (
                <div>
                  <Typography.Text strong>{value}</Typography.Text>
                  <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                    {row.grain}
                  </Typography.Text>
                </div>
              ),
            },
            { title: "要回答的决策", dataIndex: "decision", width: 270 },
            {
              title: "来源",
              dataIndex: "sources",
              width: 250,
              render: (sources: (keyof typeof DATA_PRODUCT_SOURCE_LABEL)[]) => (
                <Space size={[4, 4]} wrap>
                  {sources.map((source) => <Tag key={source}>{DATA_PRODUCT_SOURCE_LABEL[source]}</Tag>)}
                </Space>
              ),
            },
            { title: "Owner", dataIndex: "owner", width: 150 },
            {
              title: "目标权威级",
              dataIndex: "targetAuthority",
              width: 120,
              render: (authority: DataProductAuthority) => (
                <Tag color={authority === "financial" ? "purple" : authority === "operational" ? "green" : "gold"}>
                  {DATA_PRODUCT_AUTHORITY_LABEL[authority]}
                </Tag>
              ),
            },
            { title: "放行门禁", dataIndex: "releaseGate", width: 330 },
          ]}
        />
      </Card>
    </div>
  );
}
