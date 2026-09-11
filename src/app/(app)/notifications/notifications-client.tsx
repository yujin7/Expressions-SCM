"use client";

/**
 * #8 通知中心（站内）：展示异常/事件通知；飞书渠道经应用机器人或 webhook 推送。
 *
 * W2 平台化：此前本页是**一条平铺的流水**——无筛选、无分页（服务端恒取最近 100 条）、
 * 无未读开关，也没有任何一条路能回到「这条通知说的那条告警」。通知一多，昨天那条
 * 断货预警就再也翻不到；而系统告警通知的 href 指向的是处置页，看不到告警本身的
 * 规则来源/参数快照/是否已被关闭。
 *
 * 现与其它列表页同口径：`useListState` + `ListToolbar`（严重度 / 已读状态 / 分页写进 URL，
 * 链接可分享、后退可用），每条系统告警通知额外给一条「查看告警」深链
 * （alertId 由服务端按 dedupeKey 解析，规则唯一权威在 lib/notify-links）。
 */
import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, List, Select, Space, Tag, Typography } from "antd";
import Link from "next/link";
import { fetchJson } from "@/components/fetchJson";
import { useDocumentRead } from "@/components/useDocumentRead";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { useListState } from "@/components/useListState";
import { SEVERITY } from "@/components/dictionary";
import { alertDeepLink } from "@/lib/notify-links";
import { notificationDelivery } from "@/lib/notification-delivery";
import styles from "./notifications.module.css";

interface Notice {
  id: number; channel: string; title: string; body: string; href: string | null;
  severity: string | null; status: string; createdAt: string; sentAt: string | null; readAt: string | null;
  /** 系统告警通知反查到的告警 id（其它通知 = null） */
  alertId: number | null;
}

interface Data { rows: Notice[]; total: number; unread: number }

type Filters = { severity?: string; read?: string };

const READ_OPTIONS = [
  { value: "", label: "全部" },
  { value: "unread", label: "仅未读" },
  { value: "read", label: "仅已读" },
];

