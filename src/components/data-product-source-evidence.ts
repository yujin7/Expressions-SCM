import type {
  DataProductAutomationLevel,
  DataProductDefinition,
  DataProductSource,
} from "@/components/data-products";
import type {
  DataSourceReadiness,
  DataStreamEvidence,
  ScmEvidenceSnapshot,
} from "@/server/modules/report/data-source-readiness";
import { SCM_EVIDENCE_LABEL } from "@/lib/scm-evidence";
import {
  CROSS_SYSTEM_IDENTITY_LABEL,
  getCrossSystemIdentityStreamContract,
  type CrossSystemIdentityCoverage,
  type CrossSystemIdentityDomain,
  type CrossSystemIdentityExtractionState,
  type CrossSystemIdentityState,
  type CrossSystemIdentitySource,
} from "@/lib/cross-system-identity";
import {
  CROSS_SYSTEM_SEMANTIC_LABEL,
  getCrossSystemSemanticStreamContract,
  type CrossSystemSemanticDomain,
  type CrossSystemSemanticSource,
  type CrossSystemSemanticState,
} from "@/lib/cross-system-semantics";

export type ProductSourceEvidenceState =
  | "missing"
  | "stale"
  | "degraded"
  | "observation"
  | "operational";
export type ProductStreamEvidenceState = "missing" | "stale" | "degraded" | "current";

export interface ProductStreamEvidence {
  source: DataProductSource;
  stream: string;
  state: ProductStreamEvidenceState;
  reason: string;
  evidence: DataStreamEvidence | null;
  scmEvidence?: ScmEvidenceSnapshot;
}

export interface ProductSourceEvidence {
  source: DataProductSource;
  state: ProductSourceEvidenceState;
  /** 连接器当前真实状态；历史成功流不能覆盖 contract_only / blocked。 */
  connectorState: DataSourceReadiness["state"] | "missing";
  /** 当前配置、启用、受控契约与 live binding 仍有效；与产品级 UAT 放行分开。 */
  configurationReady: boolean;
  missingStreams: string[];
  staleStreams: string[];
  degradedStreams: string[];
  streams: ProductStreamEvidence[];
}

export interface ProductIdentityEvidence {
  source: DataProductSource;
  domain: CrossSystemIdentityDomain;
  label: string;
  state: CrossSystemIdentityState;
  reason: string;
  nextAction: string;
  extractionState: CrossSystemIdentityExtractionState;
  extractionReason: string;
  extractionNextAction: string;
  extractionStreams: ProductIdentityStreamExtractionEvidence[];
  evidence: CrossSystemIdentityCoverage | null;
}

export interface ProductIdentityStreamExtractionEvidence {
  stream: string;
  state: CrossSystemIdentityExtractionState;
  evidence: string;
  nextAction: string;
}

export interface ProductSemanticEvidence {
  source: CrossSystemSemanticSource;
  stream: string;
  grain: string;
  domain: CrossSystemSemanticDomain;
  label: string;
  state: CrossSystemSemanticState;
  reason: string;
  nextAction: string;
}

export interface ProductEvidenceSummary {
  sources: ProductSourceEvidence[];
  observedSources: number;
  operationalSources: number;
  missingSources: number;
  staleSources: number;
  degradedSources: number;
  missingStreams: number;
  staleStreams: number;
  degradedStreams: number;
  identityGates: ProductIdentityEvidence[];
  missingIdentities: number;
  partialIdentities: number;
  unimplementedIdentities: number;
  unreadyExtractionIdentities: number;
  semanticGates: ProductSemanticEvidence[];
  unreadySemantics: number;
  businessTimeWindow: ProductBusinessTimeWindow;
}

/**
 * 返回产品可用于身份、历史与回查解释的辅助外部证据。
 * 这些行与 requiredStreams 分开计算，绝不参与自动化级别或 A2/A3 放行判断。
 */
