"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { fetchJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";

const TEMPLATE_LABELS: Record<string, string> = {
  bom: "BOM 表",
  inventory: "库存明细",
  expiry: "效期占比",
  sales: "销量汇总",
  leadtime: "在途/交期",
  transit: "在途进度表",
  demand: "需求达成表",
  pallet: "货盘情况表",
  npd: "NPD节点说明",
  stock_summary: "总库存明细",
};
const TABLE_LABELS: Record<string, string> = {
  spu_suggestion: "SPU 归组建议",
  bom_block: "BOM 块",
  processing_fee_candidate: "加工费候选",
  batch_stock: "批次效期",
  sales_monthly: "月销量",
  stock_opening_candidate: "库存明细（期初/快照）",
  sku_leadtime: "交期参考（1.1）",
  transit_ref: "在途参考",
};

interface JobRow {
  id: number;
  template: string;
  filename: string;
  status: "pending" | "validating" | "failed" | "done";
  okRows: number;
  failRows: number;
  createdAt: string;
}

interface JobSummaryRow {
  targetTable: string | null;
  status: string;
  count: number;
}

const JOB_STATUS_LABELS: Record<string, string> = {
  pending: "待处理",
  validating: "校验中",
  failed: "失败",
  done: "完成",
};

const JOB_STATUS_COLORS: Record<string, string> = {
  pending: "processing",
  validating: "warning",
  failed: "error",
  done: "success",
};

const STAGING_STATUS_LABELS: Record<string, string> = {
  pending: "待处理",
  validated: "已校验",
  error: "错误",
  committed: "已放行",
};

/** 展开行：拉取该任务的 staging 汇总（目标表 × 状态 × 行数） */
function JobSummary({ jobId }: { jobId: number }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<JobSummaryRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchJson<{ summary: JobSummaryRow[] }>(`/api/import/jobs/${jobId}`)
      .then((res) => {
        if (!cancelled) setRows(res.summary);
      })
      .catch((e: Error) => {
        if (!cancelled) message.error(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, message]);

  const columns: ColumnsType<JobSummaryRow> = [
    {
      title: "数据集",
      dataIndex: "targetTable",
      render: (v: string | null) =>
        v ? TABLE_LABELS[v] ?? <Typography.Text code>{v}</Typography.Text> : <Typography.Text type="secondary">（未放行）</Typography.Text>,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 120,
      render: (v: string) => STAGING_STATUS_LABELS[v] ?? v,
    },
    { title: "行数", dataIndex: "count", width: 100, align: "right" },
  ];

  return (
    <Table<JobSummaryRow>
      rowKey={(r) => `${r.targetTable ?? ""}::${r.status}`}
      size="small"
      columns={columns}
      dataSource={rows}
      loading={loading}
      pagination={false}
      locale={{ emptyText: "该任务暂无 staging 行" }}
      style={{ maxWidth: 520 }}
    />
  );
}

export default function JobsClient() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<JobRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：分页进 URL，密度与已保存视图存本地
  const listState = useListState({ key: "import-jobs", defaults: {}, defaultPageSize: 20 });
  const { page, pageSize } = listState;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson<{ data: JobRow[]; total: number }>(
        `/api/import/jobs?page=${page}&pageSize=${pageSize}`,
      );
      setRows(res.data);
      setTotal(res.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<JobRow> = [
    { title: "ID", dataIndex: "id", width: 70 },
    { title: "模板", dataIndex: "template", width: 160, render: (v: string) => <Tag>{TEMPLATE_LABELS[v] ?? v}</Tag> },
    { title: "文件名", dataIndex: "filename", ellipsis: true },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (v: string) => <Tag color={JOB_STATUS_COLORS[v] ?? "default"}>{JOB_STATUS_LABELS[v] ?? v}</Tag>,
    },
    { title: "成功行", dataIndex: "okRows", width: 90, align: "right" },
    {
      title: "失败行",
      dataIndex: "failRows",
      width: 90,
      align: "right",
      render: (v: number) =>
        v > 0 ? <Typography.Text type="danger">{v}</Typography.Text> : v,
    },
    {
      title: "时间",
      dataIndex: "createdAt",
      width: 160,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm"),
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        导入任务
      </Typography.Title>
      <ListToolbar
        state={listState}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        }
      />
      <Table<JobRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        expandable={{
          expandedRowRender: (r) => <JobSummary jobId={r.id} />,
        }}
        pagination={listState.paginationProps({ total: total })}
      />
    </div>
  );
}
