/**
 * 运行参数缺省值单一权威（2026-09-04 审计 #5）。
 *
 * 事故形态：同一个参数在三处各写一份缺省——`PARAM_DEFS` 的 fallback、调用点
 * `getNumParam("k", 15)` 的字面量、读模型自己的 `DEFAULT_*` 常量。三者一旦不等，
 * 运行参数页显示的数与引擎实际跑的数就不是同一个（实测 `dq_sales_consistency_*`
 * 页面 15/20/50、引擎 10/5/10）。业务照页面调阈值，引擎纹丝不动。
 *
 * 本门禁：
 *  1) 所有 `getNumParam("k", …)` / `getTextParam("k", …)` 的 key 必须登记在 PARAM_DEFS；
 *  2) 调用点如果传**字面量**缺省，必须与 PARAM_DEFS 的 fallback 相等，
 *     语义确实不同的调用点在 SEMANTIC_EXEMPTIONS 里显式登记并写明理由；
 *  3) 不传缺省（推荐写法）由 `getNumParam` 自己回落 PARAM_DEFS，天然不会漂移。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PARAM_DEFS, numParamFallback, paramDef, textParamFallback } from "@/server/core/param-defs";

const root = path.resolve(__dirname, "../..");

/**
 * 语义不同（不是漂移）的调用点：key → { 调用点文件, 该处字面量, 理由 }。
 * 新增豁免必须写清"为什么这里的数与全局缺省不是同一个意思"，否则就是漂移。
 */
const SEMANTIC_EXEMPTIONS: { key: string; file: string; literal: number; reason: string }[] = [
  {
    key: "cover_target_days",
    file: "src/server/modules/report/inventory-alerts.ts",
    literal: 0,
    reason:
      "库存预警阈值 = 加工 + 在途 + 缓冲（D57），传 0 表示「不叠加目标覆盖层」；"
      + "补货引擎的 45 是「目标覆盖天数」。两者是不同的量，不是同一个缺省的两份拷贝。",
  },
];

function walk(relative: string): string[] {
  const absolute = path.join(root, relative);
  return readdirSync(absolute).flatMap((entry) => {
    const child = path.posix.join(relative, entry);
    return statSync(path.join(root, child)).isDirectory()
      ? walk(child)
      : /\.tsx?$/.test(entry)
        ? [child]
        : [];
  });
}

const sources = walk("src").map((file) => ({ file, text: readFileSync(path.join(root, file), "utf8") }));

interface CallSite {
  file: string;
  key: string;
  /** 第二实参的原样文本（可能是字面量、常量名或表达式）；缺省未传时为 null */
  arg: string | null;
}

function callSites(fn: "getNumParam" | "getTextParam"): CallSite[] {
  const out: CallSite[] = [];
  const re = new RegExp(`\\b${fn}\\(\\s*"([a-z0-9_]+)"\\s*(,\\s*([^,)]+))?`, "g");
  for (const { file, text } of sources) {
    if (file === "src/server/core/params.ts" || file === "src/server/core/param-defs.ts") continue;
    for (const m of text.matchAll(re)) {
      out.push({ file, key: m[1], arg: m[3] ? m[3].trim() : null });
    }
  }
  return out;
}

const numSites = callSites("getNumParam");
const textSites = callSites("getTextParam");

describe("运行参数缺省值单一权威（PARAM_DEFS）", () => {
  it("扫描到的调用点非空（正则失效会让整个门禁静默通过）", () => {
    expect(numSites.length).toBeGreaterThan(30);
  });

  it("键唯一，且每个 key 都能取到自己类型的缺省", () => {
    const keys = PARAM_DEFS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of PARAM_DEFS) {
      if (d.kind === "number") expect(numParamFallback(d.key)).toBe(d.fallback);
      else expect(textParamFallback(d.key)).toBe(d.fallback);
    }
  });

  it("未登记的键一律抛错，不静默回落", () => {
    expect(() => numParamFallback("no_such_param")).toThrow(/未登记/);
    expect(() => numParamFallback("tier_basis")).toThrow(/不是数值型/);
    expect(() => textParamFallback("cover_alert_days")).toThrow(/不是枚举型/);
  });

  it("所有 getNumParam / getTextParam 的 key 都已登记在 PARAM_DEFS", () => {
    for (const site of numSites) {
      const def = paramDef(site.key);
      expect(def, `${site.file} 读取未登记参数 ${site.key}`).toBeDefined();
      expect(def!.kind, `${site.key} 是枚举参数，不能用 getNumParam`).toBe("number");
    }
    for (const site of textSites) {
      const def = paramDef(site.key);
      expect(def, `${site.file} 读取未登记参数 ${site.key}`).toBeDefined();
      expect(def!.kind, `${site.key} 是数值参数，不能用 getTextParam`).toBe("enum");
    }
  });

  it("调用点传入的字面量缺省必须等于 PARAM_DEFS 的 fallback（差异即漂移）", () => {
    const drifted: string[] = [];
    for (const site of numSites) {
      if (site.arg == null || !/^-?\d+(\.\d+)?$/.test(site.arg)) continue; // 常量名/表达式交给类型与下一条断言
      const literal = Number(site.arg);
      const expected = numParamFallback(site.key);
      if (literal === expected) continue;
      const exempt = SEMANTIC_EXEMPTIONS.find(
        (e) => e.key === site.key && e.file === site.file && e.literal === literal,
      );
      if (exempt) {
        expect(exempt.reason.length, `${site.key} 豁免缺理由`).toBeGreaterThan(20);
        continue;
      }
      drifted.push(`${site.file}: getNumParam("${site.key}", ${literal}) ≠ PARAM_DEFS fallback ${expected}`);
    }
    expect(drifted, "调用点字面量缺省与白名单不一致（改白名单或删字面量，勿两处各写一份）").toEqual([]);
  });

  it("枚举参数的字面量缺省同样必须与白名单一致", () => {
    for (const site of textSites) {
      if (site.arg == null) continue;
      const m = site.arg.match(/^"([^"]*)"$/);
      if (!m) continue;
      expect(m[1], `${site.file}: getTextParam("${site.key}", "${m[1]}") 与白名单不一致`).toBe(
        textParamFallback(site.key),
      );
    }
  });

  it("已登记的语义豁免必须仍然存在（豁免过期要清理，不能长期挂着）", () => {
    for (const e of SEMANTIC_EXEMPTIONS) {
      const hit = numSites.find((s) => s.file === e.file && s.key === e.key && s.arg === String(e.literal));
      expect(hit, `豁免 ${e.file} ${e.key}=${e.literal} 已不存在，请删除该条`).toBeDefined();
    }
  });

  it("DQ 三阈值的引擎缺省即白名单缺省（此前页面 15/20/50、引擎 10/5/10）", async () => {
    const { DEFAULT_SALES_CONSISTENCY_THRESHOLDS } = await import("@/server/modules/report/sales-consistency");
    expect(DEFAULT_SALES_CONSISTENCY_THRESHOLDS).toEqual({
      relPct: numParamFallback("dq_sales_consistency_rel_pct"),
      absFloorQty: numParamFallback("dq_sales_consistency_abs_floor_qty"),
      minBaseQty: numParamFallback("dq_sales_consistency_min_base_qty"),
    });
    expect(DEFAULT_SALES_CONSISTENCY_THRESHOLDS).toEqual({ relPct: 15, absFloorQty: 20, minBaseQty: 50 });
  });
});
