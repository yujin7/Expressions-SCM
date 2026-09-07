/**
 * 架构护栏：客户端 fetch 的 `/api/...` 路径必须真的存在对应的 route.ts。
 *
 * 事故背景（2026-09-04 审计）：`components/CommandPalette.tsx` 的实体搜索请求
 * `/api/inbox/search?q=`——这条路由**早就不存在了**（全局搜索改到 `/api/search`）。
 * 请求 404，`catch { /* ignore *​/ }` 又把错误吞掉，于是 ⌘K 在全站静默返回空结果：
 * 用户按下 ⌘K 搜一个 SKU，什么都没有，然后得出「系统里没有这个 SKU」的结论。
 *
 * 这类缺陷 tsc / lint / 单测全绿——字符串里的路径没有任何编译期约束。
 * 所以这里用「路径字面量 → 文件系统」的对照把它钉住：
 * 路由被改名或删除时，下一次 `npm run lint`/CI 就会红，而不是等用户来报「搜不到」。
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const APP = path.join(root, "src/app");

function walk(dir: string, matcher: RegExp): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const child = path.join(dir, entry);
    if (statSync(child).isDirectory()) return walk(child, matcher);
    return matcher.test(entry) ? [child] : [];
  });
}

/** `/api/a/b?x=1` → `src/app/api/a/b/route.ts` 是否存在（动态段 [id] 用同层唯一目录兜底） */
function routeExists(apiPath: string): boolean {
  const clean = apiPath.split("?")[0].replace(/\/+$/, "");
  const segments = clean.split("/").filter(Boolean); // ["api", ...]
  let dir = APP;
  for (const seg of segments) {
    const direct = path.join(dir, seg);
    if (existsSync(direct) && statSync(direct).isDirectory()) { dir = direct; continue; }
    // 动态段：同层若只有一个 [xxx] 目录就认为命中（路径里写的是具体 id）
    const dynamic = readdirSync(dir).filter((e) => /^\[.+\]$/.test(e) && statSync(path.join(dir, e)).isDirectory());
    if (dynamic.length !== 1) return false;
    dir = path.join(dir, dynamic[0]);
  }
  return existsSync(path.join(dir, "route.ts"));
}

/**
 * 源码里**完整**的 `/api/...` 路径字面量：必须以引号或 `?` 收尾。
 * 被 `${}` 插值截断的前缀（`/api/outsource/${docType}/…`）不参与断言——那不是一条真实路径，
 * 硬要判会把正常写法误报成悬空路由。
 */
function apiPathsIn(source: string): string[] {
  const hits = new Set<string>();
  for (const m of source.matchAll(/["'`](\/api\/[A-Za-z0-9\-_/[\]]*?)(?=[?"'`])/g)) {
    const p = m[1].replace(/\/$/, "");
    if (p.length > "/api/".length) hits.add(p);
  }
  return [...hits];
}

describe("架构护栏：客户端请求的 API 路径必须存在", () => {
  it("components/ 与 (app)/ 下所有 /api 路径字面量都能落到 route.ts", () => {
    const files = [
      ...walk(path.join(root, "src/components"), /\.tsx?$/),
      ...walk(path.join(APP, "(app)"), /\.tsx?$/),
    ];
    const dangling: string[] = [];
    for (const file of files) {
      for (const apiPath of apiPathsIn(readFileSync(file, "utf8"))) {
        if (!routeExists(apiPath)) dangling.push(`${path.relative(root, file)} → ${apiPath}`);
      }
    }
    expect(
      dangling,
      `以下前端请求指向不存在的 API 路由（404 会被 catch 吞成「无结果」）：\n${dangling.join("\n")}`,
    ).toEqual([]);
  });

  it("⌘K 命令面板指向真实的全局搜索路由，且失败不再被吞", () => {
    const palette = readFileSync(path.join(root, "src/components/CommandPalette.tsx"), "utf8");
    // 契约：GET /api/search?q= → { groups: [{ title, items:[{label, href, tag}] }] }
    const lifecycle = readFileSync(path.join(root, "src/components/useEntitySearch.ts"), "utf8");
    expect(palette).toContain('from "@/components/useEntitySearch"');
    expect(lifecycle).toContain('"/api/search"');
    // 注释里保留事故记载，代码里不得再有这条死路由
    const code = palette.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("/api/inbox/search");
    expect(routeExists("/api/search")).toBe(true);
    const searchRoute = readFileSync(path.join(APP, "api/search/route.ts"), "utf8");
    expect(searchRoute).toContain('searchParams.get("q")');
    expect(searchRoute).toContain("searchAll");

    // 失败态：不得再出现「catch 里什么都不做」，且面板要有可见的失败提示
    expect(palette).not.toMatch(/catch\s*\{\s*\/\*\s*ignore\s*\*\/\s*\}/);
    expect(palette).toContain("search.error");
    expect(palette).toContain('role="alert"');
    expect(lifecycle).toMatch(/if\s*\(\s*!res\.ok\s*\)/);
  });
});
