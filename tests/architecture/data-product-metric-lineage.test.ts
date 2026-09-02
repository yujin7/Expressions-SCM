import { describe, expect, it } from "vitest";

import { DATA_PRODUCTS } from "@/components/data-products";
import { METRICS } from "@/components/metrics";
import {
  DATA_PRODUCT_METRIC_LINEAGE_CONTRACTS,
  dataProductMetricLineageScope,
} from "@/lib/data-product-metric-lineage";

describe("数据产品指标血缘契约", () => {
  it("每个产品引用的指标都有且只有一条计算血缘", () => {
    const keys = DATA_PRODUCT_METRIC_LINEAGE_CONTRACTS.map((item) => `${item.productId}\u0000${item.metricId}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const product of DATA_PRODUCTS) {
      const scope = dataProductMetricLineageScope(product.id, product.metricIds);
      expect(scope).toHaveLength(product.metricIds.length);
      expect(scope.every((item) => item.state !== "missing_contract")).toBe(true);
    }
  });

  it("血缘只能引用本产品已声明的流、SCM 事实或上游产品", () => {
    const productById = new Map(DATA_PRODUCTS.map((item) => [item.id, item]));
    for (const contract of DATA_PRODUCT_METRIC_LINEAGE_CONTRACTS) {
      const product = productById.get(contract.productId);
      expect(product, `未知产品 ${contract.productId}`).toBeDefined();
      expect(product!.metricIds).toContain(contract.metricId);
      expect(METRICS[contract.metricId]).toBeDefined();
      expect(contract.inputs.length).toBeGreaterThan(0);
      expect(contract.joinKeys.length).toBeGreaterThan(0);
      expect(contract.evidence.trim()).not.toBe("");
      expect(contract.nextAction.trim()).not.toBe("");
      for (const input of contract.inputs) {
        if (input.kind === "stream") {
          expect(input.source, `${contract.productId}/${contract.metricId} 数据流缺来源`).toBeDefined();
          expect(product!.requiredStreams[input.source!] ?? []).toContain(input.ref);
        } else if (input.kind === "scm_evidence") {
          expect(input.source).toBeUndefined();
          expect(product!.requiredScmEvidence).toContain(input.ref);
        } else {
          expect(input.source).toBeUndefined();
          expect((product!.requiredProducts ?? []).map((item) => item.productId)).toContain(input.ref);
        }
        expect(input.purpose.trim()).not.toBe("");
      }
    }
  });

  it("未完整实现的指标保持显式状态，不得由公式文案代替计算器", () => {
    const unfinished = DATA_PRODUCT_METRIC_LINEAGE_CONTRACTS.filter((item) => item.state !== "implemented");
    expect(unfinished.length).toBeGreaterThan(0);
    expect(unfinished.some((item) => item.state === "not_implemented")).toBe(true);
    expect(unfinished.some((item) => item.state === "partial")).toBe(true);
  });
});
