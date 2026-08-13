import {
  DATA_PRODUCT_SOURCE_LABEL,
  dataProductStreamLabel,
  type DataProductAutomationLevel,
  type DataProductDefinition,
} from "@/components/data-products";
import {
  currentProductAutomation,
  evaluateProductSourceEvidence,
  type ProductIdentityEvidence,
  type ProductEvidenceSummary,
  type ProductStreamEvidence,
} from "@/components/data-product-source-evidence";
import type { DataSourceReadiness } from "@/server/modules/report/data-source-readiness";
import type { DataProductOutcomeReadiness } from "@/server/modules/report/data-product-outcome";
import type { DataProductReleaseReadiness } from "@/server/modules/report/data-product-release";

export type DataProductWorkStage = "safeguard" | "approval" | "release_ready" | "repair" | "learning" | "monitor";
export type DataProductLearningState = "unavailable" | "empty" | "pending" | "unevaluated" | "measured";

export interface DataProductLearningSummary {
  state: DataProductLearningState;
  label: string;
  nextAction: string;
  bottleneck: string;
}

export interface DataProductWorkItem {
  productId: string;
  title: string;
  owner: string;
  decisionSlaHours: number;
  effectiveLevel: DataProductAutomationLevel;
  stage: DataProductWorkStage;
  nextAction: string;
  actionLabel: string;
  actionHref: string;
  bottleneck: string;
  blockerState: ProductStreamEvidence["state"] | "identity" | "release" | "outcome" | "none";
}

const PRODUCT_DECISION_HREF: Record<string, string> = {
  "commerce-identity-control": "/report/decision-studio?tab=identity",
  "demand-pulse": "/report/decision-studio?tab=external",
  "order-to-cash": "/report/margin",
  "unified-inventory": "/report/inventory-analytics",
  "supply-commitment": "/report/inbound-calendar",
  "net-margin-bridge": "/report/margin",
  "supplier-360": "/report/supplier-scorecard",
  "replenishment-evidence": "/replenish",
  "launch-readiness": "/npd",
  "exception-triangulation": "/report/data-health",
  "cash-sop": "/report/dashboard",
};

const IDENTITY_STREAMS = new Set([
  "tmall-sku-crosswalk-observation",
  "pdd-sku-crosswalk-observation",
  "vip-product-crosswalk-observation",
  "item-master",
]);

function productEvidenceHref(productId: string): string {
  return `/report/decision-studio?tab=readiness&product=${encodeURIComponent(productId)}#data-product-${encodeURIComponent(productId)}`;
}

function actionTarget(
  product: DataProductDefinition,
  stage: DataProductWorkStage,
  blocker: ProductStreamEvidence | null,
  identityBlocker: ProductIdentityEvidence | null,
  dataSources: readonly DataSourceReadiness[],
): Pick<DataProductWorkItem, "actionLabel" | "actionHref"> {
  if (stage === "monitor") {
    return {
      actionLabel: "进入业务分析",
      actionHref: PRODUCT_DECISION_HREF[product.id] ?? productEvidenceHref(product.id),
    };
  }

  if (stage === "learning") {
    return {
      actionLabel: "复盘真实结果",
      actionHref: productEvidenceHref(product.id),
    };
  }

  if (
    stage === "repair"
    && identityBlocker
    && identityBlocker.source !== "SCM"
    && (identityBlocker.evidence?.open ?? 0) > 0
  ) {
    return {
      actionLabel: "处理身份异常",
      actionHref: `/import/exceptions?status=open&scope=${encodeURIComponent(identityBlocker.source)}`,
    };
  }

  if (
    stage === "repair"
    && blocker
    && blocker.source !== "SCM"
    && IDENTITY_STREAMS.has(blocker.stream)
  ) {
    const source = dataSources.find((row) => row.key === blocker.source);
    if ((source?.openIdentityExceptions ?? 0) > 0) {
      return {
        actionLabel: "处理身份异常",
        actionHref: `/import/exceptions?status=open&scope=${encodeURIComponent(blocker.source)}`,
      };
    }
  }

  return {
    actionLabel: stage === "repair" ? "查看逐流证据" : "打开产品门禁",
    actionHref: productEvidenceHref(product.id),
  };
}

const STAGE_ORDER: Record<DataProductWorkStage, number> = {
  safeguard: 0,
  approval: 1,
  release_ready: 2,
  repair: 3,
  learning: 4,
  monitor: 5,
};

const BLOCKER_ORDER: Record<DataProductWorkItem["blockerState"], number> = {
  release: 0,
  stale: 1,
  identity: 2,
  degraded: 3,
  missing: 4,
  current: 5,
  outcome: 6,
  none: 7,
};

