/**
 * 护栏：system_alerts 的每个 category 都要在告警页有中文标签。
 *
 * 事故背景（2026-08-04）：我加了 `integration_token`（凭据到期）与 `job_failure`
 * （任务失败）两个类别，告警页的 CAT 映射却只有原来两个——新告警会以英文 slug
 * 出现在中文界面里。告警是给人看的，标签认不出就等于降低了它被处理的概率。
 *
 * 扫描面必须跟着**写入面**走（2026-09-04 清理审计 #6）：
 * 原实现只 **非递归** 扫 `src/jobs`，且只认 `ALERT_CATEGORY = "…"` 与行内 `category: "…"`。
 * 但告警写入早已收口成共享引擎 `alerts/engine.upsertAlerts`，**任何地方**都能调用——
 * 从 `src/server/**`、从 `src/jobs` 的子目录、或用一个叫别的名字的常量引入的新类别，
 * 三种写法都能整条溜过去。护栏漏检和"没有问题"长得一模一样。
 *
 * 现在的做法：递归扫 `src/**`，找出每一处 `upsertAlerts(` 调用，从**调用实参**里取 `category`，
 * 字面量直接收，标识符再回文件里解析它的 `const … = "…"`。任何一处解析不出来 → 直接判红，
 * 绝不静默跳过（"扫不到"必须比"扫到了没问题"更响）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const CLIENT = path.join(ROOT, "src/app/(app)/alerts/alerts-client.tsx");
const SRC = path.join(ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) return walk(abs);
    return /\.tsx?$/.test(entry) ? [abs] : [];
  });
}

/** 从 `open` 处的 `(` 起取到配对的 `)`（跳过字符串字面量里的括号） */
function balancedArgs(src: string, open: number): string {
  let depth = 1;
  let quote: string | null = null;
  for (let i = open + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error("upsertAlerts( 括号不配对，扫描逻辑需要修");
}

interface Scan {
  /** 调用点解析出的类别 */
  categories: string[];
  /** 调用点有 category 但解析不出常量值（护栏必须为此判红） */
  unresolved: string[];
  /** 出现过 upsertAlerts( 的文件（相对仓库根） */
  writers: string[];
}

function scanAlertWriters(): Scan {
  const categories = new Set<string>();
  const unresolved: string[] = [];
  const writers: string[] = [];
  for (const abs of walk(SRC)) {
    const rel = path.relative(ROOT, abs);
    const src = readFileSync(abs, "utf8");
    // 引擎自身是被调方，不是写入点
    if (rel.endsWith("src/server/modules/alerts/engine.ts")) continue;
    if (!src.includes("upsertAlerts(")) continue;
    writers.push(rel);
    for (const m of src.matchAll(/upsertAlerts\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      const args = balancedArgs(src, open);
      const cat = args.match(/\bcategory\s*:\s*(?:"([a-z_]+)"|'([a-z_]+)'|([A-Za-z_$][\w$]*))/);
      if (!cat) {
        unresolved.push(`${rel}: upsertAlerts 调用未给 category`);
        continue;
      }
      const literal = cat[1] ?? cat[2];
      if (literal) {
        categories.add(literal);
        continue;
      }
      // 标识符：回本文件解析 `const X = "…"`（常量名可以叫任何名字，不再硬编码 ALERT_CATEGORY）
      const ident = cat[3];
      const decl = src.match(
        new RegExp(`\\b(?:const|let|var)\\s+${ident}\\b[^=\\n]*=\\s*["']([a-z_]+)["']`),
      );
      if (decl) categories.add(decl[1]);
      else unresolved.push(`${rel}: category 取自 ${ident}，本文件里解析不出它的字面量`);
    }
  }
  return { categories: [...categories].sort(), unresolved, writers: writers.sort() };
}

describe("护栏：告警类别有中文标签", () => {
  it("扫描面跟着写入面走：src/** 递归、按 upsertAlerts 调用点取类别", () => {
    const { categories, unresolved, writers } = scanAlertWriters();
    // 防腐化：目录改名/正则失效时不能「全绿」
    expect(writers.length, "src/** 里一个 upsertAlerts 调用点都没扫到，扫描逻辑可能已失效").toBeGreaterThan(3);
    expect(categories.length, "应能从写入点解析出告警类别").toBeGreaterThan(3);
    expect(
      unresolved,
      `以下 upsertAlerts 调用点的 category 解析不出来——护栏不能对它「静默通过」：\n${unresolved.join("\n")}`,
    ).toEqual([]);
  });

  it("每个 system_alerts category 都在告警页 CAT 映射里", () => {
    const client = readFileSync(CLIENT, "utf8");
    const block = client.slice(client.indexOf("const CAT"), client.indexOf("const SEV"));
    const { categories } = scanAlertWriters();
    expect(categories.length, "应能从写入点扫到告警类别").toBeGreaterThan(0);

    const missing = categories.filter((c) => !block.includes(`${c}:`));
    expect(
      missing,
      `以下告警类别在 /alerts 会显示成英文 slug：\n${missing.join("\n")}\n`
        + `告警是给人看的，认不出标签就等于降低了它被处理的概率。`,
    ).toEqual([]);
  });
});
