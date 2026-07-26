"use client";

/**
 * 导出任务列表（UAT 缺口 #4）：各报表导出超过 5000 行时自动转入异步任务，在此下载。
 * 有 pending/running 任务时每 5s 自动刷新。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Space, Table, Tag, Tooltip, Typography } from "antd";
import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import type { ExportJobRow } from "@/jobs/export-worker";

type Row = ExportJobRow & { requestedByName: string | null; kindLabel?: string };

const STATUS_LABELS: Record<string, string> = {
  pending: "排队中",
  running: "生成中",
  done: "已完成",
  failed: "失败",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "default",
  running: "processing",
  done: "success",
  failed: "error",
};

const SH_FMT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : SH_FMT.format(d);
}

export default function ExportsClient() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetchJson<{ rows: Row[] }>("/api/export/jobs");
      setRows(res.rows);
    } catch (e) {
      if (!silent) message.error((e as Error).message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  // 有进行中的任务 → 每 5s 静默刷新
  const hasActive = rows.some((r) => r.status === "pending" || r.status === "running");
  useEffect(() => {
    if (hasActive && !timerRef.current) {
      timerRef.current = setInterval(() => void load(true), 5000);
    }
    if (!hasActive && timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [hasActive, load]);

  const columns: ColumnsType<Row> = [
    { title: "任务ID", dataIndex: "id", width: 80 },
    {
      title: "导出内容",
      dataIndex: "kind",
      width: 140,
      render: (v: string, r: Row) => r.kindLabel ?? v,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (v: string, r) =>
        v === "failed" ? (
          <Tooltip title={r.error ?? undefined}>
            <Tag color="error">失败</Tag>
          </Tooltip>
        ) : (
          <Tag color={STATUS_COLORS[v] ?? "default"}>{STATUS_LABELS[v] ?? v}</Tag>
        ),
    },
    { title: "行数", dataIndex: "rowCount", width: 90, render: (v: number | null) => v ?? "—" },
    { title: "申请人", dataIndex: "requestedByName", width: 110, render: (v: string | null) => v ?? "—" },
    { title: "创建时间", dataIndex: "createdAt", width: 170, render: (v: string) => fmtTime(v) },
    { title: "完成时间", dataIndex: "finishedAt", width: 170, render: (v: string | null) => fmtTime(v) },
    {
      title: "操作",
      width: 110,
      render: (_, r) =>
        r.status === "done" ? (
          <Button
            type="link"
            size="small"
            icon={<DownloadOutlined />}
            onClick={() => window.open(`/api/export/jobs/${r.id}/download`, "_blank")}
          >
            下载
          </Button>
        ) : r.status === "failed" ? (
          <Typography.Text type="danger" ellipsis style={{ maxWidth: 100 }}>
            {r.error ?? "失败"}
          </Typography.Text>
        ) : (
          "—"
        ),
    },
  ];

  return (
    <div>
      <Space style={{ justifyContent: "space-between", width: "100%", marginBottom: 12 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          导出任务
        </Typography.Title>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      </Space>
      <Typography.Paragraph type="secondary">
        各报表/列表导出超过 5000 行时会自动转为异步任务并在此列出；任务完成后点击「下载」获取 CSV。
        {hasActive ? "（有任务进行中，每 5 秒自动刷新）" : ""}
      </Typography.Paragraph>
      <Table<Row> rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={false} />
    </div>
  );
}
