import { describe, expect, it } from "vitest";

import {
  DATA_PRODUCTS,
  DATA_PRODUCT_AUTOMATION_LABEL,
  DATA_PRODUCT_AUTHORITY_LABEL,
  DATA_PRODUCT_CADENCE_LABEL,
  DATA_PRODUCT_SOURCE_LABEL,
  DATA_PRODUCT_STREAM_LABEL,
} from "@/components/data-products";
import { METRICS } from "@/components/metrics";
import { SCM_EVIDENCE_LABEL } from "@/lib/scm-evidence";

describe("三方数据产品目录", () => {
  it("保持十一个唯一、可执行的目标契约", () => {
    expect(DATA_PRODUCTS).toHaveLength(11);
    expect(new Set(DATA_PRODUCTS.map((item) => item.id)).size).toBe(DATA_PRODUCTS.length);
    for (const product of DATA_PRODUCTS) {
      expect(product.decision.trim()).not.toBe("");
      expect(product.grain.trim()).not.toBe("");
      expect(product.owner.trim()).not.toBe("");
      expect(product.contractVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(DATA_PRODUCT_CADENCE_LABEL[product.cadence]).toBeTruthy();
      expect(product.decisionSlaHours).toBeGreaterThan(0);
      expect(product.metricIds.length).toBeGreaterThanOrEqual(2);
      expect(new Set(product.metricIds).size).toBe(product.metricIds.length);
      expect(DATA_PRODUCT_AUTOMATION_LABEL[product.maxAutomation]).toBeTruthy();
      expect(product.maxAutomation).not.toBe("A4");
      expect(product.automationGuardrail.trim()).not.toBe("");
      expect(product.requiredScmEvidence.length).toBeGreaterThan(0);
      expect(new Set(product.requiredScmEvidence).size).toBe(product.requiredScmEvidence.length);
      for (const evidenceKey of product.requiredScmEvidence) {
        expect(SCM_EVIDENCE_LABEL[evidenceKey], `${product.id}:${evidenceKey}`).toBeTruthy();
      }
      for (const metricId of product.metricIds) {
        expect(METRICS[metricId], `${product.id}:${metricId}`).toBeTruthy();
      }
      expect(product.releaseGate.trim()).not.toBe("");
      expect(product.sources.length).toBeGreaterThanOrEqual(2);
      expect(DATA_PRODUCT_AUTHORITY_LABEL[product.targetAuthority]).toBeTruthy();
      for (const source of product.sources) {
        expect(DATA_PRODUCT_SOURCE_LABEL[source]).toBeTruthy();
        if (source !== "SCM") {
          expect(product.requiredStreams[source]?.length, `${product.id}:${source}`).toBeGreaterThan(0);
        }
      }
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

  it("辅助证据有中文业务名、产品内不与放行依赖重叠", () => {
    for (const product of DATA_PRODUCTS) {
      for (const [source, streams] of Object.entries(product.supportingStreams ?? {})) {
        expect(DATA_PRODUCT_SOURCE_LABEL[source as keyof typeof DATA_PRODUCT_SOURCE_LABEL]).toBeTruthy();
        expect(new Set(streams).size).toBe(streams.length);
        for (const stream of streams) {
          expect(DATA_PRODUCT_STREAM_LABEL[stream], `${product.id}:${source}:${stream}`).toBeTruthy();
          expect(product.requiredStreams[source as keyof typeof product.requiredStreams] ?? [])
            .not.toContain(stream);
        }
      }
    }
  });
});
