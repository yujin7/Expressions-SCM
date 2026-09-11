import { describe, expect, it } from "vitest";
import { identityBulkReview } from "@/app/(app)/report/decision-studio/identity-bulk-review";
import { identityBulkPayload } from "@/app/(app)/report/decision-studio/identity-bulk-result";
import { emptyPlatformSkuIdentityGap } from "@/server/modules/report/platform-sku-identity-gap";
import { platformSkuIdentityView } from "@/server/modules/report/platform-sku-identity-view";

function fixture() {
  const data = emptyPlatformSkuIdentityGap("test");
  data.exactHits = (["crosswalk", "related_goods", "unit_daily", "bundle_single"] as const).map((source, index) => ({
    skuId: index + 1, skuCode: `SKU-${index}`, shopName: `店铺-${index}`, platformSkuId: `平台-${index}`, source, paidAmount: "12.34",
  }));
  data.pddExactHits = (["merchant_code", "cost_standard"] as const).map((source, index) => ({
    skuId: index + 1, skuCode: `SKU-${index}`, shopName: `店铺-${index}`, platformSkuId: `商品|商家-${index}`, source, productName: `商品-${index}`,
  }));
  data.barcodeFillHits = (["finance_master", "jst_mirror", "both"] as const).map((source, index) => ({
    skuId: index + 1, skuCode: `SKU-${index}`, skuName: `商品-${index}`, barcode: `条码-${index}`, source,
  }));
  return data;
}

describe("identity review snapshot", () => {
  it("shows the four actual Tmall evidence paths instead of calling all same-code", () => {
    const review = identityBulkReview("tmall", platformSkuIdentityView(fixture(), ["pmc"]));
    expect(review.items.map(row => row.sourceLabel)).toEqual(["对照表商家编码", "对照表关联货品", "单品日报子货品编码", "组合装单组件 × 1"]);
    expect(review.items[1]).toMatchObject({ shopName: "店铺-1", platformSkuId: "平台-1", skuCode: "SKU-1" });
  });
  it("preserves PDD shop, composite identity, product name and translation evidence", () => {
    const review = identityBulkReview("pdd", platformSkuIdentityView(fixture(), ["pmc"]));
    expect(review.items.map(row => row.sourceLabel)).toEqual(["商家编码同码", "商品成本标准翻译"]);
    expect(review.items[1]).toMatchObject({ shopName: "店铺-1", platformSkuId: "商品|商家-1", name: "商品-1" });
  });
  it("does not mislabel single-source barcode candidates as two-source agreement", () => {
    const review = identityBulkReview("barcode", platformSkuIdentityView(fixture(), ["pmc"]));
    expect(review.items.map(row => row.sourceLabel)).toEqual(["财务货品档案（单来源）", "聚水潭商品资料镜像（单来源）", "财务 + 聚水潭镜像一致"]);
  });
  it.each(["tmall", "pdd", "barcode"] as const)("%s does not send review labels or monetary data as write parameters", kind => {
    const review = identityBulkReview(kind, platformSkuIdentityView(fixture(), ["pmc"]));
    const payload = identityBulkPayload(kind, review.items);
    for (const item of payload.items) {
      expect(Object.keys(item).sort()).toEqual(kind === "barcode" ? ["barcode", "skuId"]
        : kind === "pdd" ? ["platform", "platformSkuId", "shopName", "skuId"] : ["platformSkuId", "shopName", "skuId"]);
      if (kind === "pdd") expect(item).toMatchObject({ platform: "pdd" });
    }
  });
  it("never reconstructs a warehouse user's masked amounts", () => {
    const original = fixture();
    const view = platformSkuIdentityView(original, ["warehouse"]);
    expect(identityBulkReview("tmall", view).items.every(row => row.paidAmount === undefined)).toBe(true);
    expect(original.exactHits[0].paidAmount).toBe("12.34");
  });
  it.each(["tmall", "pdd", "barcode"] as const)("%s handles no loaded snapshot without a write batch", kind => {
    expect(identityBulkReview(kind, null)).toMatchObject({ total: 0, omitted: 0, items: [] });
  });
});
