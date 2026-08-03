/**
 * 架构护栏：集成层读取的每个环境变量都必须在 `.env.example` 里登记。
 *
 * 事故背景（2026-08-04）：我加了 `YY_SYNC_ACTOR_ID`、`JST_TOKEN_OBTAINED_AT`、
 * `JST_TOKEN_TTL_DAYS` 三个变量却没写进 `.env.example`。后果不是"文档不全"这么轻——
 * `YY_SYNC_ACTOR_ID` 缺失时用友同步任务每次都静默 skipped，
 * 而部署的人根本不知道存在这个变量，会一直以为"接通了但没数据"。
 *
 * 这类缺陷本地永远发现不了：我的 `.env` 里有值，`.env.example` 里没有。
 * 故用护栏钉住：集成/同步相关代码里出现的 env 键，必须能在 `.env.example` 找到。
 *
 * 只扫集成与任务层——全仓扫会把 NODE_ENV/CI 等运行时变量也卷进来，噪声淹没信号。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

/** 平台/运行时变量，不属于部署者要填的集成配置 */
const RUNTIME_KEYS = new Set([
  "NODE_ENV", "CI", "PORT", "HOSTNAME", "TZ", "NEXT_RUNTIME",
  "DATABASE_URL", "AUTH_SECRET", "AUTH_URL", "FILE_STORAGE_DIR",
  "BACKUP_DIR", "ATTACH_ROOT", "PGLITE_DATA_DIR",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

function declaredKeys(): Set<string> {
  const src = readFileSync(path.join(ROOT, ".env.example"), "utf8");
  const keys = new Set<string>();
  for (const line of src.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (m) keys.add(m[1]);
  }
  return keys;
}

describe("架构护栏：.env.example 覆盖集成层用到的变量", () => {
  it("集成/同步代码读取的 env 键都能在 .env.example 找到", () => {
    const declared = declaredKeys();
    const files = [
      ...walk(path.join(ROOT, "src/server/integrations")),
      ...walk(path.join(ROOT, "src/jobs")),
    ];

    const missing = new Map<string, string>();
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // env.KEY / process.env.KEY / env["KEY"] 三种写法
      for (const match of src.matchAll(/(?:process\.)?env(?:\.([A-Z][A-Z0-9_]*)|\[["']([A-Z][A-Z0-9_]*)["']\])/g)) {
        const key = match[1] ?? match[2];
        if (!key || RUNTIME_KEYS.has(key) || declared.has(key)) continue;
        if (!missing.has(key)) missing.set(key, path.relative(ROOT, file));
      }
    }

    expect(
      [...missing].map(([key, file]) => `${key}（${file}）`),
      "以下变量代码在读、.env.example 没登记——部署的人不会知道要填，\n"
        + "而缺失往往表现为任务静默跳过而非报错（例：YY_SYNC_ACTOR_ID 缺失 ⇒ 用友同步每次 skipped）。",
    ).toEqual([]);
  });
});