export function summarizeDataProductLearning(
  outcome: DataProductOutcomeReadiness | undefined,
): DataProductLearningSummary {
  if (!outcome) {
    return {
      state: "unavailable",
      label: "结果台账未加载",
      nextAction: "加载并核验真实结果台账；结果可见前不得宣称数据产品已产生价值",
      bottleneck: "真实结果台账未加载，无法验证采纳、误报、处理时长或业务影响",
    };
  }
  if (outcome.outcomeCount === 0) {
    return {
      state: "empty",
      label: "尚无真实结果",
      nextAction: "从第一条可核验证据开始登记真实业务决定与结果，不以预测收益代替",
      bottleneck: "当前有效放行尚无真实结果样本",
    };
  }
  if (outcome.pendingCount > 0) {
    return {
      state: "pending",
      label: `${outcome.pendingCount} 条待观察`,
      nextAction: `补齐 ${outcome.pendingCount} 条待观察事项的真实结果与证据编号`,
      bottleneck: `${outcome.pendingCount} 条结果尚未闭环；采纳、误报与实际影响仍不完整`,
    };
  }
  if (outcome.evaluatedDecisionCount === 0) {
    return {
      state: "unevaluated",
      label: "仅有暂缓记录",
      nextAction: "补齐至少一条已评价的真实业务决定；暂缓记录不计入采纳率",
      bottleneck: `已有 ${outcome.outcomeCount} 条记录但均未形成可评价决定`,
    };
  }
  return {
    state: "measured",
    label: "已形成真实反馈",
    nextAction: "持续复核采纳、实际结果、误报、处理时长与门禁自动降级",
    bottleneck: `已评价 ${outcome.evaluatedDecisionCount} 条 · 已形成结果 ${outcome.terminalResultCount} 条 · 待观察 0 条`,
  };
}

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

function firstIdentityBlocker(summary: ProductEvidenceSummary): ProductIdentityEvidence | null {
  const rank = { not_implemented: 0, partial: 1, missing: 2, ready: 3 } as const;
  return [...summary.identityGates]
    .sort((a, b) => {
      const state = rank[a.state] - rank[b.state];
      if (state !== 0) return state;
      const source = a.source.localeCompare(b.source);
      return source !== 0 ? source : a.domain.localeCompare(b.domain);
    })
    .find((identity) => identity.state !== "ready") ?? null;
}

function identityBlockerLabel(blocker: ProductIdentityEvidence): string {
  return `${DATA_PRODUCT_SOURCE_LABEL[blocker.source]} · ${blocker.label}：${blocker.reason}`;
}

function repairAction(blocker: ProductStreamEvidence | null): string {
  if (!blocker) return "复核连接配置、身份覆盖和产品专属 SCM 事实";
  const source = DATA_PRODUCT_SOURCE_LABEL[blocker.source];
  const stream = dataProductStreamLabel(blocker.source, blocker.stream);
  if (blocker.state === "stale") return `刷新 ${source}的「${stream}」，并重做控制总量核对`;
  if (blocker.state === "degraded") return `解除 ${source}「${stream}」的授权/质量/时效限制`;
  return `补齐 ${source}「${stream}」的成功业务证据`;
}

