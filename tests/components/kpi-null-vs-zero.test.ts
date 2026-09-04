/**
 * KPI 条：「没加载出来」和「真的是 0」必须长得不一样。
 *
 * 事故背景（2026-09-04 审计）：这几页的 KPI 一律写成 `s?.x ?? 0`。接口 500 时页面照样
 * 渲染出一排 `0`，读起来是**结论**——「异动侦测 0 项命中」＝一切正常，
 * 「建议闭环 0 条草稿」＝没人提过建议，「预测做负功 0 个 SKU」＝预测都很好。
 * 交期学习更进一步：一条承诺样本都没有时，平均准时率显示 `0.0%`＝供应商全都不准时。
 *
 * 约定：未加载 → `—` + `LoadErrorAlert`（可见、可重试）；无样本 → `—`，不是 0。
 * 参照实现见 auto-replenish / material-demand。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

/** 本轮修复的四页（新增同类 KPI 页时补进来） */
const KPI_PAGES = [
  "src/app/(app)/report/closed-loop/closed-loop-client.tsx",
  "src/app/(app)/report/detectors/detectors-client.tsx",
  "src/app/(app)/report/forecast-accuracy/forecast-accuracy-client.tsx",
  "src/app/(app)/report/supplier-scorecard/leadtime-learning-tab.tsx",
];

describe("KPI 未加载态：— 而不是 0", () => {
  it("四页都挂了 LoadErrorAlert（失败可见、可重试）", () => {
    for (const file of KPI_PAGES) {
      const src = read(file);
      expect(src, file).toContain("LoadErrorAlert");
      expect(src, file).toContain("loadError");
      expect(src, file).toMatch(/onRetry=\{\(\)\s*=>\s*void load\(\)\}/);
    }
  });

  it("KPI 数值不得再写 `?? 0` 兜底（那会把请求失败伪装成业务为零）", () => {
    for (const file of KPI_PAGES) {
      const src = read(file);
      const offenders = [...src.matchAll(/value=\{[^}]*\?\?\s*0[^}]*\}/g)].map((m) => m[0]);
      expect(offenders, `${file} 的 KPI 仍用 0 兜底：\n${offenders.join("\n")}`).toEqual([]);
      // 至少有一处显式的「—」占位
      expect(src, file).toContain('"—"');
    }
  });

  it("交期学习：无承诺样本时平均准时率是「—」，不是 0.0%", () => {
    const src = read("src/app/(app)/report/supplier-scorecard/leadtime-learning-tab.tsx");
    expect(src).toContain('value={s?.avgOnTimeRate == null ? "—" : s.avgOnTimeRate * 100}');
    // 单位与小数位也要跟着空值一起消失，否则会渲染成「— %」
    expect(src).toContain('suffix={s?.avgOnTimeRate == null ? "" : "%"}');
    expect(src).toContain("precision={s?.avgOnTimeRate == null ? undefined : 1}");
  });

  it("每日经营摘要：加载失败不再整页 return null（空白页分不清「今天没简报」和「接口挂了」）", () => {
    const src = read("src/app/(app)/workbench/digest-view.tsx");
    expect(src).not.toMatch(/if\s*\(!data\)\s*return null;/);
    expect(src).toContain("LoadErrorAlert");
    expect(src).toContain("Empty");
  });
});
