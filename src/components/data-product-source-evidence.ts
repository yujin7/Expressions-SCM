import type {
  DataProductAutomationLevel,
  DataProductDefinition,
  DataProductSource,
} from "@/components/data-products";
import type {
  DataSourceReadiness,
  DataStreamEvidence,
} from "@/server/modules/report/data-source-readiness";

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
}

export interface ProductSourceEvidence {
  source: DataProductSource;
  state: ProductSourceEvidenceState;
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
}

export interface ProductAutomationReadiness {
  level: Extract<DataProductAutomationLevel, "A0" | "A1">;
  reason: string;
}

function streamState(
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
  if (evidence.authorizationBlocked) limitations.push("源系统授权被阻断");
  if (evidence.sourceTimeInvalid) limitations.push("业务截止日无效或晚于当前上海业务日");
  if (evidence.latestStatus === "failed") limitations.push("最近一次运行失败");
  if (evidence.latestStatus === "running") limitations.push("最新批次仍在运行");
  if (evidence.rejectedRows > 0) limitations.push(`有 ${evidence.rejectedRows} 行拒收`);
  if (evidence.releaseBlocked) limitations.push("观察层禁止放行");
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
      return {
        source,
        state: row?.state === "operational" ? "operational" : "missing",
        configurationReady: row?.configurationReady === true,
        missingStreams: [],
        staleStreams: [],
        degradedStreams: [],
        streams: [],
      };
    }
    const streams = (product.requiredStreams[source] ?? []).map((stream) => streamState(source, stream, row));
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
    && !evidence.emptySource
    && evidence.rejectedRows === 0;
}

/**
 * 当前运行证据最多自动解锁 A1（解释）。A2/A3 还需要产品级控制总量、UAT、审批和
 * 回滚证据；仅凭连接器状态永远不能越级。observation-only/releaseBlocked 可以用于带标记
 * 的解释，但失败、过期、拒收、空源、授权阻断或无证据必须退回 A0。
 */
export function currentProductAutomation(
  summary: ProductEvidenceSummary,
): ProductAutomationReadiness {
  const safe = summary.sources.every((source) => source.source === "SCM"
    ? source.state === "operational"
    : source.configurationReady
      && source.streams.length > 0
      && source.streams.every(streamSafeForExplanation));
  return safe
    ? {
        level: "A1",
        reason: "所需流具备当前、成功且无拒收的证据；仅允许带来源口径的解释，仍待产品级 UAT 后升级。",
      }
    : {
        level: "A0",
        reason: "所需来源存在连接配置失效、缺失、过期、失败、拒收、空源或授权/时间异常；只能观察门禁与修复队列。",
      };
}
