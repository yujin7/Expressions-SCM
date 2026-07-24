"use client";

/** #8 通知中心（站内）：展示异常/事件通知；飞书渠道另经 webhook 推送（FEISHU_WEBHOOK_URL 配置后生效）。 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, List, Tag, Typography } from "antd";
import Link from "next/link";
import { fetchJson } from "@/components/fetchJson";

interface Notice {
  id: number; channel: string; title: string; body: string; href: string | null;
  severity: string | null; status: string; createdAt: string; sentAt: string | null;
}
const SEV: Record<string, string> = { critical: "red", high: "orange", medium: "gold", info: "blue" };
const STATUS: Record<string, { color: string; label: string }> = {
  pending: { color: "default", label: "待发" }, sent: { color: "green", label: "已发" },
  skipped: { color: "default", label: "站内" }, failed: { color: "red", label: "失败" },
};

export default function NotificationsClient() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setRows((await fetchJson<{ rows: Notice[] }>("/api/notifications")).rows); }
    catch (e) { message.error((e as Error).message); }
    finally { setLoading(false); }
  }, [message]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>通知中心</Typography.Title>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="站内通知；如需推送到飞书群，运维在环境变量 FEISHU_WEBHOOK_URL 配置自定义机器人 webhook 后，同一批通知会自动推送。" />
      <List
        loading={loading}
        dataSource={rows}
        locale={{ emptyText: "暂无通知" }}
        renderItem={(n) => (
          <List.Item actions={n.href ? [<Link key="go" href={n.href}>查看</Link>] : []}>
            <List.Item.Meta
              avatar={n.severity ? <Tag color={SEV[n.severity]}>{n.severity}</Tag> : null}
              title={<>{n.title} <Tag color={STATUS[n.status]?.color} style={{ marginLeft: 6 }}>{STATUS[n.status]?.label ?? n.status}</Tag></>}
              description={<span>{n.body} · {new Date(n.createdAt).toLocaleString("zh-CN")}</span>}
            />
          </List.Item>
        )}
      />
    </div>
  );
}
