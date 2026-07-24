"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { fetchJson } from "@/components/fetchJson";

interface InboxItem {
  docType: string;
  docTypeLabel: string;
  id: number;
  docNo: string;
  title: string;
  createdByName: string | null;
  createdAt: string;
  href: string;
  version: number;
}

interface InboxData {
  total: number;
  pending: InboxItem[];
  submitted: InboxItem[];
}

const TYPE_COLORS: Record<string, string> = {
  bh: "cyan",
  wo: "blue",
  po: "geekblue",
  pc: "purple",
  jg: "volcano",
  fl: "orange",
  tl: "gold",
  sh: "lime",
  ct: "magenta",
  js: "green",
  stock_doc: "default",
  pd: "default",
};

/** 等待时长（提交→现在）人性化：X天 / X小时 / 不足1小时 */
function humanizeWait(createdAt: string): string {
  const hours = dayjs().diff(dayjs(createdAt), "hour");
  if (hours >= 24) return `${Math.floor(hours / 24)}天`;
  if (hours >= 1) return `${hours}小时`;
  return "不足1小时";
}

export default function InboxClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<InboxData | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchJson<InboxData>("/api/inbox"));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns = (actionText: string): ColumnsType<InboxItem> => [
    {
      title: "类型",
      dataIndex: "docTypeLabel",
      width: 130,
      render: (v: string, r) => <Tag color={TYPE_COLORS[r.docType] ?? "default"}>{v}</Tag>,
    },
    { title: "单据号", dataIndex: "docNo", width: 180 },
    { title: "摘要", dataIndex: "title", ellipsis: true },
    { title: "制单人", dataIndex: "createdByName", width: 100, render: (v: string | null) => v ?? "—" },
    {
      title: "提交时间",
      dataIndex: "createdAt",
      width: 150,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm"),
    },
    {
      title: "等待时长",
      key: "wait",
      width: 100,
      render: (_, r) => humanizeWait(r.createdAt),
    },
    {
      title: "操作",
      key: "_actions",
      width: 90,
      render: (_, r) => (
        <Button type="link" size="small" href={r.href}>
          {actionText}
        </Button>
      ),
    },
  ];

  const empty = !loading && data != null && data.pending.length === 0 && data.submitted.length === 0;

  return (
    <div>
      <Space style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          我的待办
        </Typography.Title>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      </Space>
      {empty ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 24 }}>
          当前无待办事项。
        </Typography.Paragraph>
      ) : (
        <>
          <Typography.Title level={5} style={{ marginTop: 8 }}>
            待我审批（{data?.total ?? 0}）
          </Typography.Title>
          <Table<InboxItem>
            rowKey={(r) => `${r.docType}-${r.id}`}
            size="middle"
            columns={columns("去处理")}
            dataSource={data?.pending ?? []}
            loading={loading}
            pagination={false}
            locale={{ emptyText: "没有等待您审批的单据" }}
            style={{ marginBottom: 24 }}
          />
          <Typography.Title level={5}>我提交的待审（{data?.submitted.length ?? 0}）</Typography.Title>
          <Table<InboxItem>
            rowKey={(r) => `${r.docType}-${r.id}`}
            size="middle"
            columns={columns("查看")}
            dataSource={data?.submitted ?? []}
            loading={loading}
            pagination={false}
            locale={{ emptyText: "没有您提交的待审单据" }}
          />
        </>
      )}
    </div>
  );
}
