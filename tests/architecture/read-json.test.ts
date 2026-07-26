/**
 * 架构护栏：写路由必须用 `readJson(req)`，禁止裸 `await req.json()`。
 *
 * 事故背景（2026-07-26 全仓审计）：88 个 API 文件裸调 `req.json()`。
 * 空体或坏 JSON 会抛 `SyntaxError`，而 `errorResponse` 只分流
 * ApiError / ZodError / 23505，SyntaxError 落进兜底分支 → **回 500 并往
 * error_logs 插一条带 errorId 的记录**。两层后果：
 *   ① 客户端发错请求，用户看到的是「系统错误，请联系管理员」；
 *   ② `/api/public/po-confirm/[token]` 匿名可达，且解析发生在 token 校验**之前**，
 *      等于一条无需登录即可持续写 error_logs 的通道，还会污染 /admin/health 的错误计数。
 *
 * 这类缺陷单测抓不到（happy path 永远传合法 body），只有静态扫描能守。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const API = path.resolve(__dirname, "../../src/app/api");

/**
 * 白名单：**语义确实不同**的「可选 body」路由——`.catch(() => ({}))` 表示
 * 空 body 是合法输入（走默认值），不是错误。它们不该被强制 400。
 */
const ALLOW_OPTIONAL_BODY = [
  path.join("master", "bom", "[id]", "activate", "route.ts"),
  path.join("import", "exceptions", "[id]", "ignore", "route.ts"),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

describe("架构护栏：请求体解析统一走 readJson", () => {
  it("**禁止裸 `await req.json()`**——坏 body 必须回 400，不得变成 500 + error_logs", () => {
    const offenders: string[] = [];
    for (const file of walk(API)) {
      const rel = path.relative(API, file);
      const src = readFileSync(file, "utf8");
      // 允许 `req.json().catch(...)`（可选 body），只抓没有兜底的裸调
      const bare = /await\s+req\.json\(\)\s*(?!\.catch)/.test(src);
      if (!bare) continue;
      if (ALLOW_OPTIONAL_BODY.some((a) => rel === a)) continue;
      offenders.push(rel);
    }
    expect(
      offenders,
      `以下路由裸调 req.json()，空体/坏 JSON 会回 500 并写 error_logs：\n${offenders.join("\n")}\n` +
        `改用 readJson(req) —— src/server/modules/master/common.ts`,
    ).toEqual([]);
  });

  it("白名单只保留真正「空 body 合法」的路由，且必须真的带 .catch 兜底", () => {
    for (const rel of ALLOW_OPTIONAL_BODY) {
      const src = readFileSync(path.join(API, rel), "utf8");
      expect(src, `${rel} 在白名单里，就必须有 .catch 兜底`).toMatch(/req\.json\(\)\.catch/);
    }
    // 防腐化：白名单不许无声增长
    expect(ALLOW_OPTIONAL_BODY).toHaveLength(2);
  });

  it("匿名可达的公开路由尤其不能裸调（它在 token 校验之前解析 body）", () => {
    const pub = path.join(API, "public", "po-confirm", "[token]", "route.ts");
    const src = readFileSync(pub, "utf8");
    expect(src).toContain("readJson");
    expect(src).not.toMatch(/await\s+req\.json\(\)/);
  });
});
