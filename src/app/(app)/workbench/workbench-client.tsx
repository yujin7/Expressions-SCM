"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Col, DatePicker, Input, List, Modal, Row, Segmented, Space, Statistic, Tag, Tooltip, Typography } from "antd";
import type { Dayjs } from "dayjs";
import { BulbOutlined, ReloadOutlined, RightOutlined, ThunderboltOutlined } from "@ant-design/icons";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { fetchJson, postJson } from "@/components/fetchJson";
import { hasAnyRole, useMe } from "@/components/useMe";
import { ACTION } from "@/components/dictionary";
import DigestView from "./digest-view";

interface ExceptionItem {
  key: string;
  severity: "critical" | "high" | "medium";
  title: string;
  impact: string;
  count: number;
  href: string;
  /** W9：连续出现天数（含今天）；≥ 长期阈值即"慢性被忽略" */
  daysShown?: number;
  /** W2：上次访问时这条还不在清单里（纯事实比对，不改排序、不评分） */
  newSinceLastVisit?: boolean;
}

/** W2：自上次访问以来的变化摘要（无登录人视角 = null） */
interface SinceLastVisit {
  since: string | null;
  newCount: number;
  firstVisit: boolean;
}

/** 连续出现多少天就该被当成"慢性被忽略"高亮出来（只是展示口径，不改任何判定） */
const CHRONIC_DAYS = 7;

const SEV_META: Record<string, { color: string; label: string }> = {
  critical: { color: "#cf1322", label: "紧急" },
  high: { color: "#fa8c16", label: "高" },
  medium: { color: "#faad14", label: "中" },
};

/**
 * W9 打盹弹窗：日期 + 必填原因 → POST /api/workbench/exceptions/snooze。
 * 打盹是**全局**的（控制塔是全员同一块板），文案里必须说清楚，别让人以为只是自己眼前清净。
 */
function SnoozeModal({ item, onCancel, onDone }: { item: ExceptionItem | null; onCancel: () => void; onDone: () => void }) {
  const { message } = App.useApp();
  const [until, setUntil] = useState<Dayjs | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { setUntil(null); setNote(""); }, [item?.key]);

  const submit = async () => {
    if (!item) return;
    if (!until) { message.warning("请选择打盹到期日"); return; }
    if (!note.trim()) { message.warning("请填写打盹原因（到期恢复时要能看懂当初的判断）"); return; }
    setSubmitting(true);
    try {
      await postJson("/api/workbench/exceptions/snooze", {
        exceptionKey: item.key, until: until.format("YYYY-MM-DD"), note: note.trim(),
      });
      message.success(`已打盹到 ${until.format("YYYY-MM-DD")}（到期自动恢复显示）`);
      onDone();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={item ? `${ACTION.snoozeException}：${item.title}` : ACTION.snoozeException}
      open={item != null}
      onOk={() => void submit()}
      onCancel={onCancel}
      confirmLoading={submitting}
      okText={ACTION.snoozeException}
      cancelText="取消"
      width="min(480px, 100vw)"
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message={ACTION.snoozeExceptionHint}
      />
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <div>
          <Typography.Text strong>{ACTION.snoozeException}到（含当日）</Typography.Text>
          <DatePicker aria-label="打盹到期日" value={until} onChange={setUntil} style={{ width: "100%", marginTop: 4 }} />
        </div>
        <div>
          <Typography.Text strong>原因（必填）</Typography.Text>
          <Input.TextArea
            aria-label="打盹原因"
            rows={3}
            maxLength={500}
            showCount
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：已排产，8 月 20 日到货后自然消解"
            style={{ marginTop: 4 }}
          />
        </div>
      </Space>
    </Modal>
  );
}

/** 「上次访问 …」的人话时间（服务端下发 ISO；无基线=首次访问） */
function visitTimeText(since: string | null): string {
  if (!since) return "首次访问";
  return new Date(since).toLocaleString("zh-CN", { hourCycle: "h23" });
}

/**
 * #6 控制塔：登录第一屏「今天最需要处理的事」，按严重度+影响排序，一键直达。
 * W9：每条带「已连续 N 天」——一条挂了 40 天没人点的例外，本身就是要处理的问题；
 * 计划/采购/运营/仓管（及 admin）可带日期与原因打盹（全局生效、写审计、到期自动恢复）。
 * W2：每条带「上次访问后新增」——回访的人要看的是"有什么变了"，不是把整屏再读一遍。
 *   只是标记：不改排序、不过滤、不评分（严重度仍然压倒新鲜度——一条挂了三天的 critical
 *   不会因为"不新"就该被往后放）。
 */
