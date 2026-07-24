"use client";

/**
 * D21 采购单打印页（1.0）：给采购的"日 1 价值包"——审批完即可打出盖章发厂。
 * 价格列跟随 API 角色脱敏（R9）：无价格权限的角色打印出的是不含价单。
 * 合同固定条款为公司现行模板文字；改条款改这里（单点）。
 */
import { use, useCallback, useEffect, useState } from "react";
import { Alert, Button, Space, Spin } from "antd";
import { PrinterOutlined } from "@ant-design/icons";
import { fetchJson } from "@/components/fetchJson";

interface PoLine {
  id: number;
  skuCode: string;
  skuName: string;
  lineType: string;
  purchaseUom: string | null;
  uomFactor: string | null;
  qty: string;
  price?: string | null;
  taxIncluded?: boolean | null;
  taxRatePct?: string | null;
  baseUom: string;
}

interface PoDetail {
  id: number;
  docNo: string;
  status: string;
  supplierName: string;
  expectedDate: string | null;
  confirmedAt: string | null;
  createdByName: string | null;
  createdAt: string;
  remark: string | null;
  lines: PoLine[];
}

/** 精确十进制乘法（显示用；禁 float——业务文档金额不能漂移） */
function mulDec(a: string, b: string): string {
  const parse = (s: string): [bigint, number] => {
    const neg = s.startsWith("-");
    const t = neg ? s.slice(1) : s;
    const [i, f = ""] = t.split(".");
    const v = BigInt((i || "0") + f) * (neg ? -1n : 1n);
    return [v, f.length];
  };
  const [va, sa] = parse(a);
  const [vb, sb] = parse(b);
  let v = va * vb;
  let scale = sa + sb;
  // 半入舍位到 2 位
  while (scale > 2) {
    const rem = v % 10n;
    v = v / 10n + (rem >= 5n ? 1n : rem <= -5n ? -1n : 0n);
    scale--;
  }
  while (scale < 2) {
    v *= 10n;
    scale++;
  }
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
}

function addDec(a: string, b: string): string {
  const toC = (s: string) => {
    const neg = s.startsWith("-");
    const [i, f = ""] = (neg ? s.slice(1) : s).split(".");
    return BigInt((i || "0") + f.padEnd(2, "0").slice(0, 2)) * (neg ? -1n : 1n);
  };
  const v = toC(a) + toC(b);
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
}

const LINE_TYPE_LABELS: Record<string, string> = { raw: "原料", packaging: "包材" };
const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  pending: "待审批",
  approved: "已审批",
  in_progress: "执行中",
  completed: "已完成",
  closed: "已关闭",
  void: "已作废",
};
/** 上海时区日期（RT4 UX-P1-4：UTC 切片会与单号日期自相矛盾） */
const shDate = (v: string | null | undefined): string =>
  v ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(v)) : "—";

/** 公司现行采购合同固定条款（D21；文字有变更改此处即可） */
const CONTRACT_TERMS = [
  "交货：按本单「要求到货日」送达指定仓库；逾期须提前 3 个工作日书面知会采购。",
  "质量：按双方确认样品及国家标准验收；检验不合格品按《委外加工协议》让步/退换货条款处理。",
  "损耗：包材损耗在公司规定范围内由我司承担，超出 5% 部分由加工厂承担（会议纪要 2026-07-23）。",
  "结算：按实收合格数量逐单结算；对账以我司系统结算单为准。",
  "本单经供应商回签（或系统确认）后生效，未尽事宜按双方主合同执行。",
];

