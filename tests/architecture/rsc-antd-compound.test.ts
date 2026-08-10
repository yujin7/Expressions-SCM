/**
 * 服务端组件禁止使用 antd 的复合子组件（真实事故护栏）。
 *
 * antd 5 每个组件模块自带 "use client"，服务端组件 import 到的是**客户端引用代理**，
 * 代理上不存在 `Skeleton.Input` / `List.Item` / `Typography.Title` 这类静态子组件属性，
 * 取到 undefined，渲染 <undefined /> 即抛
 * 「Element type is invalid: expected a string … but got: undefined」（React #130）。
 *
 * 事故经过：`src/app/(app)/loading.tsx` 曾是服务端组件且用了 `<Skeleton.Input />`。
 * 它只在**客户端跳转**时作为 Suspense 兜底渲染，直接打开 URL 走 SSR 看不到，
 * 于是表现为「从侧边栏点进某些页面就报错、刷新一下又好」，被误判成偶发的陈旧缓存问题，
 * 排查了很久。构建不会拦住它——那条路径不参与预渲染。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** 从 `import { A, B as C } from "antd"` 收集本地绑定名。 */
function antdBindings(src: string): string[] {
  const names: string[] = [];
  const re = /import\s*\{([^}]+)\}\s*from\s*["']antd["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    for (const part of m[1].split(",")) {
      const alias = part.includes(" as ") ? part.split(" as ")[1] : part;
      const name = alias.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe("服务端组件不得使用 antd 复合子组件", () => {
  const files = walk("src/app");

  it("扫描到足够多的 app 文件（防止 walk 静默失效把测试变成空跑）", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("每个用到 antd 复合子组件的文件都必须带 use client", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (/^\s*["']use client["']/m.test(src)) continue; // 客户端组件不受限
      const bindings = antdBindings(src);
      if (bindings.length === 0) continue;
      for (const name of bindings) {
        // JSX 里的 <Skeleton.Input …> / <List.Item> 等复合用法
        const compound = new RegExp(`<${name}\\.[A-Z]\\w*`);
        const match = compound.exec(src);
        if (match) offenders.push(`${file} → ${match[0]}`);
      }
    }
    expect(
      offenders,
      `以下服务端组件使用了 antd 复合子组件，运行时会渲染 undefined 并抛 React #130；`
      + `请在文件首行加 "use client"：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("(app)/loading.tsx 必须是客户端组件——它正是本次事故的现场", () => {
    const src = readFileSync("src/app/(app)/loading.tsx", "utf8");
    expect(src).toMatch(/^\s*["']use client["']/);
    expect(src).toMatch(/<Skeleton\.Input/); // 保留复合用法，靠 use client 兜住
  });
});
