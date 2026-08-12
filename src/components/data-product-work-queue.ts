import {
  DATA_PRODUCT_SOURCE_LABEL,
  dataProductStreamLabel,
  type DataProductAutomationLevel,
  type DataProductDefinition,
} from "@/components/data-products";
import {
  currentProductAutomation,
  evaluateProductSourceEvidence,
  type ProductEvidenceSummary,
  type ProductStreamEvidence,
} from "@/components/data-product-source-evidence";
import type { DataSourceReadiness } from "@/server/modules/report/data-source-readiness";
import type { DataProductReleaseReadiness } from "@/server/modules/report/data-product-release";

export type DataProductWorkStage = "safeguard" | "approval" | "release_ready" | "repair" | "monitor";

export interface DataProductWorkItem {
  productId: string;
  title: string;
  owner: string;
  decisionSlaHours: number;
  effectiveLevel: DataProductAutomationLevel;
  stage: DataProductWorkStage;
  nextAction: string;
  bottleneck: string;
  blockerState: ProductStreamEvidence["state"] | "release" | "none";
}

const STAGE_ORDER: Record<DataProductWorkStage, number> = {
  safeguard: 0,
  approval: 1,
  release_ready: 2,
  repair: 3,
  monitor: 4,
};

const BLOCKER_ORDER: Record<DataProductWorkItem["blockerState"], number> = {
  release: 0,
  stale: 1,
  degraded: 2,
  missing: 3,
  current: 4,
  none: 5,
};

function firstBlocker(summary: ProductEvidenceSummary): ProductStreamEvidence | null {
  const streams = summary.sources.flatMap((source) => source.streams);
  return [...streams].sort((a, b) => {
    const state = BLOCKER_ORDER[a.state] - BLOCKER_ORDER[b.state];
    if (state !== 0) return state;
    const source = a.source.localeCompare(b.source);
    return source !== 0 ? source : a.stream.localeCompare(b.stream);
  }).find((stream) => stream.state !== "current") ?? null;
}

function blockerLabel(blocker: ProductStreamEvidence | null): string {
  if (!blocker) return "当前必需来源与产品专属 SCM 事实均满足运行门禁";
  return `${DATA_PRODUCT_SOURCE_LABEL[blocker.source]} · ${dataProductStreamLabel(blocker.source, blocker.stream)}：${blocker.reason}`;
}

function repairAction(blocker: ProductStreamEvidence | null): string {
  if (!blocker) return "复核连接配置、身份覆盖和产品专属 SCM 事实";
  const source = DATA_PRODUCT_SOURCE_LABEL[blocker.source];
  const stream = dataProductStreamLabel(blocker.source, blocker.stream);
  if (blocker.state === "stale") return `刷新 ${source}的「${stream}」，并重做控制总量核对`;
  if (blocker.state === "degraded") return `解除 ${source}「${stream}」的授权/质量/时效限制`;
  return `补齐 ${source}「${stream}」的成功业务证据`;
}

function pendingEvidenceCurrent(
  product: DataProductDefinition,
  release: DataProductReleaseReadiness,
): boolean {
  const pending = release.pendingRelease;
  return pending != null
    && release.eligibleForRequest
    && pending.contractVersion === product.contractVersion
    && pending.sourceEvidenceDigest === release.currentScopeDigest
    && (pending.targetLevel === "A2" || product.maxAutomation === "A3");
}

/**
 * 将静态产品目录与实时来源/放行证据组成一条确定性工作队列。
 * 优先级不伪造精确的“商业价值分”：先止损，再审批，再放行，再修复，最后监控；
 * 同组只按产品已声明的决策 SLA 和可观测阻塞状态排序。
 */
export function buildDataProductWorkQueue(
  products: readonly DataProductDefinition[],
  dataSources: readonly DataSourceReadiness[],
  releases: readonly DataProductReleaseReadiness[],
): DataProductWorkItem[] {
  const releaseByProduct = new Map(releases.map((release) => [release.productId, release]));
  const items = products.map<DataProductWorkItem>((product) => {
    const summary = evaluateProductSourceEvidence(product, dataSources);
    const runtime = currentProductAutomation(summary);
    const release = releaseByProduct.get(product.id);
    const blocker = firstBlocker(summary);
    const effectiveLevel = release?.effectiveLevel ?? runtime.level;

    if (release?.activeRelease && !release.activeReleaseCurrent) {
      return {
        productId: product.id,
        title: product.title,
        owner: product.owner,
        decisionSlaHours: product.decisionSlaHours,
        effectiveLevel,
        stage: "safeguard",
        nextAction: `撤回已失效的 ${release.activeRelease.targetLevel} 放行，再按当前证据重新申请`,
        bottleneck: blockerLabel(blocker),
        blockerState: "release",
      };
    }

    if (release?.pendingRelease) {
      const current = pendingEvidenceCurrent(product, release);
      return {
        productId: product.id,
        title: product.title,
        owner: product.owner,
        decisionSlaHours: product.decisionSlaHours,
        effectiveLevel,
        stage: current ? "approval" : "safeguard",
        nextAction: current
          ? "由同责任域的另一名审批人复核控制总量、UAT 和回滚方案"
          : "拒绝已失效的申请；修复实时门禁后重新发起",
        bottleneck: current ? "实时证据与申请范围一致，等待独立会签" : blockerLabel(blocker),
        blockerState: "release",
      };
    }

    if (release?.activeReleaseCurrent && release.activeRelease) {
      return {
        productId: product.id,
        title: product.title,
        owner: product.owner,
        decisionSlaHours: product.decisionSlaHours,
        effectiveLevel,
        stage: "monitor",
        nextAction: "监控建议采纳、实际结果、误报与门禁自动降级",
        bottleneck: `当前 ${release.activeRelease.targetLevel} 放行有效`,
        blockerState: "none",
      };
    }

    if (runtime.level === "A1") {
      return {
        productId: product.id,
        title: product.title,
        owner: product.owner,
        decisionSlaHours: product.decisionSlaHours,
        effectiveLevel,
        stage: "release_ready",
        nextAction: "用当前批次完成控制总量和业务 UAT，登记回滚后发起放行",
        bottleneck: "来源证据可用于解释；尚缺产品级 UAT/会签",
        blockerState: "release",
      };
    }

    return {
      productId: product.id,
      title: product.title,
      owner: product.owner,
      decisionSlaHours: product.decisionSlaHours,
      effectiveLevel,
      stage: "repair",
      nextAction: repairAction(blocker),
      bottleneck: blockerLabel(blocker),
      blockerState: blocker?.state ?? "none",
    };
  });

  return items.sort((a, b) => {
    const stage = STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
    if (stage !== 0) return stage;
    const sla = a.decisionSlaHours - b.decisionSlaHours;
    if (sla !== 0) return sla;
    const blocker = BLOCKER_ORDER[a.blockerState] - BLOCKER_ORDER[b.blockerState];
    return blocker !== 0 ? blocker : a.title.localeCompare(b.title, "zh-CN");
  });
}
