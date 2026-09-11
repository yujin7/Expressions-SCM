/**
 * 闭环 UI 接线护栏：原因码常量必须是零依赖纯模块（客户端表单值导入不拖 pg/auth），
 * schema / 服务只再导出同一引用（口径不漂移）；指标注册表登记闭环四指标；
 * metrics.ts 的 `^  \w+: \{$` 开与 `^  \},$` 闭计数相等（CLAUDE.md：union 合并吞括号护栏）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "@/db/schema";
import { DECLINE_REASON_CODES as SERVER_DECLINE_REASON_CODES } from "@/server/modules/replenish/decline";
import { ALERT_CLOSE_REASON_CODES, ALERT_CLOSE_REASON_LABELS, MANUAL_CLOSE_REASON_CODES } from "@/lib/alert-close-reasons";
import { DECLINE_REASON_CODES, DECLINE_REASON_LABELS } from "@/lib/replenish-decline-reasons";
import { METRICS, metricTooltip } from "@/components/metrics";

const SRC = path.resolve(__dirname, "../../src");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

describe("闭环 UI 常量与注册表", () => {
  it("原因码常量模块零依赖；schema 与 decline 服务只是再导出同一引用", () => {
    for (const rel of ["lib/alert-close-reasons.ts", "lib/replenish-decline-reasons.ts"]) {
      expect([...read(rel).matchAll(/^\s*import\s+/gm)].length, `${rel} 引入了 import，不再是纯常量模块`).toBe(0);
    }
    expect(schema.MANUAL_CLOSE_REASON_CODES).toBe(MANUAL_CLOSE_REASON_CODES);
    expect(schema.ALERT_CLOSE_REASON_CODES).toBe(ALERT_CLOSE_REASON_CODES);
    expect(SERVER_DECLINE_REASON_CODES).toBe(DECLINE_REASON_CODES);
  });

  it("每个原因码都有中文标签与说明；人工关闭原因不含 auto_hysteresis 且是全集子集", () => {
    for (const c of ALERT_CLOSE_REASON_CODES) {
      expect(ALERT_CLOSE_REASON_LABELS[c].label.length).toBeGreaterThan(0);
      expect(ALERT_CLOSE_REASON_LABELS[c].hint.length).toBeGreaterThan(0);
    }
    expect(MANUAL_CLOSE_REASON_CODES).not.toContain("auto_hysteresis");
    for (const c of MANUAL_CLOSE_REASON_CODES) expect(ALERT_CLOSE_REASON_CODES).toContain(c);
    for (const c of DECLINE_REASON_CODES) {
      expect(DECLINE_REASON_LABELS[c].label.length).toBeGreaterThan(0);
      expect(DECLINE_REASON_LABELS[c].hint.length).toBeGreaterThan(0);
    }
  });

  it("闭环客户端组件只值导入 @/lib 常量，不碰 @/server / @/db", () => {
    for (const rel of ["components/AlertCloseModal.tsx", "components/AlertWhyList.tsx", "app/(app)/replenish/decline-modal.tsx"]) {
      const src = read(rel);
      expect(src, `${rel} 缺少 "use client"`).toMatch(/^\s*["']use client["']/m);
      expect(src, `${rel} 值导入了服务端模块`).not.toMatch(/^\s*import\s+(?!type\s)[^;]*?from\s+["']@\/(?:server|db)\//m);
    }
    expect(read("components/AlertCloseModal.tsx")).toContain("/api/alerts/${alertId}/close");
    expect(read("app/(app)/replenish/decline-modal.tsx")).toContain("/api/replenish/decline");
  });

  it("指标注册表登记闭环四指标（含公式与 caveat）；metrics.ts 开闭括号计数相等", () => {
    for (const id of ["alertPrecision", "todoCompletionRateStrict", "suggestionOrderedRatio", "suggestionRealizedRatio"]) {
      const m = METRICS[id];
      expect(m?.id, `${id} 未登记`).toBe(id);
      expect(m.formula, `${id} 缺公式`).toBeTruthy();
      expect(m.caveat, `${id} 缺 caveat`).toBeTruthy();
      expect(metricTooltip(id)).toContain("注意：");
    }
    expect(METRICS.alertPrecision.unit).toBe("pct");
    expect(METRICS.todoCompletionRateStrict.unit).toBe("pct");
    expect(METRICS.suggestionOrderedRatio.unit).toBe("count");
    expect(METRICS.suggestionRealizedRatio.unit).toBe("count");
    const lines = read("components/metrics.ts").split("\n");
    const opens = lines.filter((l) => /^ {2}\w+: \{$/.test(l)).length;
    const closes = lines.filter((l) => /^ {2}\},$/.test(l)).length;
    expect(opens, "metrics.ts 指标块开/闭括号数不等（union 合并吞括号）").toBe(closes);
  });
});