export function evaluateProductSupportingEvidence(
  product: DataProductDefinition,
  dataSources: readonly DataSourceReadiness[],
): ProductStreamEvidence[] {
  const sourceByKey = new Map(dataSources.map((row) => [row.key, row]));
  return (Object.entries(product.supportingStreams ?? {}) as [DataProductSource, string[]][])
    .flatMap(([source, streams]) => streams.map((stream) => (
      evaluateExternalStreamEvidence(source, stream, sourceByKey.get(source))
    )))
    .sort((a, b) => {
      const source = a.source.localeCompare(b.source);
      return source !== 0 ? source : a.stream.localeCompare(b.stream);
    });
}

export interface ProductBusinessTimeWindow {
  /** 只统计已有证据且声明了时效门限的流；主档/当前状态等无历史门限事实不强行编造日期。 */
  timeSensitiveStreams: number;
  datedStreams: number;
  undatedStreams: number;
  /** 多源比较只能诚实地截至最早业务日期。 */
  commonAsOf: string | null;
  latestAsOf: string | null;
  spanDays: number | null;
  state: "complete" | "partial" | "unavailable";
}

export interface ProductAutomationReadiness {
  level: Extract<DataProductAutomationLevel, "A0" | "A1">;
  reason: string;
}

const EXTRACTION_STATE_ORDER: Record<CrossSystemIdentityExtractionState, number> = {
  missing_contract: 0,
  not_available: 1,
  schema_profile_pending: 2,
  not_implemented: 3,
  implemented: 4,
};

function evaluateIdentityExtraction(
  source: DataProductSource,
  streams: readonly string[],
  domain: CrossSystemIdentityDomain,
): Pick<
  ProductIdentityEvidence,
  "extractionState" | "extractionReason" | "extractionNextAction" | "extractionStreams"
> {
  if (source === "SCM") {
    return {
      extractionState: "missing_contract",
      extractionReason: "SCM 身份应由受控事实门禁，不应配置为外部流身份提取",
      extractionNextAction: "从 requiredIdentities 移除 SCM，并改用 requiredScmEvidence",
      extractionStreams: [],
    };
  }
  const extractionStreams: ProductIdentityStreamExtractionEvidence[] = [];
  const missingContracts: ProductIdentityStreamExtractionEvidence[] = [];
  for (const stream of streams) {
    const contract = getCrossSystemIdentityStreamContract(source as CrossSystemIdentitySource, stream);
    if (!contract) {
      missingContracts.push({
        stream,
        state: "missing_contract",
        evidence: "该必需流未登记逐流身份提取契约",
        nextAction: "核对真实读取与暂存实现，并显式登记该流提供或不提供的身份维度",
      });
      continue;
    }
    const control = contract.identities[domain];
    if (control) extractionStreams.push({ stream, ...control });
  }
  const relevant = [...missingContracts, ...extractionStreams];
  if (relevant.length === 0) {
    return {
      extractionState: "missing_contract",
      extractionReason: "产品要求该身份，但没有任何必需流声明会提供并治理它",
      extractionNextAction: "确认身份应来自哪条必需流，并登记字段到受控身份治理的精确契约",
      extractionStreams: [],
    };
  }
  const blocker = [...relevant].sort((left, right) =>
    EXTRACTION_STATE_ORDER[left.state] - EXTRACTION_STATE_ORDER[right.state]
      || left.stream.localeCompare(right.stream)
  )[0];
  const allImplemented = relevant.every((item) => item.state === "implemented");
  return {
    extractionState: allImplemented ? "implemented" : blocker.state,
    extractionReason: allImplemented
      ? `适用的 ${relevant.length} 条必需流均已把该身份送入受控治理`
      : `${blocker.stream}：${blocker.evidence}`,
    extractionNextAction: allImplemented
      ? "持续监测逐流候选、未认领与结构漂移"
      : blocker.nextAction,
    extractionStreams: relevant.sort((left, right) => left.stream.localeCompare(right.stream)),
  };
}

