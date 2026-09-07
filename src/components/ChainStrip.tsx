"use client";

import { Alert, Button, Tag, Typography } from "antd";
import Link from "next/link";
import { RightOutlined } from "@ant-design/icons";
import { useDocumentRead } from "@/components/useDocumentRead";
import { documentHref } from "@/lib/document-links";

/**
 * 链路视图条：委外全链 BH→WO→PO→JG→FL/TL→SH→CT→JS 的紧凑横向节点条。
 * 当前单据高亮；其余节点精确打开对应单据，不依赖列表筛选或分页。
 * 无其他可见节点时不展示；读取失败与无关联不同，显式提供重试。
 */

interface ChainNode {
  docType: string;
  label: string;
  id: number;
  docNo: string;
  status: string;
  statusLabel: string;
  current: boolean;
}

/** 与 DocStatusTag 保持一致的状态配色（该组件未导出色表，此处按同口径本地维护） */
const STATUS_COLORS: Record<string, string> = {
  draft: "default",
  pending: "processing",
  approved: "blue",
  in_progress: "geekblue",
  completed: "success",
  closed: "warning",
  void: "default",
};

export default function ChainStrip({ docType, id }: { docType: string; id: number }) {
  const read = useDocumentRead<{ nodes: ChainNode[] }>(docType && id ? `/api/outsource/chain?docType=${encodeURIComponent(docType)}&id=${id}` : null);
  const invalid = read.data && (!Array.isArray(read.data.nodes) || read.data.nodes.some(n => !n ||
    typeof n.docType !== "string" || typeof n.docNo !== "string" || typeof n.label !== "string" ||
    typeof n.status !== "string" || typeof n.statusLabel !== "string" || typeof n.current !== "boolean" || !Number.isSafeInteger(n.id)));
  const error = read.error ?? (invalid ? "关联链路响应格式异常" : null);
  if (error) return <Alert type="warning" showIcon message="关联链路暂不可用"
    description={`${error}。这不代表没有关联单据。`}
    action={<Button size="small" onClick={read.retry}>重试</Button>} style={{ marginBottom: 12 }} />;
  if (!read.data) return read.phase === "loading" ? <div role="status" style={{ marginBottom: 12 }}>正在读取关联链路…</div> : null;
  const nodes = read.data.nodes;
  if (nodes.length <= 1) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        rowGap: 6,
        marginBottom: 16,
        padding: "8px 12px",
        background: "rgba(0,0,0,0.02)",
        border: "1px solid rgba(5,5,5,0.06)",
        borderRadius: 6,
      }}
    >
      <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 8 }}>
        可见链路
      </Typography.Text>
      {nodes.map((n, idx) => {
        const tag = (
          <Tag
            color={STATUS_COLORS[n.status] ?? "default"}
            title={`${n.label} · ${n.statusLabel}`}
            style={{
              marginInlineEnd: 0,
              fontSize: 12,
              ...(n.current
                ? { fontWeight: 600, boxShadow: "0 0 0 1px currentColor inset" }
                : { cursor: "pointer" }),
              ...(n.status === "void" ? { textDecoration: "line-through" } : undefined),
            }}
          >
            {n.label} {n.docNo}
          </Tag>
        );
        const href = documentHref(n.docType, n.id);
        return (
          <span key={`${n.docType}-${n.id}`} style={{ display: "inline-flex", alignItems: "center" }}>
            {idx > 0 ? (
              <RightOutlined style={{ fontSize: 10, color: "rgba(0,0,0,0.35)", margin: "0 6px" }} />
            ) : null}
            {n.current || !href ? tag : <Link href={href}>{tag}</Link>}
          </span>
        );
      })}
    </div>
  );
}