export default function NotificationsClient() {
  const listState = useListState<Filters>({ key: "notifications", defaults: { severity: "", read: "" }, defaultPageSize: 50 });
  const query = listState.queryString();
  const read = useDocumentRead<Data>(`/api/notifications?${query}`);
  const { data, error: loadError } = read;
  const loading = read.phase === "loading";
  const [marking, setMarking] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const locked = useRef(false);
  const live = useRef(true);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const refresh = () => { content.current?.focus({ preventScroll: true }); read.retry(); };
  const markRead = async (id?: number) => {
    if (locked.current || loading || !data || !live.current) return;
    locked.current = true;
    content.current?.focus({ preventScroll: true });
    setMarking(true); setWriteError(null); setReceipt(null);
    try {
      const result = await fetchJson<{ ok: boolean; marked: number }>("/api/notifications", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(id ? { id } : { all: true }),
        signal: AbortSignal.timeout(30_000),
      });
      if (result?.ok !== true || !Number.isSafeInteger(result.marked) || result.marked < 0) throw new Error("未能确认阅读回执");
      if (!live.current) return;
      setReceipt(result.marked ? `已将 ${result.marked} 条通知标为本人已读；事项仍须实际处理。` : "没有新增已读记录；请以刷新后的本人阅读状态为准。");
      read.retry();
    } catch (e) {
      if (live.current) setWriteError(`${e instanceof Error ? e.message : "阅读状态未确认"}。请刷新核对本人已读状态，不会自动重试。`);
    } finally {
      if (live.current) { locked.current = false; setMarking(false); }
    }
  };
  const unread = data?.unread;

  return (
    <div ref={content} tabIndex={-1} className={styles.root} aria-label="通知中心内容">
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        通知中心 {unread !== undefined ? <Badge count={unread} showZero overflowCount={999} /> : <Typography.Text type="secondary">{loading ? "读取中" : "未读数待核对"}</Typography.Text>}
      </Typography.Title>
      <p className={styles.help}>先看消息，再回到来源处理；标记已读不会完成待办或关闭告警。</p>
      <details className={styles.help}><summary>站内阅读、飞书发送与“全部已读”的区别</summary>
        <p>站内消息生成后即可按收件人范围阅读，无需等分发任务登记。飞书独立发送，是否发送取决于通知渠道、配置与目标；发送中或失败不代表已送达，已发送也不代表对方已读。</p>
        <p>“全部已读”作用于本人全部可见通知，不限当前筛选、分页；不会替其他人标记已读，也不会改变源业务。</p>
      </details>
      <LoadErrorAlert error={loadError} onRetry={refresh} subject="通知中心" retrying={loading} />
      {writeError ? <Alert type="warning" showIcon message="阅读状态未确认" description={writeError} /> : null}
      {receipt ? <p role="status" className={styles.help}>{receipt}</p> : null}
      <ListToolbar
        state={listState}
        extra={
          <Space wrap>
            <Select
              aria-label="通知阅读筛选"
              style={{ width: 120 }}
              value={listState.filters.read || ""}
              options={READ_OPTIONS}
              onChange={(v) => listState.setFilter({ read: v })}
            />
            <Select
              aria-label="通知严重度筛选"
              allowClear
              placeholder="严重度"
              style={{ width: 120 }}
              value={listState.filters.severity || undefined}
              options={["critical", "high", "medium", "info"].map((v) => ({ value: v, label: SEVERITY[v]?.label ?? v }))}
              onChange={(v) => listState.setFilter({ severity: v ?? "" })}
            />
          </Space>
        }
        primaryActions={
          <>
            <Button onClick={refresh} loading={loading} disabled={marking}>刷新</Button>
            <Button type="primary" onClick={() => void markRead()} loading={marking} disabled={!unread || loading || marking}>全部已读</Button>
          </>
        }
      />
      <List
        loading={loading}
        size={listState.density === "small" ? "small" : "default"}
        dataSource={data?.rows ?? []}
        locale={{ emptyText: loadError ? "数据未加载" : "当前筛选下暂无通知" }}
        pagination={data ? {
          ...listState.paginationProps({ total: data?.total ?? 0, showTotal: (t) => `共 ${t} 条通知` }),
          position: "bottom",
          align: "end",
        } : false}
        renderItem={(n) => {
          const delivery = notificationDelivery(n.channel, n.status);
          const longBody = n.body.length > 160 || n.body.split("\n").length > 3;
          return (
          <List.Item
            className={styles.item}
            actions={[
              ...(n.href ? [<Link key="go" href={n.href}>去处理</Link>] : []),
              ...(n.alertId != null ? [<Link key="alert" href={alertDeepLink(n.alertId)}>查看告警 #{n.alertId}</Link>] : []),
              ...(n.readAt ? [] : [<Button key="rd" type="link" size="small" disabled={marking || loading} onClick={() => void markRead(n.id)}>标记已读</Button>]),
            ]}
          >
            <List.Item.Meta
              avatar={n.severity ? <Tag color={SEVERITY[n.severity]?.color}>{SEVERITY[n.severity]?.label ?? n.severity}</Tag> : null}
              title={(
                <Space size={6} wrap>
                  <Tag color={n.readAt ? "default" : "blue"}>{n.readAt ? "本人已读" : "未读"}</Tag>
                  <Tag color={delivery.color}>{delivery.label}</Tag>
                  <span>{n.title}</span>
                </Space>
              )}
              description={<div>
                {longBody ? <details className={styles.message}>
                  <summary><span className={styles.preview}>{Array.from(n.body).slice(0, 120).join("")}… </span><span className={styles.disclosure}>完整内容（展开/收起）</span></summary>
                  <p className={styles.body}>{n.body}</p>
                </details> : <p className={styles.body}>{n.body}</p>}
                <small>生成于 {new Date(n.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（上海） · #{n.id}</small>
              </div>}
            />
          </List.Item>
          );
        }}
      />
    </div>
  );
}
