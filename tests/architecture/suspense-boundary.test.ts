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
 * 靠 CLAUDE.md 的一行文字和历史 playbook 的提醒都是「建议」，
 * 建议挡不住第 25 次遗漏。
 *
 * 口径取 `useSearchParams` 而非 `useListState`：前者才是根因。
 * 仓库里除 useListState 外，`audit-client` / `pc-client` / `jg-client` 等
 * 也直接用了 useSearchParams，只盯 useListState 会漏掉它们。
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

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

/** Type-only imports disappear from JavaScript; they cannot execute a navigation hook. */
function runtimeDependencies(source: string): string[] {
  const ast = ts.createSourceFile("consumer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return ast.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return [];
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) return [];
      if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(element => element.isTypeOnly)) return [];
    } else {
      if (statement.isTypeOnly) return [];
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause) && clause.elements.length > 0
        && clause.elements.every(element => element.isTypeOnly)) return [];
    }
    const spec = statement.moduleSpecifier.text;
    return spec.startsWith(".") || spec.startsWith("@/components/") ? [spec] : [];
  });
}

/** 该文件（含其运行时本地依赖）是否触达 useSearchParams */
function touchesHook(file: string, seen = new Set<string>(), depth = 0): boolean {
  if (seen.has(file) || depth > MAX_DEPTH) return false;
  seen.add(file);
  const src = read(file);
  if (src.includes(HOOK)) return true;
  const dir = path.dirname(file);
  for (const spec of runtimeDependencies(src)) {
    const target = resolveSpec(spec, dir);
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
  it("follows runtime re-exports while ignoring erased type re-exports", () => {
    expect(runtimeDependencies(`
      export type { ListState } from './types';
      export { type State } from './more-types';
      export { useListState } from './list';
      export { type State, Toolbar } from './mixed-exports';
      export * from './all';
    `)).toEqual(['./list', './mixed-exports', './all']);
  });
  it("still detects real list hooks without treating a typed shared toolbar as a hook caller", () => {
    expect(touchesHook(path.join(APP, "master/supplier/supplier-client.tsx"))).toBe(true);
    expect(touchesHook(path.join(SRC, "components/CrudTable.tsx"))).toBe(false);
  });
  it("ignores erased type imports but follows real, mixed and side-effect dependencies", () => {
    expect(runtimeDependencies(`
      import type { ListState } from './types';
      import { type Density, type State } from '@/components/types';
      import { type State, useListState } from './mixed';
      import Toolbar from '@/components/ListToolbar';
      import * as runtime from './namespace';
      import './side-effect';
    `)).toEqual(['./mixed', '@/components/ListToolbar', './namespace', './side-effect']);
  });
  it("触达 useSearchParams 的 page.tsx 必须包 <Suspense>（缺失=整页水合失败，但路由仍返回 200）", () => {
    const need: string[] = [];
    const offenders: string[] = [];

    for (const page of allPageFiles(APP)) {
      if (!touchesHook(page)) continue;
      need.push(page);
      const src = read(page);
      const rel = path.relative(SRC, page);

      if (!/\bSuspense\b/.test(src)) {
        offenders.push(`${rel}（完全没有 Suspense）`);
        continue;
      }
      /* 光有 Suspense **不够**——组件必须真的在边界**内**。
         红队实证的绕过写法（本护栏首版被它骗过）：
             <><Suspense fallback={null}><h1>标题</h1></Suspense><XxxClient /></>
         Suspense 在、正则通过，而客户端组件在边界外，水合照样整页失败。
         所以这里检查「包含关系」：每个本地 *-client 组件的使用点，
         必须落在某一对 <Suspense …> … </Suspense> 之间。 */
      const clientTags = new Set<string>();
      for (const m of src.matchAll(/import\s+(\w+)\s+from\s+["']\.\/[\w.-]*client["']/g)) clientTags.add(m[1]);
      if (clientTags.size === 0) continue; // 页面自身就是客户端组件或结构特殊，交给上面的存在性检查

      const spans: [number, number][] = [];
      const openRe = /<Suspense\b[^>]*>/g;
      for (let om = openRe.exec(src); om; om = openRe.exec(src)) {
        const close = src.indexOf("</Suspense>", om.index);
        if (close > -1) spans.push([om.index, close]);
      }
      for (const tag of clientTags) {
        const useRe = new RegExp(`<${tag}\\b`, "g");
        for (let um = useRe.exec(src); um; um = useRe.exec(src)) {
          const inside = spans.some(([a, b]) => um!.index > a && um!.index < b);
          if (!inside) offenders.push(`${rel}（<${tag}> 在 Suspense 边界之外）`);
        }
      }
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
