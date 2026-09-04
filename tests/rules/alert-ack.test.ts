/** 审计 A3(2)：已知悉告警再命中何时清知悉（rules/alert-ack.ts） */
import { describe, expect, it } from "vitest";
import { ackResetOnRehit, severityRank } from "@/server/rules/alert-ack";

const NOW = new Date("2026-09-10T03:00:00.000Z");

describe("ackResetOnRehit", () => {
  it("未知悉 → 不动", () => {
    expect(ackResetOnRehit({ ackedAt: null, prevSeverity: "medium", nextSeverity: "critical", now: NOW })).toEqual({ reset: false, reason: null });
  });
  it("严重度升级（medium→high、high→critical）→ 清知悉，与知悉时间无关", () => {
    const justNow = new Date(NOW.getTime() - 60_000);
    expect(ackResetOnRehit({ ackedAt: justNow, prevSeverity: "medium", nextSeverity: "high", now: NOW })).toEqual({ reset: true, reason: "severity_up" });
    expect(ackResetOnRehit({ ackedAt: justNow, prevSeverity: "high", nextSeverity: "critical", now: NOW })).toEqual({ reset: true, reason: "severity_up" });
  });
  it("红队 (b)：旧严重度为空 / 无法识别时按「未变化」处理，不得伪造一次升级把合法的知悉打回", () => {
    const justNow = new Date(NOW.getTime() - 60_000);
    // 历史行 severity 为空：第一次刷新不该清知悉（原实现 severityRank(null)=0，medium>0 判成升级）
    expect(ackResetOnRehit({ ackedAt: justNow, prevSeverity: null, nextSeverity: "medium", now: NOW })).toEqual({ reset: false, reason: null });
    expect(ackResetOnRehit({ ackedAt: justNow, prevSeverity: "weird", nextSeverity: "critical", now: NOW })).toEqual({ reset: false, reason: null });
    // 但 stale_ack 仍照常兜底：知悉满 7 天还在命中，照样清
    const sevenDays = new Date(NOW.getTime() - 7 * 86_400_000);
    expect(ackResetOnRehit({ ackedAt: sevenDays, prevSeverity: null, nextSeverity: "medium", now: NOW })).toEqual({ reset: true, reason: "stale_ack" });
  });
  it("同级或降级：知悉 < 7 天保留；≥ 7 天清知悉（stale_ack）", () => {
    const sixDays = new Date(NOW.getTime() - 6 * 86_400_000);
    const sevenDays = new Date(NOW.getTime() - 7 * 86_400_000);
    expect(ackResetOnRehit({ ackedAt: sixDays, prevSeverity: "high", nextSeverity: "high", now: NOW })).toEqual({ reset: false, reason: null });
    expect(ackResetOnRehit({ ackedAt: sixDays, prevSeverity: "high", nextSeverity: "medium", now: NOW })).toEqual({ reset: false, reason: null });
    expect(ackResetOnRehit({ ackedAt: sevenDays, prevSeverity: "high", nextSeverity: "high", now: NOW })).toEqual({ reset: true, reason: "stale_ack" });
    expect(ackResetOnRehit({ ackedAt: sevenDays.toISOString(), prevSeverity: "high", nextSeverity: "medium", now: NOW })).toEqual({ reset: true, reason: "stale_ack" });
  });
  it("resetAfterDays 可调；非法 ackedAt 不动", () => {
    const twoDays = new Date(NOW.getTime() - 2 * 86_400_000);
    expect(ackResetOnRehit({ ackedAt: twoDays, prevSeverity: "high", nextSeverity: "high", now: NOW, resetAfterDays: 1 }).reset).toBe(true);
    expect(ackResetOnRehit({ ackedAt: "not-a-date", prevSeverity: "high", nextSeverity: "critical", now: NOW }).reset).toBe(false);
  });
  it("severityRank：medium < high < critical，未知 = 0", () => {
    expect([severityRank("medium"), severityRank("HIGH"), severityRank("critical"), severityRank(null), severityRank("weird")]).toEqual([1, 2, 3, 0, 0]);
  });
});
