"use client";

/** 建议闭环追踪：补货建议 / NPD 首单 生成的 BH 草稿 → 审批执行状态（只读） */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Card, Col, Row, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";

interface ClosedLoopRow {
  id: number;
  createdAt: string;
  docNo: string;
  source: string;
  lineCount: number;
  createdBy: string;
  currentStatus: string;
  statusLabel: string;
  downstreamWo: string;
}

interface ClosedLoopSummary {
  total: number;
  adopted: number;
  pending: number;
  rejected: number;
  deleted: number;
  adoptRate: number;
}

interface ClosedLoopData {
  rows: ClosedLoopRow[];
  total: number;
  summary: ClosedLoopSummary;
}

/** 采纳类=green，待审批=blue，否决/关闭=red，作废/删除=default(灰) */
function statusColor(status: string): string {
  if (["approved", "in_progress", "completed", "done"].includes(status)) return "green";
  if (["draft", "pending"].includes(status)) return "blue";
  if (["rejected", "closed"].includes(status)) return "red";
  return "default"; // void / 已删除
}

const SOURCE_COLORS: Record<string, string> = { 补货建议: "geekblue", NPD首单: "purple" };

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function ClosedLoopClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<ClosedLoopData | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      setData(await fetchJson<ClosedLoopData>(`/api/report/closed-loop?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const s = data?.summary;

  const columns: ColumnsType<ClosedLoopRow> = [
    { title: "生成时间", dataIndex: "createdAt", width: 160, render: (v: string) => fmtTime(v) },
    {
      title: "单号",
      dataIndex: "docNo",
      width: 170,
      render: (v: string) => (v ? <a href={`/outsource/bh?q=${encodeURIComponent(v)}`}>{v}</a> : "—"),
    },
    { title: "来源", dataIndex: "source", width: 110, render: (v: string) => <Tag color={SOURCE_COLORS[v] ?? "default"}>{v}</Tag> },
    { title: "行数", dataIndex: "lineCount", width: 80, align: "right" },
    { title: "发起人", dataIndex: "createdBy", width: 120 },
    {
      title: "当前状态",
      dataIndex: "statusLabel",
      width: 110,
      render: (v: string, r) => <Tag color={statusColor(r.currentStatus)}>{v}</Tag>,
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>建议闭环追踪</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="追踪补货建议 / NPD 首单生成的 BH 草稿，直至审批执行的全过程，据此看清建议是否被采纳。"
        description="采纳率 = 进入审批通过及以后状态（已审批/执行中/已完成）的草稿占比。单号对应 BH 单据不存在时记为「已删除」。只读，不产生任何写入。"
      />
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col><Card size="small"><Statistic title="建议草稿总数" value={s?.total ?? 0} /></Card></Col>
        <Col><Card size="small"><Statistic title="采纳率" value={s?.adoptRate ?? 0} precision={1} suffix="%" valueStyle={{ color: "#52c41a" }} /></Card></Col>
        <Col><Card size="small"><Statistic title="采纳中/已完成" value={s?.adopted ?? 0} valueStyle={{ color: "#52c41a" }} /></Card></Col>
        <Col><Card size="small"><Statistic title="待审批" value={s?.pending ?? 0} valueStyle={{ color: "#1677ff" }} /></Card></Col>
        <Col><Card size="small"><Statistic title="已否决/关闭" value={s?.rejected ?? 0} valueStyle={{ color: "#8c8c8c" }} /></Card></Col>
        {s?.deleted ? <Col><Card size="small"><Statistic title="已删除" value={s.deleted} valueStyle={{ color: "#8c8c8c" }} /></Card></Col> : null}
      </Row>
      <Table<ClosedLoopRow>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => { setPage(p); setPageSize(ps); },
        }}
      />
    </div>
  );
}
