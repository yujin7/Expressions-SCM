import { describe, expect, it } from "vitest";

import {
  DATA_PRODUCTS,
  DATA_PRODUCT_AUTHORITY_LABEL,
  DATA_PRODUCT_SOURCE_LABEL,
} from "@/components/data-products";

describe("三方数据产品目录", () => {
  it("保持十个唯一、可执行的目标契约", () => {
    expect(DATA_PRODUCTS).toHaveLength(10);
    expect(new Set(DATA_PRODUCTS.map((item) => item.id)).size).toBe(DATA_PRODUCTS.length);
    for (const product of DATA_PRODUCTS) {
      expect(product.decision.trim()).not.toBe("");
      expect(product.grain.trim()).not.toBe("");
      expect(product.owner.trim()).not.toBe("");
      expect(product.releaseGate.trim()).not.toBe("");
      expect(product.sources.length).toBeGreaterThanOrEqual(2);
      expect(DATA_PRODUCT_AUTHORITY_LABEL[product.targetAuthority]).toBeTruthy();
      for (const source of product.sources) expect(DATA_PRODUCT_SOURCE_LABEL[source]).toBeTruthy();
    }
  });

  it("用友财务数据产品不得绕过 SCM 受控证据", () => {
    const financial = DATA_PRODUCTS.filter((item) => item.targetAuthority === "financial");
    expect(financial.length).toBeGreaterThan(0);
    for (const product of financial) {
      expect(product.sources).toContain("YONYOU");
      expect(product.sources).toContain("SCM");
    }
  });
});
