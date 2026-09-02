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
import {
  CROSS_SYSTEM_IDENTITY_LABEL,
  getCrossSystemIdentityStreamContract,
  type CrossSystemIdentitySource,
} from "@/lib/cross-system-identity";
import {
  CROSS_SYSTEM_SEMANTIC_LABEL,
  CROSS_SYSTEM_SEMANTIC_STREAM_CONTRACTS,
  getCrossSystemSemanticStreamContract,
  type CrossSystemSemanticSource,
} from "@/lib/cross-system-semantics";
import { JIANDAOYUN_FORM_CONTRACTS } from "@/server/integrations/jiandaoyun-contracts";
import {
  YONYOU_READ_CONTRACTS,
  yonyouContractStreamKey,
} from "@/server/integrations/yonyou-contracts";

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
      expect(product.sources.length).toBeGreaterThanOrEqual(1);
      if (product.sources.length === 1) {
        expect(product.sources).toEqual(["SCM"]);
        expect(product.requiredProducts?.length, `${product.id}: 单来源产品必须复用上游产品`)
          .toBeGreaterThan(0);
      }
      expect(DATA_PRODUCT_AUTHORITY_LABEL[product.targetAuthority]).toBeTruthy();
      for (const source of product.sources) {
        expect(DATA_PRODUCT_SOURCE_LABEL[source]).toBeTruthy();
        if (source !== "SCM") {
          expect(product.requiredStreams[source]?.length, `${product.id}:${source}`).toBeGreaterThan(0);
          expect(product.requiredIdentities[source]?.length, `${product.id}:${source}:identity`)
            .toBeGreaterThan(0);
        }
      }
      for (const [source, identities] of Object.entries(product.requiredIdentities)) {
        expect(product.sources).toContain(source);
        expect(source).not.toBe("SCM");
        expect(new Set(identities).size).toBe(identities.length);
        for (const identity of identities) {
          expect(CROSS_SYSTEM_IDENTITY_LABEL[identity], `${product.id}:${source}:${identity}`).toBeTruthy();
        }
      }
      for (const [source, streams] of Object.entries(product.requiredSemantics)) {
        expect(product.sources).toContain(source);
        expect(source).not.toBe("SCM");
        for (const [stream, semantics] of Object.entries(streams)) {
          expect(product.requiredStreams[source as keyof typeof product.requiredStreams], `${product.id}:${source}:${stream}:required-stream`)
            .toContain(stream);
          expect(semantics.length, `${product.id}:${source}:${stream}:semantic-controls`).toBeGreaterThan(0);
          expect(new Set(semantics).size).toBe(semantics.length);
          for (const semantic of semantics) {
            expect(CROSS_SYSTEM_SEMANTIC_LABEL[semantic], `${product.id}:${source}:${stream}:${semantic}`).toBeTruthy();
          }
        }
      }
    }
  });

  it("每条外部必需流都声明本产品使用的语义，且逐流契约逐项覆盖", () => {
    for (const product of DATA_PRODUCTS) {
      for (const [source, streams] of Object.entries(product.requiredStreams)) {
        if (source === "SCM") continue;
        const externalSource = source as CrossSystemSemanticSource;
        for (const stream of streams) {
          const required = product.requiredSemantics[externalSource]?.[stream];
          expect(required?.length, `${product.id}:${source}:${stream}:required-semantics`).toBeGreaterThan(0);
          const contract = getCrossSystemSemanticStreamContract(externalSource, stream);
          expect(contract, `${product.id}:${source}:${stream}:semantic-contract`).toBeTruthy();
          for (const domain of required ?? []) {
            expect(contract?.controls[domain], `${product.id}:${source}:${stream}:${domain}:control`).toBeTruthy();
          }
        }
      }
    }
  });

  it("每条外部必需流都有逐流身份提取契约，且每个必需身份至少有一条适用流", () => {
    for (const product of DATA_PRODUCTS) {
      for (const [source, streams] of Object.entries(product.requiredStreams)) {
        if (source === "SCM") continue;
        const externalSource = source as CrossSystemIdentitySource;
        const contracts = streams.map((stream) => {
          const contract = getCrossSystemIdentityStreamContract(externalSource, stream);
          expect(contract, `${product.id}:${source}:${stream}:identity-extraction-contract`).toBeTruthy();
          return contract!;
        });
        for (const domain of product.requiredIdentities[externalSource] ?? []) {
          expect(
            contracts.some((contract) => contract.identities[domain] != null),
            `${product.id}:${source}:${domain}:applicable-stream`,
          ).toBe(true);
        }
      }
    }
  });

  it("简道云与用友所有已实现读取契约都登记了身份可达性，避免新增流静默绕过", () => {
    for (const contract of JIANDAOYUN_FORM_CONTRACTS) {
      expect(
        getCrossSystemIdentityStreamContract("JIANDAOYUN", contract.key),
        `JIANDAOYUN:${contract.key}`,
      ).toBeTruthy();
    }
    for (const contract of YONYOU_READ_CONTRACTS) {
      const stream = yonyouContractStreamKey(contract.path);
      expect(getCrossSystemIdentityStreamContract("YONYOU", stream), `YONYOU:${stream}`).toBeTruthy();
    }
  });

  it("简道云与用友所有已实现读取契约都登记了业务语义，注册键唯一", () => {
    const keys = CROSS_SYSTEM_SEMANTIC_STREAM_CONTRACTS.map((contract) => `${contract.source}:${contract.stream}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const contract of JIANDAOYUN_FORM_CONTRACTS) {
      expect(
        getCrossSystemSemanticStreamContract("JIANDAOYUN", contract.key),
        `JIANDAOYUN:${contract.key}`,
      ).toBeTruthy();
    }
    for (const contract of YONYOU_READ_CONTRACTS) {
      const stream = yonyouContractStreamKey(contract.path);
      expect(getCrossSystemSemanticStreamContract("YONYOU", stream), `YONYOU:${stream}`).toBeTruthy();
    }
  });

  it("用友财务数据产品不得绕过 SCM 受控证据", () => {
    const byId = new Map(DATA_PRODUCTS.map((item) => [item.id, item]));
    const inheritedSources = (productId: string, visited = new Set<string>()): Set<string> => {
      if (visited.has(productId)) return new Set();
      visited.add(productId);
      const product = byId.get(productId)!;
      const sources = new Set<string>(product.sources);
      for (const dependency of product.requiredProducts ?? []) {
        for (const source of inheritedSources(dependency.productId, visited)) sources.add(source);
      }
      return sources;
    };
    const financial = DATA_PRODUCTS.filter((item) => item.targetAuthority === "financial");
    expect(financial.length).toBeGreaterThan(0);
    for (const product of financial) {
      const sources = inheritedSources(product.id);
      expect(sources.has("YONYOU"), product.id).toBe(true);
      expect(sources.has("SCM"), product.id).toBe(true);
    }
  });

  it("辅助证据有中文业务名、产品内不与放行依赖重叠", () => {
    for (const product of DATA_PRODUCTS) {
      for (const [source, streams] of Object.entries(product.supportingStreams ?? {})) {
        expect(source).not.toBe("SCM");
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

  it("组合决策通过无环产品依赖复用上游口径，而不是绕过上游 UAT", () => {
    const byId = new Map(DATA_PRODUCTS.map((product) => [product.id, product]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (productId: string) => {
      if (visited.has(productId)) return;
      expect(visiting.has(productId), `循环依赖：${productId}`).toBe(false);
      visiting.add(productId);
      const product = byId.get(productId);
      expect(product, `缺少上游产品：${productId}`).toBeTruthy();
      for (const dependency of product?.requiredProducts ?? []) {
        expect(dependency.productId).not.toBe(productId);
        expect(["A2", "A3"]).toContain(dependency.minimumLevel);
        expect(dependency.purpose.trim()).not.toBe("");
        visit(dependency.productId);
      }
      visiting.delete(productId);
      visited.add(productId);
    };
    for (const product of DATA_PRODUCTS) visit(product.id);

    expect(byId.get("replenishment-evidence")?.requiredProducts?.map((item) => item.productId))
      .toEqual(["demand-pulse", "unified-inventory", "supply-commitment"]);
    expect(byId.get("cash-sop")?.requiredProducts?.map((item) => item.productId))
      .toEqual(["demand-pulse", "unified-inventory", "supply-commitment", "net-margin-bridge"]);
    expect(byId.get("demand-pulse")?.requiredProducts?.map((item) => item.productId))
      .toEqual(["commerce-identity-control"]);
    expect(byId.get("net-margin-bridge")?.requiredProducts?.map((item) => item.productId))
      .toEqual(["demand-pulse", "order-to-cash"]);
    expect(byId.get("launch-readiness")?.requiredProducts?.map((item) => item.productId))
      .toEqual(["commerce-identity-control", "demand-pulse", "supply-commitment"]);
    expect(byId.get("exception-triangulation")?.requiredProducts?.map((item) => item.productId))
      .toEqual(["demand-pulse", "unified-inventory", "supply-commitment", "order-to-cash"]);
  });

  it("下游产品不重复直读已经由上游产品验收的外部原始流", () => {
    const byId = new Map(DATA_PRODUCTS.map((product) => [product.id, product]));
    const upstreamStreams = (productId: string, visited = new Set<string>()): Set<string> => {
      if (visited.has(productId)) return new Set();
      visited.add(productId);
      const product = byId.get(productId)!;
      const streams = new Set<string>();
      for (const dependency of product.requiredProducts ?? []) {
        const upstream = byId.get(dependency.productId)!;
        for (const [source, keys] of Object.entries(upstream.requiredStreams)) {
          for (const key of keys) streams.add(`${source}:${key}`);
        }
        for (const key of upstreamStreams(upstream.id, visited)) streams.add(key);
      }
      return streams;
    };

    for (const product of DATA_PRODUCTS.filter((item) => (item.requiredProducts?.length ?? 0) > 0)) {
      const inherited = upstreamStreams(product.id);
      const duplicated = Object.entries(product.requiredStreams)
        .flatMap(([source, streams]) => streams.map((stream) => `${source}:${stream}`))
        .filter((stream) => inherited.has(stream));
      expect(duplicated, product.id).toEqual([]);
    }
  });
});