export default function PoPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [detail, setDetail] = useState<PoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await fetchJson<PoDetail>(`/api/outsource/po/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Alert type="error" showIcon message={error} style={{ margin: 24 }} />;
  if (!detail) return <Spin style={{ display: "block", margin: "80px auto" }} />;

  const hasPrice = detail.lines.some((l) => l.price != null);
  const total = hasPrice
    ? detail.lines.reduce((acc, l) => (l.price != null ? addDec(acc, mulDec(l.qty, l.price)) : acc), "0.00")
    : null;

  const notEffective = ["draft", "pending", "void"].includes(detail.status);
  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 24, background: "#fff", color: "#000", position: "relative" }}>
      {notEffective && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          <span style={{ fontSize: 96, color: "rgba(207,19,34,0.14)", transform: "rotate(-24deg)", fontWeight: 700, whiteSpace: "nowrap" }}>
            {detail.status === "void" ? "已作废" : "草稿·未生效"}
          </span>
        </div>
      )}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: #fff; }
        }
        .po-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
        .po-table th, .po-table td { border: 1px solid #333; padding: 6px 8px; font-size: 13px; }
        .po-table th { background: #f2f2f2; }
        .po-meta td { padding: 3px 12px 3px 0; font-size: 14px; }
      `}</style>
      <Space className="no-print" style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>
          打印
        </Button>
        <Button onClick={() => window.history.back()}>返回</Button>
        {!hasPrice && <Alert type="info" showIcon message="当前角色无价格权限——打印为不含价单" />}
        {notEffective && <Alert type="warning" showIcon message="本单尚未审批生效——打印件带水印，不可作为发厂依据（D21）" />}
      </Space>

      <h2 style={{ textAlign: "center", marginBottom: 4 }}>采 购 订 单</h2>
      <div style={{ textAlign: "center", fontSize: 13, marginBottom: 16 }}>单号：{detail.docNo}</div>

      <table className="po-meta">
        <tbody>
          <tr>
            <td>供应商：{detail.supplierName}</td>
            <td>要求到货日：{detail.expectedDate ?? "—"}</td>
          </tr>
          <tr>
            <td>制单人：{detail.createdByName ?? "—"}</td>
            <td>制单日期：{shDate(detail.createdAt)}</td>
          </tr>
          <tr>
            <td>单据状态：{STATUS_LABELS[detail.status] ?? detail.status}</td>
            <td>供应商确认：{detail.confirmedAt ? shDate(detail.confirmedAt) : "待回签"}</td>
          </tr>
        </tbody>
      </table>

      <table className="po-table">
        <thead>
          <tr>
            <th style={{ width: 36 }}>#</th>
            <th>物料编码</th>
            <th>物料名称</th>
            <th>类别</th>
            <th>采购单位</th>
            <th style={{ textAlign: "right" }}>数量</th>
            {hasPrice && <th style={{ textAlign: "right" }}>单价</th>}
            {hasPrice && <th style={{ textAlign: "right" }}>金额</th>}
            <th>税况</th>
          </tr>
        </thead>
        <tbody>
          {detail.lines.map((l, i) => (
            <tr key={l.id}>
              <td>{i + 1}</td>
              <td>{l.skuCode}</td>
              <td>{l.skuName}</td>
              <td>{LINE_TYPE_LABELS[l.lineType] ?? l.lineType}</td>
              <td>{l.purchaseUom ?? l.baseUom}</td>
              <td style={{ textAlign: "right" }}>{l.qty}</td>
              {hasPrice && <td style={{ textAlign: "right" }}>{l.price ?? "—"}</td>}
              {hasPrice && <td style={{ textAlign: "right" }}>{l.price != null ? mulDec(l.qty, l.price) : "—"}</td>}
              <td>{l.taxIncluded == null ? "—" : l.taxIncluded ? `含税${l.taxRatePct ? ` ${l.taxRatePct}%` : ""}` : "未税"}</td>
            </tr>
          ))}
          {hasPrice && total != null && (
            <tr>
              <td colSpan={7} style={{ textAlign: "right", fontWeight: 600 }}>
                合计
              </td>
              <td style={{ textAlign: "right", fontWeight: 600 }}>{total}</td>
              <td />
            </tr>
          )}
        </tbody>
      </table>

      {detail.remark && <p style={{ fontSize: 13, marginTop: 12 }}>备注：{detail.remark}</p>}

      <h4 style={{ marginTop: 20 }}>合同条款</h4>
      <ol style={{ fontSize: 12.5, paddingLeft: 20, lineHeight: 1.8 }}>
        {CONTRACT_TERMS.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ol>

      <table style={{ width: "100%", marginTop: 40, fontSize: 14 }}>
        <tbody>
          <tr>
            <td style={{ width: "50%" }}>
              需方（盖章）：
              <div style={{ marginTop: 48 }}>日期：____________</div>
            </td>
            <td>
              供方（盖章）：
              <div style={{ marginTop: 48 }}>日期：____________</div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
