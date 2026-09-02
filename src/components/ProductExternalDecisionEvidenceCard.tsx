"use client";

import { Button, Card, Col, Row, Space, Tag, Tooltip, Typography } from "antd";

import type {
  ProductExternalDecisionEvidenceBrief,
  ProductExternalDecisionSourceBrief,
} from "@/components/product-external-decision-evidence";

const SOURCE_STATE = {
  missing: { label: "缺失", color: "default" },
  stale: { label: "过期", color: "red" },
  degraded: { label: "受限", color: "orange" },
  observation: { label: "观察", color: "blue" },
  operational: { label: "运营", color: "green" },
} as const;

const STREAM_STATE = {
  missing: { label: "未取得", color: "default" },
  stale: { label: "已过期", color: "red" },
  degraded: { label: "受限", color: "orange" },
  current: { label: "当前", color: "green" },
} as const;

function SourceEvidence({ source }: { source: ProductExternalDecisionSourceBrief }) {
  const sourceState = SOURCE_STATE[source.state];
  const dates = [...new Set(source.streams.map((stream) => stream.sourceAsOf).filter(Boolean))];
  const knownSourceRows = source.streams.flatMap((stream) => stream.sourceRows === null ? [] : [stream.sourceRows]);
  const sourceRows = knownSourceRows.reduce((sum, rows) => sum + rows, 0);
  const rejectedRows = source.streams.reduce((sum, stream) => sum + (stream.rejectedRows ?? 0), 0);
  const readyIdentities = source.identities.filter((identity) => identity.state === "ready").length;
  return (
    <div style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: 10, height: "100%", background: "#fafafa" }}>
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        <Space size={6} wrap>
          <Typography.Text strong>{source.label}</Typography.Text>
          <Tag color={sourceState.color} style={{ marginInlineEnd: 0 }}>{sourceState.label}</Tag>
          {!source.configurationReady ? <Tag color="red" style={{ marginInlineEnd: 0 }}>配置/授权未就绪</Tag> : null}
        </Space>
        <Space size={[4, 4]} wrap>
          {source.streams.map((stream) => {
            const state = STREAM_STATE[stream.state];
            return (
              <Tooltip title={stream.reason} key={stream.stream}>
                <Tag color={state.color} style={{ marginInlineEnd: 0, whiteSpace: "normal" }}>
                  {stream.label} · {state.label}
                </Tag>
              </Tooltip>
            );
          })}
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {dates.length > 0 ? `源截止 ${dates.join(" / ")}` : "尚无可用业务截止日"}
          {knownSourceRows.length > 0 ? ` · 源行合计 ${sourceRows.toLocaleString("zh-CN")}` : ""}
          {rejectedRows > 0 ? ` · 拒绝 ${rejectedRows.toLocaleString("zh-CN")}` : ""}
          {source.identities.length > 0 ? ` · 身份 ${readyIdentities}/${source.identities.length} 就绪` : ""}
        </Typography.Text>
      </Space>
    </div>
  );
}

/** 业务页上的紧凑证据条；只显示安全摘要，完整门禁留在决策工作室。 */
export default function ProductExternalDecisionEvidenceCard({
  evidence,
}: {
  evidence: ProductExternalDecisionEvidenceBrief | null | undefined;
}) {
  if (!evidence || evidence.sources.length === 0) return null;
  const width = Math.max(8, Math.floor(24 / evidence.sources.length));
  return (
    <Card
      size="small"
      title="三方决策证据"
      extra={(
        <Space size={6} wrap>
          <Tag color={evidence.inputLevel === "A1" ? "blue" : "default"}>输入层 {evidence.inputLevel}</Tag>
          <Button type="link" size="small" href={evidence.detailHref}>查看完整证据</Button>
        </Space>
      )}
      style={{ marginBottom: 12 }}
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 10 }}>
        {evidence.blockerSummary}
      </Typography.Paragraph>
      <Row gutter={[8, 8]}>
        {evidence.sources.map((source) => (
          <Col xs={24} xl={width} key={source.source}>
            <SourceEvidence source={source} />
          </Col>
        ))}
      </Row>
    </Card>
  );
}
