"use client";

import { useEffect, useState } from "react";
import { Button, Empty, Space, Table, Tag, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import type { ExportJobRow } from "@/jobs/export-worker";
import { shanghaiTimestampOf } from "@/server/core/business-day";
import { useDocumentRead } from "@/components/useDocumentRead";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import ExportButton from "@/components/ExportButton";
import styles from "./exports.module.css";

type Row = ExportJobRow & { requestedByName: string | null; kindLabel?: string };
const STATUS_LABELS: Record<string, string> = { pending: "排队中", running: "生成中", done: "已完成", failed: "失败" };
const STATUS_COLORS: Record<string, string> = { pending: "default", running: "processing", done: "success", failed: "error" };

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "时间未知" : shanghaiTimestampOf(d);
}

function statusOf(row: Row) {
  return <Space direction="vertical" size={4}>
    <Tag color={STATUS_COLORS[row.status] ?? "default"}>{STATUS_LABELS[row.status] ?? row.status}</Tag>
    {row.status === "failed" ? <Typography.Text type="danger" className={styles.reason}>{row.error ?? "生成失败，请回到来源列表重新导出"}</Typography.Text> : null}
  </Space>;
}
function actionOf(row: Row) {
  return row.status === "done" ? <ExportButton href={`/api/export/jobs/${row.id}/download`} label={`下载 #${row.id}`} mode="download" /> : null;
}

/** Poll only after a successful settled read. A failed read requires explicit retry. */
export default function ExportsClient() {
  const { data, phase, error, retry } = useDocumentRead<{ rows: Row[] }>("/api/export/jobs");
  const [previous, setPrevious] = useState<Row[] | null>(null);
  const [background, setBackground] = useState(false);
  useEffect(() => { if (data) setPrevious(data.rows); }, [data]);
  useEffect(() => {
    if (phase !== "success" || !data?.rows.some(row => row.status === "pending" || row.status === "running")) return;
    const timer = setTimeout(() => { setBackground(true); retry(); }, 5000);
    return () => clearTimeout(timer);
  }, [data, phase, retry]);

  const loading = phase === "loading";
  // Keep completed-row download components mounted during polling, not during explicit refresh/error.
  const refreshingPrevious = background && loading && previous !== null;
  const rows = data?.rows ?? (refreshingPrevious ? previous : []);
  const refresh = () => { setBackground(false); retry(); };
  const hasActive = rows.some(row => row.status === "pending" || row.status === "running");
  const emptyText = phase === "error" ? "任务未加载，请重试" : loading ? "正在读取导出任务…" : "暂无导出任务；请从需要导出的列表发起";
  const columns: ColumnsType<Row> = [
    { title: "任务", key: "task", width: 160, render: (_, row) => <Space direction="vertical" size={2}>
      <Typography.Text strong>{row.kindLabel ?? row.kind}</Typography.Text><Typography.Text type="secondary">#{row.id}</Typography.Text>
    </Space> },
    { title: "状态 / 原因", key: "status", width: 220, render: (_, row) => statusOf(row) },
    { title: "行数", dataIndex: "rowCount", width: 100, align: "right", render: (value: number | null) => value == null ? "—" : value.toLocaleString("zh-CN") },
    { title: "申请 / 时间（上海）", key: "time", width: 225, render: (_, row) => <Space direction="vertical" size={2}>
      <Typography.Text>{row.requestedByName ?? "—"}</Typography.Text>
      <Typography.Text type="secondary">创建 {fmtTime(row.createdAt)}</Typography.Text>
      {row.finishedAt ? <Typography.Text type="secondary">结束 {fmtTime(row.finishedAt)}</Typography.Text> : null}
    </Space> },
    { title: "文件", key: "action", width: 240, render: (_, row) => actionOf(row) },
  ];
  return <div>
    <div className={styles.heading}>
      <Typography.Title level={4} style={{ margin: 0 }}>导出任务</Typography.Title>
      <Button icon={<ReloadOutlined />} aria-label="刷新导出任务" aria-busy={loading} loading={loading} onClick={refresh}>刷新</Button>
    </div>
    <Typography.Paragraph type="secondary" style={{ margin: "8px 0 12px" }}>
      显示最新 100 个任务。超过 5000 行的导出在后台生成；不会因离开本页而取消。
      {hasActive ? "有任务进行中，读取成功后每 5 秒更新。" : ""}
    </Typography.Paragraph>
    <LoadErrorAlert error={error} onRetry={refresh} subject="导出任务" />
    {refreshingPrevious ? <div role="status" className={styles.pollNotice}>显示上次成功读取的任务，正在更新；下载仍会核对当前权限。</div> : null}
    <div className={styles.desktop}>
      <Table<Row> rowKey="id" size="small" columns={columns} dataSource={rows}
        loading={loading && !refreshingPrevious} pagination={false} scroll={{ x: 945 }} locale={{ emptyText }} />
    </div>
    <div className={styles.mobile} aria-busy={loading}>
      {rows.length ? rows.map(row => <article key={row.id} className={styles.task} aria-label={`导出任务 #${row.id}`}>
        <div className={styles.heading}><Typography.Text strong>{row.kindLabel ?? row.kind} #{row.id}</Typography.Text>
          <Typography.Text>{row.rowCount == null ? "行数未知" : `${row.rowCount.toLocaleString("zh-CN")} 行`}</Typography.Text></div>
        {statusOf(row)}
        <Typography.Text type="secondary">申请人：{row.requestedByName ?? "—"}</Typography.Text>
        <Typography.Text type="secondary">创建：{fmtTime(row.createdAt)}（上海）</Typography.Text>
        {row.finishedAt ? <Typography.Text type="secondary">结束：{fmtTime(row.finishedAt)}（上海）</Typography.Text> : null}
        {actionOf(row)}
      </article>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />}
    </div>
  </div>;
}
