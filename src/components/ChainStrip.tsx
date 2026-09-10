"use client";

import { Alert, Button, Tag, Typography } from "antd";
import Link from "next/link";
import { useDocumentRead } from "@/components/useDocumentRead";
import { documentHref } from "@/lib/document-links";

/**
 * 关联单据：当前身份常驻，同类型多单据按需展开，不将同级单据画成前后关系。
 * 所有可见节点精确打开对应单据，不依赖列表筛选或分页。
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

function validChain(data: unknown, docType: string, id: number): data is { nodes: ChainNode[] } {
  if (!data || typeof data !== "object" || !("nodes" in data) || !Array.isArray(data.nodes)) return false;
  const identities = new Set<string>();
  for (const n of data.nodes) {
    if (!n || typeof n.docType !== "string" || typeof n.docNo !== "string" || !n.docNo.trim() ||
      typeof n.label !== "string" || !n.label.trim() || typeof n.status !== "string" ||
      typeof n.statusLabel !== "string" || typeof n.current !== "boolean" || !documentHref(n.docType, n.id) ||
      n.current !== (n.docType === docType && n.id === id)) return false;
    const identity = `${n.docType}-${n.id}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return data.nodes.length === 0 || data.nodes.some(n => n.current);
}

export default function ChainStrip({ docType, id }: { docType: string; id: number }) {
  const read = useDocumentRead<unknown>(docType && id ? `/api/outsource/chain?docType=${encodeURIComponent(docType)}&id=${id}` : null);
  const payload = read.data;
  const valid = validChain(payload, docType, id);
  const error = read.error ?? (read.phase === "success" && !valid ? "关联链路响应格式异常" : null);
  if (error) return <Alert type="warning" showIcon message="关联链路暂不可用"
    description={`${error}。这不代表没有关联单据。`}
    action={<Button size="small" onClick={read.retry}>重试</Button>} style={{ marginBottom: 12 }} />;
  if (!valid) return read.phase === "loading" ? <div role="status" style={{ marginBottom: 12 }}>正在读取关联链路…</div> : null;
  const nodes = payload.nodes;
  if (nodes.length <= 1) return null;
  const current = nodes.find(n => n.current)!;
  const groups = new Map<string, ChainNode[]>();
  for (const node of nodes) {
    if (node.current) continue;
    const group = groups.get(node.docType) ?? [];
    group.push(node);
    groups.set(node.docType, group);
  }
  const nodeTag = (n: ChainNode) => {
    const tag = <Tag color={STATUS_COLORS[n.status] ?? "default"}
      style={{ marginInlineEnd: 0, fontSize: 12, maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere",
        padding: "3px 7px", ...(n.current ? { fontWeight: 600, boxShadow: "0 0 0 1px currentColor inset" } : {}) }}>
      {n.label} {n.docNo} · {n.statusLabel}
    </Tag>;
    return n.current ? tag : <Link href={documentHref(n.docType, n.id)!}
      style={{ display: "inline-block", maxWidth: "100%" }}>{tag}</Link>;
  };

  return (
    <section aria-label="关联单据"
      style={{
        minWidth: 0,
        marginBottom: 16,
        padding: "8px 12px",
        background: "rgba(0,0,0,0.02)",
        border: "1px solid rgba(5,5,5,0.06)",
        borderRadius: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>当前单据</Typography.Text>
        {nodeTag(current)}
      </div>
      <Typography.Text type="secondary" style={{ display: "block", fontSize: 12, marginBottom: 6 }}>
        关联单据 · {nodes.length - 1}张可见
      </Typography.Text>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 6 }}>
        {[...groups].map(([type, group]) => group.length === 1
          ? <span key={type} style={{ maxWidth: "100%", minWidth: 0 }}>{nodeTag(group[0])}</span>
          : <details key={`${docType}-${id}-${type}`} style={{ maxWidth: "100%", minWidth: 0,
            border: "1px solid #d9d9d9", borderRadius: 6, padding: "3px 8px", background: "#fff" }}>
            <summary style={{ cursor: "pointer", fontSize: 12, lineHeight: "22px", overflowWrap: "anywhere" }}>
              {group[0].label.split("·", 1)[0]}（{group.length}张）
            </summary>
            <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "grid", gap: 6 }}>
              {group.map(n => <li key={`${n.docType}-${n.id}`} style={{ minWidth: 0 }}>{nodeTag(n)}</li>)}
            </ul>
          </details>)}
      </div>
    </section>
  );
}
