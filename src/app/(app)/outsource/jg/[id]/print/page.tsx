"use client";

/**
 * 委外工单/加工通知打印页（0724 会议：标准化委外工单模板）。
 * ⚠ 合同条款为占位框架——正式条款待业务定稿（会议待办「委外工单模板制定」），定稿后仅改 TERMS。
 * 加工费随 API 角色脱敏（R9）；未生效单据带水印。
 */
import { use } from "react";
import { Alert, Button, Space, Spin } from "antd";
import { PrinterOutlined } from "@ant-design/icons";
import { useDocumentRead } from "@/components/useDocumentRead";
import { DOC_STATUS_LABELS } from "@/components/labels";
import { shanghaiDayOf } from "@/server/core/business-day";

interface JgDetail {
  id: number;
  docNo: string;
  status: string;
  woDocNo: string;
  supplierName: string;
  productSkuCode: string;
  productSkuName: string;
  qty: string;
  dueDate: string | null;
  feeRateCurrent?: string;
  orderType: string | null;
  pkgReadyDate: string | null;
  urgentFlag: boolean;
  priority: string | null;
  createdAt: string;
  createdByName: string | null;
  remark: string | null;
}

const shDate = (v: string | null | undefined): string =>
  v ? shanghaiDayOf(new Date(v)) : "—";

/** 条款占位（0724 待办：业务定稿后替换本数组即可） */
const TERMS_PLACEHOLDER = [
  "〔待定稿〕加工范围与工艺标准：以双方确认样品与本单 BOM 为准。",
  "〔待定稿〕物料与损耗：发料按 BOM 毛需求；损耗执行公司品类容差，超出部分月结从加工费扣除。",
  "〔待定稿〕交期与分批：按本单交期执行；分批入库须提前知会；改期须双方确认留痕。",
  "〔待定稿〕质量与验收：收货检验合格入库；不合格按让步/退换货约定处理。",
  "〔待定稿〕结算：按实收合格数量逐单结算，对账以我司系统结算单为准。",
];

export default function JgPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: detail, error, retry } = useDocumentRead<JgDetail>(`/api/outsource/jg/${id}`);

  if (error) return <Alert type="error" showIcon message={error} action={<Button onClick={retry}>重试</Button>} style={{ margin: 24 }} />;
  if (!detail) return <Spin style={{ display: "block", margin: "80px auto" }} />;
  const notEffective = ["draft", "pending", "void"].includes(detail.status);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 24, background: "#fff", color: "#000", position: "relative" }}>
      {notEffective && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", zIndex: 10 }}>
          <span style={{ fontSize: 96, color: "rgba(207,19,34,0.14)", transform: "rotate(-24deg)", fontWeight: 700 }}>
            {detail.status === "void" ? "已作废" : "草稿·未生效"}
          </span>
        </div>
      )}
      <style>{`@media print { .no-print { display: none !important; } } .jg-meta td { padding: 4px 14px 4px 0; font-size: 14px; }`}</style>
      <Space className="no-print" style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>打印</Button>
        <Button onClick={() => window.history.back()}>返回</Button>
        <Alert type="warning" showIcon message="条款为占位框架——正式模板待业务定稿（0724 会议待办）" />
      </Space>
      <h2 style={{ textAlign: "center", marginBottom: 4 }}>委 外 加 工 通 知 单</h2>
      <div style={{ textAlign: "center", fontSize: 13, marginBottom: 16 }}>单号：{detail.docNo}（工单 {detail.woDocNo}）</div>
      <table className="jg-meta"><tbody>
        <tr><td>加工厂：{detail.supplierName}</td><td>交期：{detail.dueDate ?? "—"}{detail.urgentFlag ? "（紧急）" : ""}</td></tr>
        <tr><td>成品：{detail.productSkuCode} {detail.productSkuName}</td><td>数量：{detail.qty}</td></tr>
        <tr><td>订单类型：{detail.orderType ?? "—"}</td><td>包材齐套日：{detail.pkgReadyDate ?? "—"}</td></tr>
        {detail.feeRateCurrent != null ? <tr><td>加工费单价：{detail.feeRateCurrent}</td><td>优先级：{detail.priority ?? "—"}</td></tr> : null}
        <tr><td>制单：{detail.createdByName ?? "—"} {shDate(detail.createdAt)}</td><td>状态：{DOC_STATUS_LABELS[detail.status] ?? detail.status}</td></tr>
      </tbody></table>
      {detail.remark ? <p style={{ fontSize: 13 }}>备注：{detail.remark}</p> : null}
      <h4 style={{ marginTop: 20 }}>合同条款（占位框架）</h4>
      <ol style={{ fontSize: 12.5, paddingLeft: 20, lineHeight: 1.8 }}>
        {TERMS_PLACEHOLDER.map((t, i) => <li key={i}>{t}</li>)}
      </ol>
      <table style={{ width: "100%", marginTop: 40, fontSize: 14 }}><tbody><tr>
        <td style={{ width: "50%" }}>委托方（盖章）：<div style={{ marginTop: 48 }}>日期：____________</div></td>
        <td>加工方（盖章）：<div style={{ marginTop: 48 }}>日期：____________</div></td>
      </tr></tbody></table>
    </div>
  );
}
