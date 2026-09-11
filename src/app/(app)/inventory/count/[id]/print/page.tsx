"use client";

/**
 * 盘点表打印页：仓库拿纸质表清点，实盘栏留白手工填写，盘完回系统录入。
 * 草稿/待审批均可打印（清点发生在提交之前）；已完成打印含实盘与差异（复盘存档用）。
 */
import { use } from "react";
import { Alert, Button, Space, Spin } from "antd";
import { PrinterOutlined } from "@ant-design/icons";
import { useDocumentRead } from "@/components/useDocumentRead";
import { DOC_STATUS_LABELS } from "@/components/labels";
import { shanghaiDayOf } from "@/server/core/business-day";

interface CountLine {
  id: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  bookQty: string;
  countedQty: string;
  diffQty: string;
}

interface CountDetail {
  id: number;
  docNo: string;
  status: string;
  mode: string;
  remark: string | null;
  warehouseName: string | null;
  lines: CountLine[];
  createdByName: string | null;
  createdAt: string;
}

const MODE_LABELS: Record<string, string> = { full: "定期全盘", partial: "抽盘（循环抽点）" };

/** 上海时区日期（与 PO 打印页同口径） */
const shDate = (v: string | null | undefined): string =>
  v
    ? shanghaiDayOf(new Date(v))
    : "—";

export default function CountPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: detail, error, retry } = useDocumentRead<CountDetail>(`/api/inventory/count/${id}`);

  if (error) return <Alert type="error" showIcon message={error} action={<Button onClick={retry}>重试</Button>} style={{ margin: 24 }} />;
  if (!detail) return <Spin style={{ display: "block", margin: "80px auto" }} />;

  // 已完成=存档表（打印实盘与差异）；其余=清点表（实盘/差异留白手填）
  const isArchive = detail.status === "completed";

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 24, background: "#fff", color: "#000" }}>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: #fff; }
        }
        .pd-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
        .pd-table th, .pd-table td { border: 1px solid #333; padding: 6px 8px; font-size: 13px; }
        .pd-table th { background: #f2f2f2; }
        .pd-meta td { padding: 3px 12px 3px 0; font-size: 14px; }
        .pd-blank { min-width: 90px; }
      `}</style>
      <Space className="no-print" style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>
          打印
        </Button>
        <Button onClick={() => window.history.back()}>返回</Button>
        {!isArchive && <Alert type="info" showIcon message="清点表：实盘/差异栏留白，纸面清点后回系统逐行录入" />}
      </Space>

      <h2 style={{ textAlign: "center", marginBottom: 4 }}>库 存 盘 点 表</h2>
      <div style={{ textAlign: "center", fontSize: 13, marginBottom: 16 }}>单号：{detail.docNo}</div>

      <table className="pd-meta">
        <tbody>
          <tr>
            <td>仓库：{detail.warehouseName ?? "—"}</td>
            <td>模式：{MODE_LABELS[detail.mode] ?? detail.mode}</td>
            <td>状态：{DOC_STATUS_LABELS[detail.status] ?? detail.status}</td>
          </tr>
          <tr>
            <td>制单人：{detail.createdByName ?? "—"}</td>
            <td>制单日期：{shDate(detail.createdAt)}</td>
            <td>盘点日期：____________</td>
          </tr>
        </tbody>
      </table>
      {detail.remark && <p style={{ fontSize: 13, marginTop: 8 }}>备注：{detail.remark}</p>}

      <table className="pd-table">
        <thead>
          <tr>
            <th style={{ width: 36 }}>#</th>
            <th>物料编码</th>
            <th>物料名称</th>
            <th style={{ width: 70 }}>单位</th>
            <th style={{ width: 100, textAlign: "right" }}>账面数</th>
            <th className="pd-blank" style={{ textAlign: "right" }}>实盘数</th>
            <th className="pd-blank" style={{ textAlign: "right" }}>差异</th>
            <th className="pd-blank">备注</th>
          </tr>
        </thead>
        <tbody>
          {detail.lines.map((l, i) => (
            <tr key={l.id}>
              <td>{i + 1}</td>
              <td>{l.skuCode}</td>
              <td>{l.skuName}</td>
              <td>{l.baseUom}</td>
              <td style={{ textAlign: "right" }}>{l.bookQty}</td>
              <td style={{ textAlign: "right" }}>{isArchive ? l.countedQty : ""}</td>
              <td style={{ textAlign: "right" }}>{isArchive ? l.diffQty : ""}</td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>

      <table style={{ width: "100%", marginTop: 40, fontSize: 14 }}>
        <tbody>
          <tr>
            <td style={{ width: "33%" }}>盘点人（签字）：</td>
            <td style={{ width: "33%" }}>复核人（签字）：</td>
            <td>日期：____________</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
