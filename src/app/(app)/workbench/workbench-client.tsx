"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Col, List, Row, Space, Statistic, Tag, Typography } from "antd";
import { BulbOutlined, ReloadOutlined, RightOutlined, ThunderboltOutlined } from "@ant-design/icons";
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

interface NextActionItem {
  key: string;
  priority: "high" | "medium";
  docTypeLabel: string;
  docNo: string;
  triggerLabel: string;
  triggerAt: string;
  actionLabel: string;
  reason: string;
  ownerLabel: string;
  href: string;
  evidence: string;
}

function NextActions({ items, loading }: { items: NextActionItem[]; loading: boolean }) {
  if (loading) return <Card loading style={{ marginBottom: 16 }} />;
  if (items.length === 0) {
    return (
      <Alert
        type="success"
        showIcon
        style={{ marginBottom: 16 }}
        message="下一步建议：当前没有已触发且仍待执行的单据动作。"
      />
    );
  }
  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={
        <span>
          <BulbOutlined style={{ color: "#1677ff" }} /> 下一步建议（{items.length}）
        </span>
      }
      extra={<Typography.Text type="secondary">审计事件触发 · 当前状态复核 · 不自动执行</Typography.Text>}
    >
      <List
        dataSource={items}
        renderItem={(item) => (
          <List.Item actions={[<Link key="go" href={item.href}>{item.actionLabel} <RightOutlined /></Link>]}>
            <List.Item.Meta
              title={
                <Space wrap size={6}>
                  <Tag color={item.priority === "high" ? "red" : "gold"}>
                    {item.priority === "high" ? "优先" : "关注"}
                  </Tag>
                  <Tag>{item.docTypeLabel}</Tag>
                  <Typography.Text code>{item.docNo}</Typography.Text>
                  <Typography.Text>{item.reason}</Typography.Text>
                </Space>
              }
              description={
                <Space wrap split={<span>·</span>}>
                  <span>触发：{item.triggerLabel}（{new Date(item.triggerAt).toLocaleString("zh-CN", { hour12: false })}）</span>
                  <span>责任：{item.ownerLabel}</span>
                  <span>证据：{item.evidence}</span>
                </Space>
              }
            />
          </List.Item>
        )}
      />
    </Card>
  );
}

/** 角色聚焦区块：每个数字都是真实查询，点击直达可操作页面 */
function FocusSections({ sections, loading }: { sections: FocusSection[]; loading: boolean }) {
  if (!loading && sections.length === 0) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      {loading && sections.length === 0 && (
        <Row gutter={[10, 10]} className="compact-kpi-row">
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
          <Row gutter={[10, 10]} className="compact-kpi-row">
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
  const [nextActions, setNextActions] = useState<NextActionItem[]>([]);
  const [queues, setQueues] = useState<QueueItem[]>([]);
  const [focusLoading, setFocusLoading] = useState(false);
  const [focusError, setFocusError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFocusLoading(true);
    setFocusError(null);
    // 角色聚焦区块 + 控制塔异常（服务端按当前用户角色计算真实计数）
    fetchJson<{
      sections: FocusSection[];
      exceptions: ExceptionItem[];
      nextActions: NextActionItem[];
      myOpenDocs: number | null;
      queues: QueueItem[];
    }>("/api/workbench")
      .then((r) => {
        setSections(r.sections);
        setExceptions(r.exceptions ?? []);
        setNextActions(r.nextActions ?? []);
        setQueues(r.queues ?? []);
      })
      .catch((e) => {
        const error = (e as Error).message;
        setFocusError(error);
        setSections([]);
        setExceptions([]);
        setNextActions([]);
        setQueues([]);
        message.error(error);
      })
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
      {focusError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="工作台数据加载失败，未用空数据伪装成“无异常”。"
          description={focusError}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>重试</Button>}
        />
      ) : (
        <>
          <ControlTower items={exceptions} loading={focusLoading && exceptions.length === 0} />
          <NextActions items={nextActions} loading={focusLoading && nextActions.length === 0} />
          <FocusSections sections={sections} loading={focusLoading} />
        </>
      )}
      <Typography.Title level={5} style={{ margin: "4px 0 12px" }}>待处理入口</Typography.Title>
      {/* 队列为空且已加载完毕：明确说明「没有待办」，而不是静默塌缩成只剩别名一张卡 */}
      {!focusLoading && !focusError && queues.length === 0 && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 12 }}
          message="当前没有待你处理的单据——下方仅剩别名认领入口。"
        />
      )}
      <Row gutter={[10, 10]} className="compact-kpi-row">
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
