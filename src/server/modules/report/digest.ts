/**
 * 每日经营摘要（in-app 晨间简报）——纯装配层，复用工作台聚焦 getWorkbenchFocus。
 *
 * 口径纪律：
 * - 不新增任何 DB 查询，全部字段由 getWorkbenchFocus 的输出推导（异常/指标口径与工作台一致）；
 * - 只读，无写入、无 schema 依赖；
 * - 时区 Asia/Shanghai（date = todayShanghai()）。
 * - 推送飞书/邮件不在本模块范围（IT 集成排除）——仅生成 in-app 简报对象。
 */
import {
  getWorkbenchFocus,
  type ExceptionItem,
  type ExceptionSeverity,
} from "@/server/modules/workbench/focus";
import type { Role } from "@/server/core/constants";
import { todayShanghai } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface DigestHighlight {
  label: string;
  value: number;
  suffix?: string;
  href: string;
}

export interface DigestSectionSummary {
  role: Role;
  roleLabel: string;
  /** 该角色下最重要的若干指标（value>0 优先，最多 3 项） */
  topMetrics: DigestHighlight[];
}

export interface DailyDigest {
  date: string;
  generatedAt: string;
  headline: string;
  exceptions: ExceptionItem[];
  highlights: DigestHighlight[];
  sectionSummaries: DigestSectionSummary[];
}

const SEVERITY_LABEL: Record<ExceptionSeverity, string> = {
  critical: "紧急",
  high: "高",
  medium: "中",
};

/** 生成中文单句摘要：按严重度统计异常数 */
function buildHeadline(exceptions: ExceptionItem[]): string {
  if (exceptions.length === 0) return "今日无跨域异常，各项监控正常";
  const critical = exceptions.filter((e) => e.severity === "critical").length;
  const high = exceptions.filter((e) => e.severity === "high").length;
  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} 项${SEVERITY_LABEL.critical}`);
  if (high > 0) parts.push(`${high} 项${SEVERITY_LABEL.high}`);
  const tail = parts.length ? `，其中 ${parts.join("、")}` : "";
  return `今日 ${exceptions.length} 项异常待处理${tail}`;
}

/** 每日经营摘要：纯装配 getWorkbenchFocus 输出 */
export async function getDailyDigest(roles: string[], dbArg?: AnyDb): Promise<DailyDigest> {
  const focus = await getWorkbenchFocus(roles, dbArg);

  // 每个区块取最重要的指标（value>0 优先，纯链接卡 value=null 跳过）
  const sectionSummaries: DigestSectionSummary[] = focus.sections.map((s) => {
    const withValue = s.metrics.filter(
      (m): m is typeof m & { value: number } => m.value != null,
    );
    const ranked = [...withValue].sort((a, b) => b.value - a.value);
    return {
      role: s.role,
      roleLabel: s.roleLabel,
      topMetrics: ranked.slice(0, 3).map((m) => ({
        label: m.label,
        value: m.value,
        suffix: m.suffix,
        href: m.href,
      })),
    };
  });

  // highlights：跨区块拉平，value>0 优先，按 value 降序去重取 5-6 项
  const flat: DigestHighlight[] = focus.sections.flatMap((s) =>
    s.metrics
      .filter((m): m is typeof m & { value: number } => m.value != null)
      .map((m) => ({ label: m.label, value: m.value, suffix: m.suffix, href: m.href })),
  );
  const seen = new Set<string>();
  const highlights: DigestHighlight[] = [];
  for (const h of [...flat].sort((a, b) => b.value - a.value)) {
    if (h.value <= 0) continue;
    if (seen.has(h.href)) continue;
    seen.add(h.href);
    highlights.push(h);
    if (highlights.length >= 6) break;
  }
  // 若有值指标不足 5 项，用剩余（含 0 值）补齐到最多 5 项，保证简报不空
  if (highlights.length < 5) {
    for (const h of flat) {
      if (seen.has(h.href)) continue;
      seen.add(h.href);
      highlights.push(h);
      if (highlights.length >= 5) break;
    }
  }

  return {
    date: todayShanghai(),
    generatedAt: focus.generatedAt,
    headline: buildHeadline(focus.exceptions),
    exceptions: focus.exceptions,
    highlights,
    sectionSummaries,
  };
}