function identityRepairAction(blocker: ProductIdentityEvidence): string {
  return `${blocker.nextAction}（${DATA_PRODUCT_SOURCE_LABEL[blocker.source]} · ${blocker.label}）`;
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
 * 优先级不伪造精确的“商业价值分”：先止损，再审批，再放行，再修复，再学习真实结果，最后监控；
 * 同组只按产品已声明的决策 SLA 和可观测阻塞状态排序。
 */
export function buildDataProductWorkQueue(
  products: readonly DataProductDefinition[],
  dataSources: readonly DataSourceReadiness[],
  releases: readonly DataProductReleaseReadiness[],
  outcomes: readonly DataProductOutcomeReadiness[] = [],
): DataProductWorkItem[] {
  const releaseByProduct = new Map(releases.map((release) => [release.productId, release]));
  const outcomeByProduct = new Map(outcomes.map((outcome) => [outcome.productId, outcome]));
  const items = products.map<DataProductWorkItem>((product) => {
    const summary = evaluateProductSourceEvidence(product, dataSources);
    const runtime = currentProductAutomation(summary);
    const release = releaseByProduct.get(product.id);
    const blocker = firstBlocker(summary);
    // 先取得当前、可解释的流证据，再处理其内部身份。否则“未拉数”
    // 会被误排成“去认领一个根本尚未观测到的身份”。
    const streamsReadyForIdentityWork = summary.sources.every((source) =>
      source.state === "observation" || source.state === "operational");
    const identityBlocker = streamsReadyForIdentityWork ? firstIdentityBlocker(summary) : null;
    const effectiveLevel = release?.effectiveLevel ?? runtime.level;

    if (release?.activeRelease && !release.activeReleaseCurrent) {
      const action = actionTarget(product, "safeguard", blocker, identityBlocker, dataSources);
      return {
        productId: product.id,
        title: product.title,
        owner: product.owner,
        decisionSlaHours: product.decisionSlaHours,
        effectiveLevel,
        stage: "safeguard",
        nextAction: `撤回已失效的 ${release.activeRelease.targetLevel} 放行，再按当前证据重新申请`,
        ...action,
        bottleneck: identityBlocker ? identityBlockerLabel(identityBlocker) : blockerLabel(blocker),
        blockerState: "release",
      };
    }

    if (release?.pendingRelease) {
      const current = pendingEvidenceCurrent(product, release);
      const stage = current ? "approval" : "safeguard";
      const action = actionTarget(product, stage, blocker, identityBlocker, dataSources);
      return {
        productId: product.id,
        title: product.title,
        owner: product.owner,
        decisionSlaHours: product.decisionSlaHours,
        effectiveLevel,
        stage,
        nextAction: current
          ? "由同责任域的另一名审批人复核控制总量、UAT 和回滚方案"
          : "拒绝已失效的申请；修复实时门禁后重新发起",
        ...action,
        bottleneck: current
          ? "实时证据与申请范围一致，等待独立会签"
          : identityBlocker ? identityBlockerLabel(identityBlocker) : blockerLabel(blocker),
        blockerState: "release",
      };
    }

    if (release?.activeReleaseCurrent && release.activeRelease) {
      const learning = summarizeDataProductLearning(outcomeByProduct.get(product.id));
      const stage = learning.state === "measured" ? "monitor" : "learning";
      const action = actionTarget(product, stage, blocker, identityBlocker, dataSources);
      return {
        productId: product.id,
        title: product.title,
        owner: product.owner,
        decisionSlaHours: product.decisionSlaHours,
        effectiveLevel,
        stage,
        nextAction: learning.nextAction,
        ...action,
        bottleneck: stage === "monitor"
          ? `当前 ${release.activeRelease.targetLevel} 放行有效 · ${learning.bottleneck}`
          : `${learning.bottleneck}；当前 ${release.activeRelease.targetLevel} 放行仍有效`,
        blockerState: stage === "monitor" ? "none" : "outcome",
      };
    }

    const dependencyBlocker = release?.dependencyGates?.find((dependency) => !dependency.satisfied);
    if (runtime.level === "A1" && dependencyBlocker) {
      return {
        productId: product.id,
        title: product.title,
        owner: product.owner,
        decisionSlaHours: product.decisionSlaHours,
        effectiveLevel,
        stage: "repair",
        nextAction: `先将上游「${dependencyBlocker.title}」验收放行到 ${dependencyBlocker.minimumLevel}`,
        actionLabel: "打开上游门禁",
        actionHref: productEvidenceHref(dependencyBlocker.productId),
        bottleneck: `${dependencyBlocker.purpose}；当前 ${dependencyBlocker.effectiveLevel}，且没有有效产品级放行`,
        blockerState: "release",
      };
    }

    if (runtime.level === "A1" && release?.eligibleForRequest !== false) {
      const action = actionTarget(product, "release_ready", blocker, identityBlocker, dataSources);
      return {
        productId: product.id,
        title: product.title,
        owner: product.owner,
        decisionSlaHours: product.decisionSlaHours,
        effectiveLevel,
        stage: "release_ready",
        nextAction: "用当前批次完成控制总量和业务 UAT，登记回滚后发起放行",
        ...action,
        bottleneck: "来源证据可用于解释；尚缺产品级 UAT/会签",
        blockerState: "release",
      };
    }

    const action = actionTarget(product, "repair", blocker, identityBlocker, dataSources);
    return {
      productId: product.id,
      title: product.title,
      owner: product.owner,
      decisionSlaHours: product.decisionSlaHours,
      effectiveLevel,
      stage: "repair",
      nextAction: identityBlocker ? identityRepairAction(identityBlocker) : repairAction(blocker),
      ...action,
      bottleneck: identityBlocker ? identityBlockerLabel(identityBlocker) : blockerLabel(blocker),
      blockerState: identityBlocker ? "identity" : blocker?.state ?? "none",
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
