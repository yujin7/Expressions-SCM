import { dCmp, dMulDiv, dSub } from "@/server/core/decimal";

export interface InboundMaterialFact {
  skuId: number;
  code: string;
  unit: string;
  gross: string | null;
  issued: string;
  returned: string;
}

/** D33-b uses planned gross usage, not R5 net standard usage or the shared physical balance. */
export function estimateInboundMaterials(lines: InboundMaterialFact[], woQty: string | null, inbound: string | null) {
  return lines.map(line => {
    const netIssued = dSub(line.issued, line.returned);
    const reason = inbound === null ? "入库依据不完整" : woQty === null || dCmp(woQty, "0") <= 0
      ? "工单数量无有效分母" : line.gross === null ? "工单外物料，缺毛用量依据"
        : dCmp(line.gross, "0") < 0 ? "工单毛用量异常" : undefined;
    // Multiply before division; rounding a per-unit ratio first distorts large receipt quantities.
    const expected = reason ? null : dMulDiv(inbound!, line.gross!, woQty!, 4);
    return { ...line, netIssued, expected, delta: expected === null ? null : dSub(netIssued, expected), reason };
  });
}
