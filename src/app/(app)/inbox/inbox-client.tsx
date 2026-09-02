"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App, Button, Modal, Popconfirm, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { fetchJson, postJson } from "@/components/fetchJson";
import LoadErrorAlert from "@/components/LoadErrorAlert";

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  /* E5-03 批量审批：逐单独立、部分成功可见（失败分列+原因，不做全或无） */
  const [selected, setSelected] = useState<InboxItem[]>([]);
  const [approving, setApproving] = useState(false);
  const [batchResult, setBatchResult] = useState<{ approved: number; failed: number; outcomes: { docType: string; id: number; ok: boolean; error?: string }[] } | null>(null);
  const BATCHABLE = new Set(["bh", "wo", "po", "pc", "jg"]);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await fetchJson<InboxData>("/api/inbox", { signal: controller.signal });
      if (!controller.signal.aborted) setData(next);
    } catch (e) {
      if (!controller.signal.aborted) setLoadError((e as Error).message);
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  const doBatch = async () => {
    const items = selected.filter((r) => BATCHABLE.has(r.docType)).map((r) => ({ docType: r.docType, id: r.id, version: r.version }));
    if (items.length === 0) { message.info("所选单据均不支持批量审批"); return; }
    setApproving(true);
    try {
      const res = await postJson<{ approved: number; failed: number; outcomes: { docType: string; id: number; ok: boolean; error?: string }[] }>(
        "/api/inbox/batch-approve",
        { items },
      );
      setBatchResult(res);
      setSelected([]);
      void load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setApproving(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => () => requestRef.current?.abort(), []);

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
      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="待办" retrying={loading} />
      {empty ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 24 }}>
          当前无待办事项。
        </Typography.Paragraph>
      ) : (
        <>
          <Typography.Title level={5} style={{ marginTop: 8 }}>
            待我审批（{data ? data.total : "—"}）
          </Typography.Title>
          {selected.length > 0 ? (
            <div style={{ marginBottom: 8, padding: "8px 12px", background: "#e6f4ff", borderRadius: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Typography.Text>
                已选 {selected.length} 单
                {selected.filter((r) => !BATCHABLE.has(r.docType)).length > 0
                  ? `（其中 ${selected.filter((r) => !BATCHABLE.has(r.docType)).length} 单不支持批量，将跳过）`
                  : ""}
              </Typography.Text>
              <Space>
                <Button size="small" onClick={() => setSelected([])}>清除</Button>
                <Popconfirm
                  title={`将批量通过 ${selected.filter((r) => BATCHABLE.has(r.docType)).length} 单，逐单独立生效（失败不影响其他单）`}
                  onConfirm={() => void doBatch()}
                >
                  <Button size="small" type="primary" loading={approving}>批量通过</Button>
                </Popconfirm>
              </Space>
            </div>
          ) : null}
          <Table<InboxItem>
            rowKey={(r) => `${r.docType}-${r.id}`}
            size="middle"
            columns={columns("去处理")}
            dataSource={data?.pending ?? []}
            loading={loading}
            pagination={false}
            rowSelection={{
              selectedRowKeys: selected.map((r) => `${r.docType}-${r.id}`),
              preserveSelectedRowKeys: true,
              onChange: (_k, rows) => setSelected(rows.filter((r) => r != null)),
            }}
            locale={{ emptyText: loadError ? "数据未加载" : "没有等待您审批的单据" }}
            style={{ marginBottom: 24 }}
          />
          <Typography.Title level={5}>我提交的待审（{data ? data.submitted.length : "—"}）</Typography.Title>
          <Table<InboxItem>
            rowKey={(r) => `${r.docType}-${r.id}`}
            size="middle"
            columns={columns("查看")}
            dataSource={data?.submitted ?? []}
            loading={loading}
            pagination={false}
            locale={{ emptyText: loadError ? "数据未加载" : "没有您提交的待审单据" }}
          />
        </>
      )}
      <Modal
        open={batchResult != null}
        title="批量审批结果"
        onCancel={() => setBatchResult(null)}
        onOk={() => setBatchResult(null)}
        footer={null}
        width="min(640px, 100vw)"
      >
        {batchResult ? (
          <>
            <Alert
              type={batchResult.failed === 0 ? "success" : "warning"}
              showIcon
              style={{ marginBottom: 12 }}
              message={`成功 ${batchResult.approved} 单${batchResult.failed > 0 ? `，失败 ${batchResult.failed} 单` : ""}`}
            />
            {batchResult.failed > 0 ? (
              <Table
                size="small"
                rowKey={(r: { docType: string; id: number }) => `${r.docType}-${r.id}`}
                pagination={false}
                dataSource={batchResult.outcomes.filter((o) => !o.ok)}
                columns={[
                  { title: "单据", width: 110, render: (_: unknown, r: { docType: string; id: number }) => `${r.docType.toUpperCase()} #${r.id}` },
                  { title: "失败原因", dataIndex: "error", render: (v: string) => <Typography.Text type="danger">{v}</Typography.Text> },
                ]}
              />
            ) : null}
          </>
        ) : null}
      </Modal>
    </div>
  );
}
