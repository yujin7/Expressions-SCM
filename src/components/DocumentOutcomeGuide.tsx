"use client";

import { Button } from "antd";
import DocStatusTag from "./DocStatusTag";
import type { DocumentReplacement } from "./document-replacement";
import styles from "./DocumentOutcomeGuide.module.css";

interface Props {
  kind: "stock" | "ct";
  status: string;
  closedReason?: string | null;
  actionReason?: string | null;
  replacement?: DocumentReplacement;
  onOpen: (id: number) => void;
  onCreateReplacement?: () => void;
  createBlockedReason?: string | null;
}

/** Read-only guidance: callers own authorization, exact navigation and explicit creation. */
export default function DocumentOutcomeGuide({ kind, status, closedReason, actionReason, replacement,
  onOpen, onCreateReplacement, createBlockedReason }: Props) {
  const ended = status === "void" || status === "closed";
  const links = [
    { label: "被替代原单", doc: replacement?.predecessor },
    { label: "后续替代单", doc: replacement?.successor },
  ].filter(item => item.doc != null);
  const canCreate = status === "void" && replacement?.canCreate === true
    && replacement.successor === null && replacement.reason === null && !!onCreateReplacement;
  if (!ended && !actionReason && links.length === 0) return null;
  return <section className={styles.guide} aria-label="单据状态与下一步">
    {ended && <div className={styles.row}>
      <strong>{status === "void" ? "作废原因" : "短关原因"}</strong>
      <span>{closedReason?.trim() || "历史未登记，请核对审计记录"}</span>
    </div>}
    {actionReason && <div className={styles.row}><strong>操作提示</strong><span>{actionReason}</span></div>}
    {links.length > 0 && <div className={styles.links}>
      {links.map(({ label, doc }) => <Button key={label} type="link" className={styles.link}
        onClick={() => onOpen(doc!.id)}>
        <span>{label}：{doc!.docNo}</span><DocStatusTag status={doc!.status} />
      </Button>)}
    </div>}
    {status === "void" && <>
      {!replacement && <p>替代资格尚未确认，请重新读取原单；不会按旧页面新建。</p>}
      {replacement?.reason && <p>{replacement.reason}</p>}
      {canCreate && <div className={styles.next}>
        <Button size="small" disabled={!!createBlockedReason} onClick={onCreateReplacement}>
          {kind === "ct" ? "新建替代退货单" : "新建替代单"}
        </Button>
        <span>{createBlockedReason || "保留原单，重新填写正确数据；只新建草稿。"}</span>
      </div>}
    </>}
    {ended && <p className={styles.boundary}>{kind === "ct"
      ? "作废不代表已退货或已冲销；请按原单流水核对实际结果。"
      : "作废或短关不冲销已过账库存；历史流水仍保留。"}</p>}
    {(status === "void" || links.length > 0) && <details className={styles.help}>
      <summary>替代单如何继续处理？</summary>
      <p>{kind === "ct"
        ? "重新选择采购订单、出库仓、实物批次和数量，再独立提交与审批。替代关系不证明该批次来自这张采购订单，仍须核对原收货记录与供应商。"
        : "重新填写类型、仓库、SKU、批次和数量，再按原流程独立提交、审批与执行；替代关系与业务来源、红字引用分别记录。"}</p>
      <p>若已有后续替代单，请先查看该单；后继仍有错误，应从作废后的后继继续，不回到旧原单分叉。</p>
    </details>}
  </section>;
}