function evaluateProductSemanticGates(product: DataProductDefinition): ProductSemanticEvidence[] {
  return (Object.entries(product.requiredSemantics) as [
    CrossSystemSemanticSource,
    Record<string, CrossSystemSemanticDomain[]>,
  ][]).flatMap(([source, streams]) => Object.entries(streams).flatMap(([stream, domains]) => {
    const contract = getCrossSystemSemanticStreamContract(source, stream);
    return domains.map<ProductSemanticEvidence>((domain) => {
      const control = contract?.controls[domain];
      if (!contract) {
        return {
          source,
          stream,
          grain: "未登记",
          domain,
          label: CROSS_SYSTEM_SEMANTIC_LABEL[domain],
          state: "missing_contract",
          reason: "该必需流没有逐流业务语义契约",
          nextAction: "核对真实读取、源粒度和字段语义后显式登记；禁止按字段名猜测",
        };
      }
      if (!control) {
        return {
          source,
          stream,
          grain: contract.grain,
          domain,
          label: CROSS_SYSTEM_SEMANTIC_LABEL[domain],
          state: "missing_contract",
          reason: "产品使用了该语义，但逐流契约没有声明",
          nextAction: "依据真实源证据补齐该语义控制，或从产品需求中移除未使用语义",
        };
      }
      return {
        source,
        stream,
        grain: contract.grain,
        domain,
        label: CROSS_SYSTEM_SEMANTIC_LABEL[domain],
        state: control.state,
        reason: control.evidence,
        nextAction: control.nextAction,
      };
    });
  })).sort((left, right) =>
    left.source.localeCompare(right.source)
    || left.stream.localeCompare(right.stream)
    || left.domain.localeCompare(right.domain)
  );
}

function qualityReviewReason(evidence: DataStreamEvidence): string | null {
  const quality = evidence.quality;
  if (!quality || quality.status !== "review") return null;
  const issues = [
    quality.missingBusinessKeyRows > 0 ? `业务键缺失 ${quality.missingBusinessKeyRows} 行` : null,
    quality.duplicateRows > 0
      ? `业务键重复 ${quality.duplicateKeyGroups} 组/${quality.duplicateRows} 行`
      : null,
    quality.invalidNumericValues > 0 ? `非法数值 ${quality.invalidNumericValues} 个` : null,
    quality.reconciliationMismatchedRows > 0
      ? `表头明细不一致 ${quality.reconciliationMismatchedRows} 行`
      : null,
    quality.reconciliationInsufficientRows > 0
      ? `对账覆盖不足 ${quality.reconciliationInsufficientRows} 行`
      : null,
  ].filter(Boolean);
  return `聚合质量控制待复核${issues.length > 0 ? `（${issues.join("；")}）` : ""}`;
}

export function evaluateExternalStreamEvidence(
  source: DataProductSource,
  stream: string,
  row: DataSourceReadiness | undefined,
): ProductStreamEvidence {
  const evidence = row?.streams?.find((item) => item.stream === stream) ?? null;
  if (!evidence) {
    if (row?.selectedStreamKeys != null && !row.selectedStreamKeys.includes(stream)) {
      return {
        source,
        stream,
        state: "missing",
        reason: "读取契约已实现，但当前部署未显式选中该流",
        evidence: null,
      };
    }
    const legacySuccess = row?.successfulStreamKeys?.includes(stream) ?? false;
    return legacySuccess
      ? {
          source,
          stream,
          state: "degraded",
          reason: "旧载荷只有成功标记，缺少逐流时效与质量证据",
          evidence: null,
        }
      : { source, stream, state: "missing", reason: "尚无成功运行证据", evidence: null };
  }
  if (evidence.selectedForSync === false) {
    return {
      source,
      stream,
      state: evidence.lastSuccessAt ? "degraded" : "missing",
      reason: evidence.lastSuccessAt
        ? "历史/手工演练证据仍可追溯，但当前部署未显式选中该流，不能用于持续决策"
        : "当前部署未显式选中该流",
      evidence,
    };
  }
  if (!evidence.lastSuccessAt) {
    return {
      source,
      stream,
      state: "missing",
      reason: evidence.authorizationBlocked
        ? "源系统授权被阻断，尚无成功业务证据"
        : "尚无成功运行证据",
      evidence,
    };
  }
  if (evidence.freshness === "stale") {
    return {
      source,
      stream,
      state: "stale",
      reason: `业务时点超过 ${evidence.freshnessMaxAgeDays ?? "未定义"} 天门限`,
      evidence,
    };
  }
  const limitations: string[] = [];
  if (!evidence.sourceAsOf) limitations.push("缺少源业务截止日");
  if (evidence.authorizationBlocked) limitations.push("源系统授权被阻断");
  if (evidence.sourceTimeInvalid) limitations.push("业务截止日无效或晚于当前上海业务日");
  if (evidence.latestStatus === "failed") limitations.push("最近一次运行失败");
  if (evidence.latestStatus === "running") limitations.push("最新批次仍在运行");
  if (evidence.rejectedRows > 0) limitations.push(`有 ${evidence.rejectedRows} 行拒收`);
  if (evidence.emptySource) limitations.push("源端返回 0 行，尚无业务证据");
  if (evidence.schemaDrift) limitations.push("外部字段结构变化，待契约评审");
  const qualityReason = qualityReviewReason(evidence);
  if (qualityReason) limitations.push(qualityReason);
  if (evidence.releaseBlocked && !evidence.schemaDrift) limitations.push("观察层禁止放行");
  if (evidence.freshness === "unknown") limitations.push("时效门限或源时点不完整");
  if (limitations.length > 0) {
    return { source, stream, state: "degraded", reason: limitations.join("；"), evidence };
  }
  return { source, stream, state: "current", reason: "逐流运行、时效与质量证据完整", evidence };
}

