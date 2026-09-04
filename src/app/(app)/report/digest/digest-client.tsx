"use client";

/** 每日经营摘要——in-app 晨间简报（只读）：异常 × 关键指标 × 角色速览。装配自工作台聚焦。 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Card, Col, Divider, Empty, List, Row, Spin, Statistic, Tag, Typography } from "antd";
import { fetchJson } from "@/components/fetchJson";
import LoadErrorAlert from "@/components/LoadErrorAlert";

type Severity = "critical" | "high" | "medium";

interface ExceptionItem {
  key: string;
  severity: Severity;
  title: string;
  impact: string;
  count: number;
  href: string;
}

interface Highlight {
  label: string;
  value: number;
  suffix?: string;
  href: string;
}

interface SectionSummary {
  role: string;
  roleLabel: string;
  topMetrics: Highlight[];
}

interface Digest {
  date: string;
  generatedAt: string;
  headline: string;
  exceptions: ExceptionItem[];
  highlights: Highlight[];
  sectionSummaries: SectionSummary[];
}

const SEVERITY_META: Record<Severity, { color: string; label: string }> = {
  critical: { color: "red", label: "紧急" },
  high: { color: "orange", label: "高" },
  medium: { color: "gold", label: "中" },
};

export default function DigestClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<Digest | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await fetchJson<Digest>("/api/report/digest"));
    } catch (e) {
      setLoadError((e as Error).message);
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);
  useEffect(() => { void load(); }, [load]);

  if (loading && !data) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "80px 0" }}>
        <Spin tip="正在生成今日简报…" />
      </div>
    );
  }
  // 加载失败 / 无数据：此前 return null 整页空白，用户分不清「今天没简报」和「接口挂了」
  if (!data) {
    return (
      <div style={{ maxWidth: 960, margin: "0 auto", paddingBottom: 40 }}>
        <Typography.Title level={2} style={{ marginTop: 4, marginBottom: 8 }}>今日晨间简报</Typography.Title>
        <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="每日经营摘要" retrying={loading} />
        {!loadError ? <Empty description="数据未加载：今日简报尚未生成，请稍后刷新" /> : null}
      </div>
    );
  }

  const hasExceptions = data.exceptions.length > 0;

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", paddingBottom: 40 }}>
      {/* 日期 + 摘要头 */}
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        每日经营摘要 · {data.date}
      </Typography.Text>
      <Typography.Title level={2} style={{ marginTop: 4, marginBottom: 8 }}>
        今日晨间简报
      </Typography.Title>
      <Typography.Paragraph style={{ fontSize: 16, marginBottom: 0 }}>
        {hasExceptions ? (
          <Typography.Text strong type="danger">{data.headline}</Typography.Text>
        ) : (
          <Typography.Text strong type="success">{data.headline}</Typography.Text>
        )}
      </Typography.Paragraph>

      <Divider />

      {/* 今日异常 */}
      <Typography.Title level={4} style={{ marginTop: 0 }}>今日异常</Typography.Title>
      {hasExceptions ? (
        <List
          itemLayout="horizontal"
          dataSource={data.exceptions}
          renderItem={(item) => {
            const meta = SEVERITY_META[item.severity];
            return (
              <List.Item
                key={item.key}
                actions={[<a key="go" href={item.href}>处理</a>]}
              >
                <List.Item.Meta
                  avatar={<Tag color={meta.color} style={{ marginTop: 2 }}>{meta.label}</Tag>}
                  title={<span style={{ fontSize: 15 }}>{item.title}</span>}
                  description={<Typography.Text type="secondary">{item.impact}</Typography.Text>}
                />
              </List.Item>
            );
          }}
        />
      ) : (
        <Alert type="success" showIcon message="今日无跨域异常" description="各项监控指标正常，无需立即处理的紧急事项。" />
      )}

      <Divider />

      {/* 关键指标 */}
      <Typography.Title level={4}>关键指标</Typography.Title>
      {data.highlights.length > 0 ? (
        <Row gutter={[16, 16]}>
          {data.highlights.map((h) => (
            <Col key={h.href} xs={12} sm={8} md={8} lg={8}>
              <Card size="small" hoverable style={{ height: "100%" }}>
                <a href={h.href} style={{ display: "block" }}>
                  <Statistic
                    title={<Typography.Text type="secondary">{h.label}</Typography.Text>}
                    value={h.value}
                    suffix={h.suffix}
                  />
                </a>
              </Card>
            </Col>
          ))}
        </Row>
      ) : (
        <Empty description="暂无可展示的关键指标" />
      )}

      <Divider />

      {/* 角色速览 */}
      <Typography.Title level={4}>角色速览</Typography.Title>
      <Row gutter={[16, 16]}>
        {data.sectionSummaries.map((s) => (
          <Col key={s.role} xs={24} sm={12} md={8}>
            <Card size="small" title={s.roleLabel} style={{ height: "100%" }}>
              {s.topMetrics.length > 0 ? (
                <MetricList metrics={s.topMetrics} />
              ) : (
                <Typography.Text type="secondary">暂无指标</Typography.Text>
              )}
            </Card>
          </Col>
        ))}
      </Row>

      <Divider />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        生成时间 {new Date(data.generatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
      </Typography.Text>
    </div>
  );
}

/** 角色卡内的指标列表（编码为小组件，避免在 map 里堆内联） */
function MetricList({ metrics }: { metrics: Highlight[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {metrics.map((m) => (
        <a key={m.href} href={m.href} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>{m.label}</Typography.Text>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            <Typography.Text strong>{m.value.toLocaleString("zh-CN")}</Typography.Text>
            {m.suffix ? <Typography.Text type="secondary" style={{ fontSize: 12 }}> {m.suffix}</Typography.Text> : null}
          </span>
        </a>
      ))}
    </div>
  );
}
