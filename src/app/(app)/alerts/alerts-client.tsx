"use client";

/** struct#15 系统告警：看门狗产出的数据过期/单据超时，与人工裁决复核清单分家（生命周期不同）。 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, List, Tag, Typography } from "antd";
import { fetchJson } from "@/components/fetchJson";

interface Row { id: number; category: string; title: string; detail: string | null; severity: string | null; createdAt: string }
const CAT: Record<string, string> = { data_freshness: "数据过期", doc_aging: "单据超时" };
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

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>系统告警</Typography.Title>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="看门狗自动产出的数据/单据告警（数据过期、单据超时）。数据重传或单据流转后系统自动关闭。人工裁决事项见「复核清单与提醒」。" />
      <List
        loading={loading}
        dataSource={rows}
        locale={{ emptyText: "当前无未处理告警" }}
        renderItem={(a) => (
          <List.Item>
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
