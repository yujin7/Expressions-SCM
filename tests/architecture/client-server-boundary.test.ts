/**
 * 架构护栏：客户端组件禁止「值导入」服务端模块。
 *
 * 背景（真实事故）：report/exports/exports-client.tsx 曾值导入
 * `@/server/modules/report/export` 取一个标签常量，链路
 *   server/modules/report/export → server/core/dto → server/auth/index → server/auth/config
 *   → @node-rs/argon2（原生模块）+ pg
 * 把整套服务端鉴权栈与数据库驱动拖进客户端 bundle；webpack 解析原生模块失败后模块图被污染，
 * 此后全应用每个页面与 /api/health 一起 500（68 页里 23 页连锁失败），且现象随编译顺序漂移，
 * 极难定位。同时鉴权配置流向前端本身即安全隐患。
 *
 * 规则：`"use client"` 文件里不得出现 `from "@/server/..."` 的值导入。
 * 允许 `import type { X } from "@/server/..."`（类型在编译期擦除，不进 bundle）。
 * 例外白名单：零依赖的纯常量模块（自身不 import 任何东西），如 `@/server/core/constants`。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../src");

/** 自身零 import 的纯数据模块——进客户端包无害 */
const PURE_CONSTANT_ALLOWLIST = ["@/server/core/constants"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("客户端/服务端边界", () => {
  it("客户端组件不得值导入服务端模块（类型导入与纯常量白名单除外）", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf8");
      if (!/^\s*["']use client["']/m.test(src)) continue;
      // 逐条 import 检查：跳过 `import type`
      for (const m of src.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+["'](@\/server\/[^"']+)["']/gm)) {
        const isTypeOnly = Boolean(m[1]);
        const spec = m[2];
        if (isTypeOnly) continue;
        if (PURE_CONSTANT_ALLOWLIST.some((a) => spec === a)) continue;
        offenders.push(`${path.relative(SRC, file)} → ${spec}`);
      }
    }
    expect(offenders, `客户端组件值导入了服务端模块（会把 auth/pg/原生依赖拖进客户端包）：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("白名单里的模块确实是零依赖纯常量（防白名单腐化）", () => {
    for (const spec of PURE_CONSTANT_ALLOWLIST) {
      const rel = spec.replace("@/", "") + ".ts";
      const src = readFileSync(path.join(SRC, rel), "utf8");
      const imports = [...src.matchAll(/^\s*import\s+/gm)];
      expect(imports.length, `${spec} 已引入 import，不再是纯常量模块，应移出白名单`).toBe(0);
    }
  });
});
