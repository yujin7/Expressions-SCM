/**
 * 包体过期错误识别：决定错误边界是「自动重载」还是「亮出错误原文」。
 * 判错方向不同代价不同——把真错误误判成过期会被刷新反复掩盖，
 * 把过期误判成真错误则让人以为数据坏了，所以两侧都要钉住。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isStaleBundleError } from "@/components/stale-bundle";

describe("包体过期错误识别", () => {
  it("识别各引擎的 chunk / 动态 import 失败文案", () => {
    const stale = [
      { name: "ChunkLoadError", message: "Loading chunk 4821 failed." },
      { name: "Error", message: "Loading chunk 12 failed.\n(error: http://x/_next/static/chunks/12.js)" },
      { name: "TypeError", message: "Failed to fetch dynamically imported module: http://x/_next/static/chunks/app/page.js" },
      { name: "TypeError", message: "error loading dynamically imported module" },
      { name: "TypeError", message: "Importing a module script failed." },
    ];
    for (const e of stale) expect(isStaleBundleError(e), e.message).toBe(true);
  });

  it("真正的渲染/业务错误不得被当成过期而被自动刷新掩盖", () => {
    const real = [
      { name: "Error", message: "Objects are not valid as a React child (found: object with keys {label})" },
      { name: "TypeError", message: "Cannot read properties of undefined (reading 'map')" },
      { name: "Error", message: "未登录或账号已停用" },
      { name: "Error", message: "Hydration failed because the server rendered HTML didn't match the client" },
      { name: "URIError", message: "URI malformed" },
    ];
    for (const e of real) expect(isStaleBundleError(e), e.message).toBe(false);
  });

  it("空值安全", () => {
    expect(isStaleBundleError(null)).toBe(false);
    expect(isStaleBundleError(undefined)).toBe(false);
    expect(isStaleBundleError({})).toBe(false);
  });

  it("错误边界必须把错误原文渲染出来——只写 console 等于每次排障都要重新复现", () => {
    const src = readFileSync("src/app/(app)/error.tsx", "utf8");
    // 非过期分支要展示 message 本身，并且可复制
    expect(src).toMatch(/message\.slice\(/);
    expect(src).toMatch(/copyable/);
    // 过期分支要自动重载，且带同路径节流以免死循环
    expect(src).toMatch(/window\.location\.reload\(\)/);
    expect(src).toMatch(/sessionStorage/);
  });
});
