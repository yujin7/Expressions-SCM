/**
 * 架构护栏：用了 useSearchParams 的页面，page.tsx 必须包 <Suspense>。
 *
 * 背景（本项目最贵的一次事故）：`useListState` 内部调 `useSearchParams`。
 * Next.js App Router 下，若 `page.tsx` 不包 Suspense 边界，React 的 `useId` 序列
 * 在 SSR 与 CSR 之间错位 → **整页水合失败**：Tab 退化成纯文本、表头重复渲染、
 * 什么都点不动。一次性波及 24 个 page.tsx（commit aaf3d63）。
 *
 * 为什么必须由测试来守：这个缺陷**每一条常规信号都是绿的**——
 * 路由返回 200、tsc 零错、单测全绿、页面 HTML 看着有内容。
 * 只有人肉打开页面点一下，或本测试，才会发现它。
 * 靠 CLAUDE.md 的一行文字和 skill `list-page` 的提醒都是「建议」，
 * 建议挡不住第 25 次遗漏。
 *
 * 口径取 `useSearchParams` 而非 `useListState`：前者才是根因。
 * 仓库里除 useListState 外，`audit-client` / `pc-client` / `jg-client` 等
 * 也直接用了 useSearchParams，只盯 useListState 会漏掉它们。
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../src");
const APP = path.join(SRC, "app", "(app)");

const HOOK = "useSearchParams";
/** 相对 import 与 @/components/* 都要跟进；跟太深无意义且会拖慢 */
const MAX_DEPTH = 4;

function read(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** 把一条 import 说明符解析成真实文件路径（补 .tsx/.ts/index） */
function resolveSpec(spec: string, fromDir: string): string | null {
  const base = spec.startsWith("@/")
    ? path.join(SRC, spec.slice(2))
    : path.resolve(fromDir, spec);
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    if (existsSync(base + ext) && statSync(base + ext).isFile()) return base + ext;
  }
  return existsSync(base) && statSync(base).isFile() ? base : null;
}

/** 该文件（含其本地依赖）是否触达 useSearchParams */
function touchesHook(file: string, seen = new Set<string>(), depth = 0): boolean {
  if (seen.has(file) || depth > MAX_DEPTH) return false;
  seen.add(file);
  const src = read(file);
  if (src.includes(HOOK)) return true;
  const dir = path.dirname(file);
  for (const m of src.matchAll(/from\s+["'](\.[^"']+|@\/components\/[^"']+)["']/g)) {
    const target = resolveSpec(m[1], dir);
    if (target && touchesHook(target, seen, depth + 1)) return true;
  }
  return false;
}

function allPageFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) allPageFiles(p, out);
    else if (name === "page.tsx") out.push(p);
  }
  return out;
}

describe("架构护栏：Suspense 边界", () => {
  it("触达 useSearchParams 的 page.tsx 必须包 <Suspense>（缺失=整页水合失败，但路由仍返回 200）", () => {
    const need: string[] = [];
    const offenders: string[] = [];

    for (const page of allPageFiles(APP)) {
      if (!touchesHook(page)) continue;
      need.push(page);
      if (!/\bSuspense\b/.test(read(page))) offenders.push(path.relative(SRC, page));
    }

    // 防腐化：若这个数字掉到 0，说明解析逻辑坏了（比如目录改名），
    // 此时护栏会「全绿」但其实什么都没查——那比没有护栏更危险。
    expect(need.length, "未识别到任何需要 Suspense 的页面，解析逻辑可能已失效").toBeGreaterThan(20);

    expect(
      offenders,
      `以下 page.tsx 触达 useSearchParams 但未包 <Suspense>，会导致整页水合失败\n` +
        `（现象：Tab 变纯文本、表头重复、点不动；而路由仍返回 200、单测仍全绿）：\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
