"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, App, Card, Col, List, Row, Statistic, Tag, Typography } from "antd";
import { RightOutlined, ThunderboltOutlined, WarningOutlined } from "@ant-design/icons";
import Link from "next/link";
import { fetchJson } from "@/components/fetchJson";

interface ExceptionItem {
  key: string;
  severity: "critical" | "high" | "medium";
  title: string;
  impact: string;
  count: number;
  href: string;
}

const SEV_META: Record<string, { color: string; label: string }> = {
  critical: { color: "#cf1322", label: "紧急" },
  high: { color: "#fa8c16", label: "高" },
  medium: { color: "#faad14", label: "中" },
};

/** #6 控制塔：登录第一屏「今天最需要处理的事」，按严重度+影响排序，一键直达 */
function ControlTower({ items, loading }: { items: ExceptionItem[]; loading: boolean }) {
  if (loading) return <Card loading style={{ marginBottom: 16 }} />;
  if (items.length === 0) {
    return (
      <Alert type="success" showIcon style={{ marginBottom: 16 }} message="控制塔：当前无跨域异常——各项监控均在阈值内。" />
    );
  }
  return (
    <Card
      size="small"
      style={{ marginBottom: 16, borderColor: "#ffccc7" }}
      title={<span><ThunderboltOutlined style={{ color: "#cf1322" }} /> 控制塔 · 今天最需要处理的事（{items.length}）</span>}
    >
      <List
        dataSource={items}
        renderItem={(it) => (
          <List.Item
            actions={[<Link key="go" href={it.href}>处理 <RightOutlined /></Link>]}
          >
            <List.Item.Meta
              avatar={<Tag color={SEV_META[it.severity].color}>{SEV_META[it.severity].label}</Tag>}
              title={<Link href={it.href}>{it.title}</Link>}
              description={it.impact}
            />
          </List.Item>
        )}
      />
    </Card>
  );
}

interface FocusMetric {
  key: string;
  label: string;
  value: number | null;
  href: string;
  suffix?: string;
}

interface QueueItem { key: string; label: string; count: number; href: string }

interface FocusSection {
  role: string;
  roleLabel: string;
  metrics: FocusMetric[];
}

/** 角色聚焦区块：每个数字都是真实查询，点击直达可操作页面 */
function FocusSections({ sections, loading }: { sections: FocusSection[]; loading: boolean }) {
  if (!loading && sections.length === 0) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      {loading && sections.length === 0 && (
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          {[0, 1, 2].map((i) => (
            <Col xs={24} sm={8} key={i}>
              <Card loading />
            </Col>
          ))}
        </Row>
      )}
      {sections.map((s) => (
        <div key={s.role} style={{ marginBottom: 16 }}>
          <Typography.Title level={5} style={{ marginBottom: 12 }}>
            {s.roleLabel}关注
          </Typography.Title>
          <Row gutter={[16, 16]}>
            {s.metrics.map((m) => (
              <Col xs={12} sm={8} md={6} key={m.key}>
                <Link href={m.href}>
                  <Card hoverable size="small">
                    {m.value == null ? (
                      <Statistic title={m.label} valueRender={() => <RightOutlined />} value=" " />
                    ) : (
                      <Statistic
                        title={m.label}
                        value={m.value}
                        suffix={m.suffix}
                        valueStyle={m.value > 0 ? undefined : { color: "#999" }}
                      />
                    )}
                  </Card>
                </Link>
              </Col>
            ))}
          </Row>
        </div>
      ))}
    </div>
  );
}

export default function WorkbenchClient() {
  const { message } = App.useApp();
  const [openAliasCount, setOpenAliasCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [sections, setSections] = useState<FocusSection[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionItem[]>([]);
  const [myOpenDocs, setMyOpenDocs] = useState<number | null>(null);
  const [queues, setQueues] = useState<QueueItem[]>([]);
  const [focusLoading, setFocusLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFocusLoading(true);
    // 角色聚焦区块 + 控制塔异常（服务端按当前用户角色计算真实计数）
    fetchJson<{ sections: FocusSection[]; exceptions: ExceptionItem[]; myOpenDocs: number | null; queues: QueueItem[] }>("/api/workbench")
      .then((r) => { setSections(r.sections); setExceptions(r.exceptions ?? []); setMyOpenDocs(r.myOpenDocs ?? null); setQueues(r.queues ?? []); })
      .catch((e) => message.error((e as Error).message))
      .finally(() => setFocusLoading(false));
    try {
      const aliasRes = await fetchJson<{ total: number }>("/api/import/exceptions?status=open&page=1&pageSize=1");
      setOpenAliasCount(aliasRes.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>工作台</Typography.Title>
        <Link href="/report/digest">每日经营摘要（简报视图）→</Link>
      </div>
      <ControlTower items={exceptions} loading={focusLoading && exceptions.length === 0} />
      <FocusSections sections={sections} loading={focusLoading} />
      <Typography.Title level={5} style={{ margin: "4px 0 12px" }}>待处理入口</Typography.Title>
      {/* 队列为空且已加载完毕：明确说明「没有待办」，而不是静默塌缩成只剩别名一张卡 */}
      {!focusLoading && queues.length === 0 && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 12 }}
          message="当前没有待你处理的单据——下方仅剩别名认领入口。"
        />
      )}
      <Row gutter={[12, 12]}>
        {queues.map((qq) => (
          <Col xs={12} sm={8} md={queues.length > 4 ? 4 : 6} key={qq.key}>
            <Link href={qq.href}>
              <Card hoverable size="small" loading={focusLoading && queues.length === 0}>
                <Statistic
                  title={qq.label}
                  value={qq.count}
                  valueStyle={qq.count > 0 ? { fontSize: 22 } : { fontSize: 22, color: "#bbb" }}
                />
              </Card>
            </Link>
          </Col>
        ))}
        <Col xs={12} sm={8} md={queues.length > 4 ? 4 : 6}>
          <Link href="/import/exceptions">
            <Card hoverable size="small" loading={loading && openAliasCount == null}>
              <Statistic title="待认领别名" value={openAliasCount ?? 0} valueStyle={{ fontSize: 22, color: (openAliasCount ?? 0) > 0 ? undefined : "#bbb" }} />
            </Card>
          </Link>
        </Col>
      </Row>
    </div>
  );
}