/**
 * 数据产品就绪度必须同时命中「来源 + 该产品需要的具体数据流 + 逐流时效/质量证据」。
 * 同一连接器的无关流、过期批次、最近失败或旧缓存都不能为产品代打通行证明。
 */
export function evaluateProductSourceEvidence(
  product: DataProductDefinition,
  dataSources: readonly DataSourceReadiness[],
): ProductEvidenceSummary {
  const sourceByKey = new Map(dataSources.map((row) => [row.key, row]));
  const sources = product.sources.map<ProductSourceEvidence>((source) => {
    const row = sourceByKey.get(source);
    if (source === "SCM") {
      const streams = product.requiredScmEvidence.map<ProductStreamEvidence>((stream) => {
        const snapshot = row?.scmEvidence[stream];
        const state: ProductStreamEvidenceState = !snapshot || snapshot.rows === 0
          ? "missing"
          : snapshot.freshness === "stale"
            ? "stale"
            : snapshot.freshness === "unknown"
              ? "degraded"
              : "current";
        const reason = !snapshot || snapshot.rows === 0
          ? `${SCM_EVIDENCE_LABEL[stream]}尚无受控事实`
          : snapshot.freshness === "stale"
            ? `${SCM_EVIDENCE_LABEL[stream]}业务时点超过 ${snapshot.freshnessMaxAgeDays} 天门限`
            : snapshot.freshness === "unknown"
              ? `${SCM_EVIDENCE_LABEL[stream]}缺少可比较业务时点`
              : `${SCM_EVIDENCE_LABEL[stream]}：${snapshot.rows.toLocaleString("zh-CN")} 行当前受控事实`;
        return {
          source,
          stream,
          state,
          reason,
          evidence: null,
          scmEvidence: snapshot,
        };
      });
      const missingStreams = streams.filter((item) => item.state === "missing").map((item) => item.stream);
      const staleStreams = streams.filter((item) => item.state === "stale").map((item) => item.stream);
      const degradedStreams = streams.filter((item) => item.state === "degraded").map((item) => item.stream);
      return {
        source,
        state: row?.state === "operational"
          && streams.length > 0
          && missingStreams.length === 0
          && staleStreams.length === 0
          && degradedStreams.length === 0
          ? "operational"
          : missingStreams.length > 0
            ? "missing"
            : staleStreams.length > 0
              ? "stale"
              : "degraded",
        connectorState: row?.state ?? "missing",
        configurationReady: row?.configurationReady === true,
        missingStreams,
        staleStreams,
        degradedStreams,
        streams,
      };
    }
    const streams = (product.requiredStreams[source] ?? [])
      .map((stream) => evaluateExternalStreamEvidence(source, stream, row));
    const missingStreams = streams.filter((item) => item.state === "missing").map((item) => item.stream);
    const staleStreams = streams.filter((item) => item.state === "stale").map((item) => item.stream);
    const degradedStreams = streams.filter((item) => item.state === "degraded").map((item) => item.stream);
    const hasRequirements = streams.length > 0;
    const state: ProductSourceEvidenceState = !row || !hasRequirements || missingStreams.length > 0
      ? "missing"
      : staleStreams.length > 0
        ? "stale"
        : degradedStreams.length > 0
          ? "degraded"
          : row.state === "operational"
            ? "operational"
            : row.state === "observation"
              ? "observation"
              : "missing";
    return {
      source,
      state,
      connectorState: row?.state ?? "missing",
      configurationReady: row?.configurationReady === true,
      missingStreams,
      staleStreams,
      degradedStreams,
      streams,
    };
  });
  const operationalSources = sources.filter((row) => row.state === "operational").length;
  const observedSources = sources.filter((row) => ["observation", "degraded", "operational"].includes(row.state)).length;
  const missingSources = sources.filter((row) => row.state === "missing").length;
  const staleSources = sources.filter((row) => row.state === "stale").length;
  const degradedSources = sources.filter((row) => row.state === "degraded").length;
  const identityGates = (Object.entries(product.requiredIdentities ?? {}) as [
    DataProductSource,
    CrossSystemIdentityDomain[],
  ][]).flatMap(([source, domains]) => {
    const row = sourceByKey.get(source);
    return domains.map<ProductIdentityEvidence>((domain) => {
      const evidence = row?.identityCoverage?.find((item) => item.domain === domain) ?? null;
      const extraction = evaluateIdentityExtraction(
        source,
        product.requiredStreams[source] ?? [],
        domain,
      );
      return evidence
        ? {
            source,
            domain,
            label: evidence.label,
            state: evidence.state,
            reason: evidence.reason,
            nextAction: evidence.nextAction,
            ...extraction,
            evidence,
          }
        : {
            source,
            domain,
            label: CROSS_SYSTEM_IDENTITY_LABEL[domain],
            state: "missing",
            reason: "当前运行证据未提供该身份维度的覆盖统计",
            nextAction: "先运行受控读取并建立来源作用域身份候选与认领证据",
            ...extraction,
            evidence: null,
          };
    });
  }).sort((left, right) => {
    const source = left.source.localeCompare(right.source);
    return source !== 0 ? source : left.domain.localeCompare(right.domain);
  });
  const timeSensitive = sources
    .flatMap((source) => source.streams)
    .filter((stream) => (stream.evidence?.freshnessMaxAgeDays ?? stream.scmEvidence?.freshnessMaxAgeDays) != null);
  const businessDates = timeSensitive
    .map((stream) => stream.evidence?.sourceAsOf ?? stream.scmEvidence?.asOf ?? null)
    .filter((value): value is string => value != null)
    .sort();
  const commonAsOf = businessDates[0] ?? null;
  const latestAsOf = businessDates.at(-1) ?? null;
  const spanDays = commonAsOf && latestAsOf
    ? Math.round((Date.parse(`${latestAsOf}T00:00:00.000Z`) - Date.parse(`${commonAsOf}T00:00:00.000Z`)) / 86_400_000)
    : null;
  const businessTimeWindow: ProductBusinessTimeWindow = {
    timeSensitiveStreams: timeSensitive.length,
    datedStreams: businessDates.length,
    undatedStreams: timeSensitive.length - businessDates.length,
    commonAsOf,
    latestAsOf,
    spanDays,
    state: timeSensitive.length === 0 || businessDates.length === 0
      ? "unavailable"
      : businessDates.length < timeSensitive.length ? "partial" : "complete",
  };
  const semanticGates = evaluateProductSemanticGates(product);
  return {
    sources,
    observedSources,
    operationalSources,
    missingSources,
    staleSources,
    degradedSources,
    missingStreams: sources.reduce((sum, row) => sum + row.missingStreams.length, 0),
    staleStreams: sources.reduce((sum, row) => sum + row.staleStreams.length, 0),
    degradedStreams: sources.reduce((sum, row) => sum + row.degradedStreams.length, 0),
    identityGates,
    missingIdentities: identityGates.filter((item) => item.state === "missing").length,
    partialIdentities: identityGates.filter((item) => item.state === "partial").length,
    unimplementedIdentities: identityGates.filter((item) => item.state === "not_implemented").length,
    unreadyExtractionIdentities: identityGates.filter((item) => item.extractionState !== "implemented").length,
    semanticGates,
    unreadySemantics: semanticGates.filter((item) => item.state !== "implemented").length,
    businessTimeWindow,
  };
}

