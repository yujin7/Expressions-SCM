/**
 * 架构护栏：本地环境配置只能有一个事实来源。
 *
 * 事故背景（2026-08-03 三方联调实测）：仓库里同时存在 `.env` 与 `.env.local`，
 * 且有 7 个键取值不同。Next.js 的加载顺序是 `.env.local` 覆盖 `.env`，于是：
 *   - 体检/探针脚本读 `.env` → 用友走 api.diwork.com（实测正确的业务网关）；
 *   - 真正跑起来的应用读 `.env.local` → 走 c4.yonyoucloud.com（实测统一返回空 401 的登录门户），
 *     且 YY_ALLOWED_HOSTS 只有 c4，会把正确网关挡在出站白名单外。
 * 同一根因还让就绪度体检误报"简道云缺 API Key"——key 一直在 `.env.local` 里。
 *
 * 「配置说的」和「应用用的」不是一套值，是最难查的一类故障：所有单测都绿，
 * 线上行为却和你读到的配置无关。本护栏钉住单一配置源。
 *
 * 注：.env* 都不入库，CI 上通常不存在——两个文件缺任一则跳过，只在本地真正有风险时告警。
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

function parseEnv(file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

describe("架构护栏：环境配置单一来源", () => {
  it("`.env` 与 `.env.local` 不得同时存在并给同一个键不同取值", () => {
    const base = path.join(ROOT, ".env");
    const local = path.join(ROOT, ".env.local");
    if (!existsSync(base) || !existsSync(local)) return; // CI 无 .env，跳过

    const a = parseEnv(base);
    const b = parseEnv(local);
    const conflicts = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k));

    expect(
      conflicts,
      `以下键在 .env 与 .env.local 中取值不同，运行时 .env.local 生效：\n` +
        `${conflicts.map((k) => `  - ${k}`).join("\n")}\n` +
        `脚本/体检若只读 .env，会得出与应用实际行为相反的结论。请合并为单一配置源。`,
    ).toEqual([]);
  });
});