function ControlTower({ items, loading, onSnooze, canSnooze, sinceLastVisit }: {
  items: ExceptionItem[];
  loading: boolean;
  onSnooze: (item: ExceptionItem) => void;
  canSnooze: boolean;
  sinceLastVisit: SinceLastVisit | null;
}) {
  if (loading) return <Card loading style={{ marginBottom: 16 }} />;
  if (items.length === 0) {
    return (
      <Alert type="success" showIcon style={{ marginBottom: 16 }} message="控制塔：当前无跨域异常（或已被打盹）——各项监控均在阈值内。" />
    );
  }
  return (
    <Card
      size="small"
      style={{ marginBottom: 16, borderColor: "#ffccc7" }}
      title={<span><ThunderboltOutlined style={{ color: "#cf1322" }} /> 控制塔 · 今天最需要处理的事（{items.length}）</span>}
      extra={sinceLastVisit ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {sinceLastVisit.firstVisit
            ? "首次访问：本次不标新增"
            : sinceLastVisit.newCount > 0
              ? `上次访问（${visitTimeText(sinceLastVisit.since)}）后新增 ${sinceLastVisit.newCount} 条`
              : `上次访问（${visitTimeText(sinceLastVisit.since)}）后无新增`}
        </Typography.Text>
      ) : null}
    >
      <List
        dataSource={items}
        renderItem={(it) => (
          <List.Item
            actions={[
              <Link key="go" href={it.href}>处理 <RightOutlined /></Link>,
              ...(canSnooze ? [<a key="snooze" onClick={() => onSnooze(it)}>{ACTION.snoozeException}</a>] : []),
            ]}
          >
            <List.Item.Meta
              avatar={<Tag color={SEV_META[it.severity].color}>{SEV_META[it.severity].label}</Tag>}
              title={(
                <Space size={6}>
                  <Link href={it.href}>{it.title}</Link>
                  {it.newSinceLastVisit ? (
                    <Tooltip title="你上次访问工作台时这条还不在清单里">
                      <Tag color="blue">上次访问后新增</Tag>
                    </Tooltip>
                  ) : null}
                  {it.daysShown && it.daysShown > 1 ? (
                    <Tooltip title={it.daysShown >= CHRONIC_DAYS ? "长期挂着没被处理——要么解决，要么带原因打盹" : "连续出现天数"}>
                      <Tag color={it.daysShown >= CHRONIC_DAYS ? "red" : "default"}>已连续 {it.daysShown} 天</Tag>
                    </Tooltip>
                  ) : null}
                </Space>
              )}
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
                  <span>触发：{item.triggerLabel}（{new Date(item.triggerAt).toLocaleString("zh-CN", { hourCycle: "h23" })}）</span>
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
  const me = useMe();
  /* 视图写进 URL（`?view=digest`）：旧 /report/digest 的收藏与外链跳到这里仍然落在简报上 */
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const viewParam = searchParams.get("view");
  const setView = (next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "digest") params.set("view", "digest");
    else params.delete("view");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
  const canSnooze = hasAnyRole(me, "pmc", "purchasing", "ops", "warehouse"); // 与路由 requireAnyRole 同口径
  const [snoozing, setSnoozing] = useState<ExceptionItem | null>(null);
  const [openAliasCount, setOpenAliasCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [sections, setSections] = useState<FocusSection[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionItem[]>([]);
  const [nextActions, setNextActions] = useState<NextActionItem[]>([]);
  const [queues, setQueues] = useState<QueueItem[]>([]);
  const [sinceLastVisit, setSinceLastVisit] = useState<SinceLastVisit | null>(null);
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
      sinceLastVisit: SinceLastVisit | null;
    }>("/api/workbench")
      .then((r) => {
        setSections(r.sections);
        setExceptions(r.exceptions ?? []);
        setNextActions(r.nextActions ?? []);
        setQueues(r.queues ?? []);
        setSinceLastVisit(r.sinceLastVisit ?? null);
      })
      .catch((e) => {
        const error = (e as Error).message;
        setFocusError(error);
        setSections([]);
        setExceptions([]);
        setNextActions([]);
        setQueues([]);
        setSinceLastVisit(null);
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

  /* W2 简报视图：`/report/digest` 与本页渲染的是同一份 workbench/focus 例外，
     并成本页的一个视图（?view=digest）。视图切换写进 URL——链接仍可分享、后退可用。 */
  const view = viewParam === "digest" ? "digest" : "board";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Space size={12} wrap>
          <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 0 }}>工作台</Typography.Title>
          <Segmented
            size="small"
            value={view}
            onChange={(v) => setView(String(v))}
            options={[
              { label: "控制塔", value: "board" },
              { label: "简报视图", value: "digest" },
            ]}
          />
        </Space>
        <Space size={16}>
          <Link href="/cockpit">驾驶舱四屏 →</Link>
        </Space>
      </div>
      {view === "digest" ? <DigestView /> : (
      <>
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
          <ControlTower
            items={exceptions}
            loading={focusLoading && exceptions.length === 0}
            canSnooze={canSnooze}
            onSnooze={setSnoozing}
            sinceLastVisit={sinceLastVisit}
          />
          <SnoozeModal item={snoozing} onCancel={() => setSnoozing(null)} onDone={() => { setSnoozing(null); void load(); }} />
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
      </>
      )}
    </div>
  );
}
