"use client";

/** struct#15 系统告警：看门狗产出的数据过期/单据超时，与人工裁决复核清单分家（生命周期不同）。 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, List, Tag, Typography } from "antd";
import { fetchJson } from "@/components/fetchJson";

interface Row { id: number; category: string; title: string; detail: string | null; severity: string | null; createdAt: string
  ackedAt?: string | null;
  ackedBy?: number | null;
  actionHref?: string | null;
  ownerRole?: string | null;
}
// 与 systemAlerts 的 category 一一对应；新增告警类别必须同步补标签，
// 否则页面上会冒出 job_failure 这样的英文 slug（护栏：tests/architecture/alert-category-labels.test.ts）
const CAT: Record<string, string> = {
  data_freshness: "数据过期",
  doc_aging: "单据超时",
  integration_token: "凭据到期",
  job_failure: "任务失败",
  data_product_gate: "决策门禁降级",
  inventory_cover: "断货预警",
  sales_spike: "爆单预警",
  transfer_cost: "调拨成本异常",
  data_quality: "数据质量核对",
};
const SEV: Record<string, string> = { high: "orange", medium: "gold" };

export default function AlertsClient() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setRows((await fetchJson<{ rows: Row[] }>("/api/alerts")).rows); }
    catch (e) { message.error((e as Error).message); }
    finally { setLoading(false); }
  }, [message]);
  useEffect(() => { void load(); }, [load]);
  const handleAck = async (id: number) => {
    try { await fetchJson(`/api/alerts/${id}/ack`, { method: "POST", body: JSON.stringify({}) }); message.success("已知悉（留审计，事实闭环后自动关闭）"); await load(); }
    catch (e) { message.error((e as Error).message); }
  };

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>系统告警</Typography.Title>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="看门狗自动产出的数据、单据与决策门禁告警。来源恢复、数据重传或单据流转后系统自动关闭；失效的 A2/A3 仍须责任人撤回或重新验收。人工裁决事项见「复核清单与提醒」。" />
      <List
        loading={loading}
        dataSource={rows}
        locale={{ emptyText: "当前无未处理告警" }}
        renderItem={(a) => (
          <List.Item actions={[
            a.actionHref ? <a key="go" href={a.actionHref}>去处理</a> : null,
            a.ackedAt ? <Tag key="ack" color="default">已知悉</Tag> : <Button key="ack" size="small" onClick={() => void handleAck(a.id)}>已知悉</Button>,
          ].filter(Boolean)}>
            <List.Item.Meta
              avatar={<Tag color={a.severity ? SEV[a.severity] : undefined}>{CAT[a.category] ?? a.category}</Tag>}
              title={a.title}
              description={<span>{a.detail} · {new Date(a.createdAt).toLocaleString("zh-CN")}</span>}
            />
          </List.Item>
        )}
      />
    </div>
  );
}
