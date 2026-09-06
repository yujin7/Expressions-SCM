import type { PlatformSkuIdentityView } from "@/server/modules/report/platform-sku-identity-view";
import type { IdentityBulkItem, IdentityBulkKind } from "./identity-bulk-result";

export type IdentityReviewItem = IdentityBulkItem & {
  sourceLabel: string;
  name?: string | null;
  paidAmount?: string;
};

const TMALL_SOURCES: Record<PlatformSkuIdentityView["exactHits"][number]["source"], string> = {
  crosswalk: "对照表商家编码",
  related_goods: "对照表关联货品",
  unit_daily: "单品日报子货品编码",
  bundle_single: "组合装单组件 × 1",
};
const PDD_SOURCES: Record<PlatformSkuIdentityView["pddExactHits"][number]["source"], string> = {
  merchant_code: "商家编码同码",
  cost_standard: "商品成本标准翻译",
};
const BARCODE_SOURCES: Record<PlatformSkuIdentityView["barcodeFillHits"][number]["source"], string> = {
  finance_master: "财务货品档案（单来源）",
  jst_mirror: "聚水潭商品资料镜像（单来源）",
  both: "财务 + 聚水潭镜像一致",
};

/** One bounded snapshot for both the review table and the submitted batch. */
export function identityBulkReview(kind: IdentityBulkKind, data: PlatformSkuIdentityView | null) {
  const limit = kind === "barcode" ? 500 : 300;
  let candidates: IdentityReviewItem[];
  if (kind === "barcode") {
    candidates = (data?.barcodeFillHits ?? []).map(row => ({ ...row, name: row.skuName, sourceLabel: BARCODE_SOURCES[row.source] }));
  } else if (kind === "pdd") {
    candidates = (data?.pddExactHits ?? []).map(row => ({ ...row, name: row.productName, sourceLabel: PDD_SOURCES[row.source] }));
  } else {
    candidates = (data?.exactHits ?? []).map(row => ({ ...row, sourceLabel: TMALL_SOURCES[row.source] }));
  }
  return { kind, limit, total: candidates.length, omitted: Math.max(0, candidates.length - limit), items: candidates.slice(0, limit) };
}