function streamSafeForExplanation(row: ProductStreamEvidence): boolean {
  const evidence = row.evidence;
  return evidence != null
    && evidence.selectedForSync !== false
    && evidence.lastSuccessAt != null
    && evidence.freshness === "current"
    && evidence.latestStatus === "succeeded"
    && !evidence.authorizationBlocked
    && !evidence.sourceTimeInvalid
    && !evidence.schemaDrift
    && evidence.sourceAsOf != null
    && !evidence.emptySource
    && evidence.rejectedRows === 0
    && evidence.quality?.status !== "review";
}

/**
 * 当前运行证据最多自动解锁 A1（解释）。A2/A3 还需要产品级控制总量、UAT、审批和
 * 回滚证据；仅凭连接器状态永远不能越级。observation-only/releaseBlocked 可以用于带标记
 * 的解释，但缺业务截止日、结构漂移、失败、过期、拒收、空源、授权阻断或无证据必须退回 A0。
 */
export function currentProductAutomation(
  summary: ProductEvidenceSummary,
): ProductAutomationReadiness {
  const sourcesSafe = summary.sources.every((source) => source.source === "SCM"
    ? source.connectorState === "operational"
      && source.configurationReady
      && source.state === "operational"
      && source.streams.length > 0
      && source.streams.every((stream) => stream.state === "current")
    : (source.connectorState === "observation" || source.connectorState === "operational")
      && source.configurationReady
      && source.streams.length > 0
      && source.streams.every(streamSafeForExplanation));
  const identitiesSafe = summary.identityGates.every((identity) =>
    identity.state === "ready" && identity.extractionState === "implemented");
  const semanticsSafe = summary.semanticGates.every((semantic) => semantic.state === "implemented");
  if (sourcesSafe && !identitiesSafe) {
    const blocker = summary.identityGates.find((identity) =>
      identity.extractionState !== "implemented" || identity.state !== "ready")!;
    if (blocker.extractionState !== "implemented") {
      return {
        level: "A0",
        reason: `${blocker.source} 的「${blocker.label}」逐流提取契约未通过：${blocker.extractionReason}。来源总体覆盖不能代替具体流的身份可达性。`,
      };
    }
    return {
      level: "A0",
      reason: `${blocker.source} 的「${blocker.label}」身份门禁未通过：${blocker.reason}。流成功不能代替身份统一。`,
    };
  }
  if (sourcesSafe && identitiesSafe && !semanticsSafe) {
    const blocker = summary.semanticGates.find((semantic) => semantic.state !== "implemented")!;
    return {
      level: "A0",
      reason: `${blocker.source} 的「${blocker.label}」语义门禁未通过：${blocker.reason}。数据可读且身份可对上，也不能在粒度、单位、时间或正负号未固化时进入 BI 解释。`,
    };
  }
  return sourcesSafe && identitiesSafe && semanticsSafe
    ? {
        level: "A1",
        reason: "所需流具备当前、成功且无拒收的证据，身份维度已受控统一，使用到的业务语义也已固化；仅允许带来源口径的解释，仍待产品级 UAT 后升级。",
      }
    : {
        level: "A0",
        reason: "所需来源存在连接配置失效、缺业务截止日、结构漂移、质量待复核、缺失、过期、失败、拒收、空源或授权/时间异常；只能观察门禁与修复队列。",
      };
}
