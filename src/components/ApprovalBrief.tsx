"use client";

/**
 * E3-06 审批简报卡（组件）：在审批那一刻把判断所需上下文送到眼前。
 * 简报不代替审批校验；失败显式披露并可重试，不把不可用伪装成无异常。
 */
import { Alert, Button, Card, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useDocumentRead } from "@/components/useDocumentRead";
import { formatQty } from "@/components/format";

interface BriefLine {
  skuId: number; code: string; name: string; baseUom: string;
  docQty: number; onHand: number; daily: number; daysCover: number | null; openSupply: number;
  recentOrders: { docType: string; docNo: string; status: string; daysAgo: number }[];
  flags: string[];
}
interface Brief {
  scopeNote?: string;
  docNo: string;
  origin: { fromSuggestion: boolean; note: string };
  lines: BriefLine[];
  summary: { lineCount: number; flaggedLines: number; totalQty: number };
}

export default function ApprovalBrief({ docType, docId }: { docType: string; docId: number }) {
  const read = useDocumentRead<Brief>(docType && docId ? `/api/inbox/approval-brief?docType=${encodeURIComponent(docType)}&docId=${docId}` : null);
  const data = read.data;
  const invalid = data && (typeof data.docNo !== "string" || typeof data.origin?.note !== "string" ||
    typeof data.origin?.fromSuggestion !== "boolean" || !Number.isFinite(data.summary?.lineCount) ||
    !Number.isFinite(data.summary?.flaggedLines) || !Array.isArray(data.lines) || data.lines.some(line =>
      !line || !Number.isSafeInteger(line.skuId) || typeof line.code !== "string" || typeof line.name !== "string" ||
      typeof line.baseUom !== "string" || ![line.docQty, line.onHand, line.daily, line.openSupply].every(Number.isFinite) ||
      (line.daysCover !== null && !Number.isFinite(line.daysCover)) || !Array.isArray(line.flags) ||
      line.flags.some(flag => typeof flag !== "string") || !Array.isArray(line.recentOrders) ||
      line.recentOrders.some(order => !order || typeof order.docNo !== "string" || typeof order.docType !== "string" ||
        typeof order.status !== "string" || !Number.isFinite(order.daysAgo))));
  const error = read.error ?? (invalid ? "审批简报响应格式异常" : null);
  if (error) return <Alert type="warning" showIcon message="审批简报暂不可用"
    description={`${error}。请核对原始单据后再判断；简报缺失不代表无异常。`}
    action={<Button size="small" onClick={read.retry}>重试</Button>} style={{ marginBottom: 12 }} />;
  if (!data) return read.phase === "loading" ? <div role="status" style={{ marginBottom: 12 }}>正在读取审批简报…</div> : null;

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
          <>{data.summary.lineCount === 0 ? "暂无明细，不能进行简报判断。" : data.summary.flaggedLines > 0
            ? `${data.summary.lineCount} 行中 ${data.summary.flaggedLines} 行有关注点，请留意下方标记。`
            : `${data.summary.lineCount} 行，未发现明显异常。`}
          {data.scopeNote ? <div>{data.scopeNote}</div> : null}</>
        }
      />
      <Table<BriefLine> rowKey="skuId" size="small" columns={cols} dataSource={data.lines} pagination={false} scroll={{ x: "max-content" }} />
    </Card>
  );
}
