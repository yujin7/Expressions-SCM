"use client";

import { Button, Popconfirm, Space, Typography } from "antd";
import type { JgMaterialBasis } from "@/lib/matflow-basis";
import { documentHref } from "@/lib/document-links";
import { formatAsOf } from "./format";

export default function MaterialBasisNotice({ basis, kind, disabled, onRefresh }: {
  basis: JgMaterialBasis | null; kind: "fl" | "tl"; disabled: boolean; onRefresh: () => void;
}) {
  if (!basis) return null;
  const documents = kind === "fl" ? basis.woOpenIssues : basis.openDocuments.filter(doc => doc.kind === kind);
  return <div style={{ marginBottom: 12, lineHeight: 1.6, overflowWrap: "anywhere" }}>
    <Typography.Text type="secondary">
      {kind === "fl"
        ? "预填=整张工单毛需求−同工单全部加工批次累计已批发料（最低0），不是本批次专属额度；退料不自动恢复额度。同工单同物料已有草稿/待批时不重复预填，请核对下方原单后手填本次需要量。"
        : "含工单外已发物料。已发/已退仅为本加工单累计，不是选定仓实物余量；请核对消耗、批次及实物后填写，默认0。"}
      {" "}依据不是预留，审批仍按最新事实校验。读取于 {formatAsOf(basis.observedAt)}。
    </Typography.Text>
    <Popconfirm title="刷新会重填本单未保存的物料数量，是否继续？" okText="刷新重填" cancelText="保留当前" disabled={disabled} onConfirm={onRefresh}>
      <Button size="small" type="link" disabled={disabled}>刷新依据并重填</Button>
    </Popconfirm>
    {documents.length > 0 && <details>
      <summary style={{ cursor: "pointer" }}>已有 {documents.length} 张草稿/待批，先核对避免重复建单</summary>
      <Space size={[8, 4]} wrap style={{ marginTop: 4 }}>
        {documents.map(doc => <a key={doc.id} href={documentHref(doc.kind, doc.id)!} target="_blank" rel="noopener noreferrer">
          {doc.docNo}{"jgDocNo" in doc ? ` · ${doc.jgDocNo}` : ""} · {doc.status === "draft" ? "草稿" : "待审批"}（新标签）
        </a>)}
      </Space>
    </details>}
  </div>;
}
