/**
 * 审计 A3(2)：已知悉告警再次命中时，何时把「已知悉」清掉（纯函数，唯一权威）。
 *
 * 问题：引擎刷新再命中的告警不清 ackedAt，六月知悉、九月再触发的告警被当成"已处理"。
 * 规则（保守，避免每轮 cron 都把知悉打回去）：
 * - 未知悉 → 不动；
 * - 严重度升级（medium → high → critical）→ 清知悉：情况变糟，须重新看；
 * - 距知悉 ≥ resetAfterDays（缺省 7）→ 清知悉：一周仍在命中，说明"知悉"没有转化为处置；
 * - 其余保留知悉。
 *
 * 红队修复（严重度未知 ≠ 最低）：`severityRank(null) = 0` 曾让**旧严重度为空的历史行**
 * 在第一次刷新时被判成"medium(1) > null(0) = 升级"，于是一条合法的已知悉被无端打回。
 * 现在只有**双方严重度都可识别**时才比较；一侧未知按"没变化"处理，交给 stale_ack 那条线兜底。
 */

export type AlertSeverity = "medium" | "high" | "critical";

const RANK: Record<string, number> = { medium: 1, high: 2, critical: 3 };

export function severityRank(s: string | null | undefined): number {
  return RANK[(s ?? "").toLowerCase()] ?? 0;
}

export interface AckResetInput {
  ackedAt: Date | string | null;
  prevSeverity: string | null;
  nextSeverity: string;
  now: Date;
  /** 缺省 7 天 */
  resetAfterDays?: number;
}

export interface AckResetDecision {
  reset: boolean;
  reason: "severity_up" | "stale_ack" | null;
}

export function ackResetOnRehit(input: AckResetInput): AckResetDecision {
  if (input.ackedAt == null) return { reset: false, reason: null };
  const acked = new Date(input.ackedAt).getTime();
  if (!Number.isFinite(acked)) return { reset: false, reason: null };
  const prevRank = severityRank(input.prevSeverity);
  const nextRank = severityRank(input.nextSeverity);
  // 0 = 无法识别的严重度（含 null）：按"未变化"处理，绝不当成最低档从而伪造一次"升级"
  if (prevRank > 0 && nextRank > 0 && nextRank > prevRank) return { reset: true, reason: "severity_up" };
  const days = Math.max(0, input.resetAfterDays ?? 7);
  if (input.now.getTime() - acked >= days * 24 * 60 * 60 * 1000) return { reset: true, reason: "stale_ack" };
  return { reset: false, reason: null };
}
