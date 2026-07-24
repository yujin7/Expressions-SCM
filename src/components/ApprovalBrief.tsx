"use client";

/**
 * E3-06 审批简报卡（组件）：在审批那一刻把判断所需上下文送到眼前。
 * 加载失败不得阻断审批——静默降级为不显示。
 */
import { useEffect, useState } from "react";
import { Alert, Card, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";

interface BriefLine {
  skuId: number; code: string; name: string; baseUom: string;
  docQty: number; onHand: number; daily: number; daysCover: number | null; openSupply: number;
  recentOrders: { docType: string; docNo: string; status: string; daysAgo: number }[];
  flags: string[];
}
interface Brief {
  docNo: string;
  origin: { fromSuggestion: boolean; note: string };
  lines: BriefLine[];
  summary: { lineCount: number; flaggedLines: number; totalQty: number };
}

export default function ApprovalBrief({ docType, docId }: { docType: string; docId: number }) {
  const [data, setData] = useState<Brief | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!docType || !docId) return;
    fetchJson<Brief>(`/api/inbox/approval-brief?docType=${encodeURIComponent(docType)}&docId=${docId}`)
      .then(setData)
      .catch(() => setFailed(true)); // 简报失败绝不阻断审批
  }, [docType, docId]);

  if (failed || !data) return null;

  const cols: ColumnsType<BriefLine> = [
    { title: "SKU", dataIndex: "code", width: 130, render: (v: string, r) => <Tooltip title={r.name}><span>{v}</span></Tooltip> },
    { title: "本单量", dataIndex: "docQty", width: 90, align: "right", render: (v: number, r) => `${formatQty(String(v))} ${r.baseUom}` },
    { title: "在库", dataIndex: "onHand", width: 90, align: "right", render: (v: number) => formatQty(String(v)) },
    { title: "可销天数", dataIndex: "daysCover", width: 95, align: "right", render: (v: number | null) => (v == null ? <Typography.Text type="secondary">无动销</Typography.Text> : Math.round(v)) },
    { title: "在途/在制", dataIndex: "openSupply", width: 100, align: "right", render: (v: number) => (v > 0 ? formatQty(String(v)) : "—") },
    {
      title: "关注点",
      dataIndex: "flags",
      render: (flags: string[], r) => (
        <Space size={4} wrap>
          {flags.map((f) => <Tag key={f} color="orange">{f}</Tag>)}
          {r.recentOrders.map((o) => (
            <Tooltip key={o.docNo} title={`${o.status}，${o.daysAgo} 天前`}>
              <Tag color="red">{o.docType} {o.docNo}</Tag>
            </Tooltip>
          ))}
          {flags.length === 0 && r.recentOrders.length === 0 ? <Typography.Text type="secondary">—</Typography.Text> : null}
        </Space>
      ),
    },
  ];

  return (
    <Card size="small" title={`审批简报 · ${data.docNo}`} style={{ marginBottom: 12 }}>
      <Alert
        type={data.origin.fromSuggestion ? "info" : "warning"}
        showIcon
        style={{ marginBottom: 8 }}
        message={data.origin.note}
        description={
          data.summary.flaggedLines > 0
            ? `${data.summary.lineCount} 行中 ${data.summary.flaggedLines} 行有关注点，请留意下方标记。`
            : `${data.summary.lineCount} 行，未发现明显异常。`
        }
      />
      <Table<BriefLine> rowKey="skuId" size="small" columns={cols} dataSource={data.lines} pagination={false} scroll={{ x: "max-content" }} />
    </Card>
  );
}
