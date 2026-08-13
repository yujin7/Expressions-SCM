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
  businessTimeWindow: ProductBusinessTimeWindow;
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
    businessTimeWindow,
  };
}

function streamSafeForExplanation(row: ProductStreamEvidence): boolean {
  const evidence = row.evidence;
  return evidence != null
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
  const safe = summary.sources.every((source) => source.source === "SCM"
    ? source.connectorState === "operational"
      && source.configurationReady
      && source.state === "operational"
      && source.streams.length > 0
      && source.streams.every((stream) => stream.state === "current")
    : (source.connectorState === "observation" || source.connectorState === "operational")
      && source.configurationReady
      && source.streams.length > 0
      && source.streams.every(streamSafeForExplanation));
  return safe
    ? {
        level: "A1",
        reason: "所需流具备当前、成功且无拒收的证据；仅允许带来源口径的解释，仍待产品级 UAT 后升级。",
      }
    : {
        level: "A0",
        reason: "所需来源存在连接配置失效、缺业务截止日、结构漂移、质量待复核、缺失、过期、失败、拒收、空源或授权/时间异常；只能观察门禁与修复队列。",
      };
}
