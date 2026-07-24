"use client";

/** #8 通知中心（站内）：展示异常/事件通知；飞书渠道另经 webhook 推送（FEISHU_WEBHOOK_URL 配置后生效）。 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, List, Space, Tag, Typography } from "antd";
import Link from "next/link";
import { fetchJson, postJson } from "@/components/fetchJson";

interface Notice {
  id: number; channel: string; title: string; body: string; href: string | null;
  severity: string | null; status: string; createdAt: string; sentAt: string | null; readAt: string | null;
}
const SEV: Record<string, string> = { critical: "red", high: "orange", medium: "gold", info: "blue" };
const STATUS: Record<string, { color: string; label: string }> = {
  pending: { color: "default", label: "待发" }, sent: { color: "green", label: "已发" },
  skipped: { color: "default", label: "站内" }, failed: { color: "red", label: "失败" },
};

export default function NotificationsClient() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchJson<{ rows: Notice[]; unread: number }>("/api/notifications");
      setRows(d.rows); setUnread(d.unread ?? 0);
    }
    catch (e) { message.error((e as Error).message); }
    finally { setLoading(false); }
  }, [message]);
  const markRead = useCallback(async (id?: number) => {
    try { await postJson("/api/notifications", id ? { id } : { all: true }); void load(); }
    catch (e) { message.error((e as Error).message); }
  }, [load, message]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>通知中心</Typography.Title>
      <Space style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", width: "100%" }}>
        <Alert type="info" showIcon style={{ flex: 1 }}
          message={`站内通知（未读 ${unread}）；配置 FEISHU_WEBHOOK_URL 后同批通知自动推送到飞书群。`} />
        <Button onClick={() => void markRead()} disabled={unread === 0}>全部已读</Button>
      </Space>
      <List
        loading={loading}
        dataSource={rows}
        locale={{ emptyText: "暂无通知" }}
        renderItem={(n) => (
          <List.Item
            style={n.readAt ? { opacity: 0.55 } : undefined}
            actions={[
              ...(n.href ? [<Link key="go" href={n.href}>查看</Link>] : []),
              ...(n.readAt ? [] : [<a key="rd" onClick={() => void markRead(n.id)}>标记已读</a>]),
            ]}
          >
            <List.Item.Meta
              avatar={n.severity ? <Tag color={SEV[n.severity]}>{n.severity}</Tag> : null}
              title={<>{!n.readAt ? <Tag color="blue" style={{ marginRight: 6 }}>未读</Tag> : null}{n.title}</>}
              description={<span>{n.body} · {new Date(n.createdAt).toLocaleString("zh-CN")}</span>}
            />
          </List.Item>
        )}
      />
    </div>
  );
}
