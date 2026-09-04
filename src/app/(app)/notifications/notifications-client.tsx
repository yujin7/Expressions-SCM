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
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Badge, Button, List, Select, Space, Tag, Typography } from "antd";
import Link from "next/link";
import { fetchJson, postJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { useListState } from "@/components/useListState";
import { SEVERITY } from "@/components/dictionary";
import { alertDeepLink } from "@/lib/notify-links";

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

/** 发送状态：failed/skipped 必须看得见，否则"没收到"就成了无解的悬案 */
const STATUS_TAG: Record<string, { color: string; label: string }> = {
  failed: { color: "red", label: "发送失败" },
  skipped: { color: "default", label: "已跳过" },
  pending: { color: "gold", label: "待发送" },
};

export default function NotificationsClient() {
  const { message } = App.useApp();
  const listState = useListState<Filters>({ key: "notifications", defaults: { severity: "", read: "" }, defaultPageSize: 50 });
  const query = listState.queryString();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await fetchJson<Data>(`/api/notifications?${query}`));
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  const markRead = useCallback(async (id?: number) => {
    try {
      await postJson("/api/notifications", id ? { id } : { all: true });
      void load();
    } catch (e) {
      message.error((e as Error).message);
    }
  }, [load, message]);

  useEffect(() => { void load(); }, [load]);

  const unread = data?.unread ?? 0;

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        通知中心 <Badge count={unread} overflowCount={999} />
      </Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={`站内通知（未读 ${unread}）；配置飞书应用机器人或 webhook 后，同批通知自动推送到飞书群。系统告警类通知可直接跳到对应告警行查看规则来源与处置状态。`}
      />
      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="通知中心" retrying={loading} />
      <ListToolbar
        state={listState}
        extra={
          <Space wrap>
            <Select
              style={{ width: 120 }}
              value={listState.filters.read || ""}
              options={READ_OPTIONS}
              onChange={(v) => listState.setFilter({ read: v })}
            />
            <Select
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
            <Button onClick={() => void load()} loading={loading}>刷新</Button>
            <Button type="primary" onClick={() => void markRead()} disabled={unread === 0}>全部已读</Button>
          </>
        }
      />
      <List
        loading={loading}
        dataSource={data?.rows ?? []}
        locale={{ emptyText: loadError ? "数据未加载" : "当前筛选下暂无通知" }}
        pagination={{
          ...listState.paginationProps({ total: data?.total ?? 0, showTotal: (t) => `共 ${t} 条通知` }),
          position: "bottom",
          align: "end",
        }}
        renderItem={(n) => (
          <List.Item
            style={n.readAt ? { opacity: 0.55 } : undefined}
            actions={[
              ...(n.href ? [<Link key="go" href={n.href}>去处理</Link>] : []),
              ...(n.alertId != null ? [<Link key="alert" href={alertDeepLink(n.alertId)}>查看告警 #{n.alertId}</Link>] : []),
              ...(n.readAt ? [] : [<a key="rd" onClick={() => void markRead(n.id)}>标记已读</a>]),
            ]}
          >
            <List.Item.Meta
              avatar={n.severity ? <Tag color={SEVERITY[n.severity]?.color}>{SEVERITY[n.severity]?.label ?? n.severity}</Tag> : null}
              title={(
                <Space size={6} wrap>
                  {!n.readAt ? <Tag color="blue">未读</Tag> : null}
                  {STATUS_TAG[n.status] ? <Tag color={STATUS_TAG[n.status].color}>{STATUS_TAG[n.status].label}</Tag> : null}
                  <span>{n.title}</span>
                </Space>
              )}
              description={<span>{n.body} · {new Date(n.createdAt).toLocaleString("zh-CN")}</span>}
            />
          </List.Item>
        )}
      />
    </div>
  );
}
