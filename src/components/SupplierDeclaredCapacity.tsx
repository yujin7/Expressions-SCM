"use client";

import { Alert, Space, Typography } from "antd";
import { formatQty } from "@/components/format";
import type { DeclaredCapacityComparison } from "@/server/rules/declared-capacity";

export default function SupplierDeclaredCapacity({ value, supplierName }: { value: DeclaredCapacityComparison; supplierName: string }) {
  const comparable = value.state === "comparable";
  const qty = (n: string | null) => n == null ? "未知" : `${formatQty(n)} ${value.capacityUom ?? ""}`;
  return <Alert className="supplier-declared-capacity" type={value.overSurge || value.overNormal ? "warning" : "info"} showIcon
    message={<><span>供应商申报情景</span>{value.targetMonth && <> · <span style={{ whiteSpace: "nowrap" }}>{value.targetMonth}</span></>}<div>{comparable ? value.overSurge ? "超加班上限" : value.overNormal ? "超正常申报" : "未超正常申报" : "暂不可比较"}</div></>}
    description={<Space direction="vertical" size={4} style={{ width: "100%", overflowWrap: "anywhere" }}>
      {!comparable && <Typography.Text>{value.reason}</Typography.Text>}
      <Typography.Text>本系统计划 {formatQty(value.projectedQty)} {value.baseUom} · 核对日 {value.asOfDay}</Typography.Text>
      {comparable ? <Space wrap size={[16, 4]}>
        <span>正常申报 {qty(value.normalLimitQty)} · 差额 {qty(value.normalHeadroomQty)}</span>
        <span>加班情景 {qty(value.surgeLimitQty)} · 差额 {qty(value.surgeHeadroomQty)}</span>
      </Space> : <Typography.Text type="secondary">档案申报 {qty(value.declaredMonthlyCapacity)}；原样保留，不补零或换算。</Typography.Text>}
      <Typography.Text type="secondary">本系统未结JG全单计划量仅供比较，不含其他客户占用；差额不是可承诺产能，不自动放单。</Typography.Text>
      <details><summary>有效期与申报依据</summary><div>{value.capacityValidFrom ?? "未填"} 至 {value.capacityValidUntil ?? "未填"}</div><div>{value.capacityEvidence || "尚未提供依据"}</div></details>
      <Typography.Link href={`/master/supplier?q=${encodeURIComponent(supplierName)}`}>到供应商档案核对申报 →</Typography.Link>
    </Space>} style={{ marginBottom: 16 }} />;
}
