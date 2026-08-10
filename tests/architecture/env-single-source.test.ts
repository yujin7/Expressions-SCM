/**
 * 架构护栏：本地环境配置只能有一个事实来源。
 *
 * 事故背景（2026-08-03 三方联调实测）：仓库里同时存在 `.env` 与 `.env.local`，
 * 且有 7 个键取值不同。Next.js 的加载顺序是 `.env.local` 覆盖 `.env`，于是体检/探针脚本
 * 与真正应用读取了不同的用友网关和 allowlist。后续矩阵实测确认权威网关是
 * `c4.yonyoucloud.com/iuap-api-gateway`；这里要钉住的根因不是哪份旧值碰巧正确，而是
 * 「体检看到的配置」与「应用实际配置」绝不能分叉。
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

describe("架构护栏：环境配置单一来源", () => {
  it("`.env` 与 `.env.local` 不得同时存在，包括键集合互不重叠的情形", () => {
    const base = path.join(ROOT, ".env");
    const local = path.join(ROOT, ".env.local");
    expect(
      existsSync(base) && existsSync(local),
      ".env 与 .env.local 同时存在；即使键不重叠，Next 也会合并两者，" +
        "只读其中一份的脚本仍会与应用看到不同配置。请合并为单一配置源。",
    ).toBe(false);
  });

  it("连接器体检复用 Next 环境加载器，不维护第二套 dotenv 解析器", () => {
    const readiness = readFileSync(path.join(ROOT, "scripts/connector-readiness.ts"), "utf8");
    expect(readiness).toContain('import { loadJobEnvironment } from "../src/jobs/load-env"');
    expect(readiness).toContain("loadJobEnvironment()");
    expect(readiness).not.toContain("readFileSync");
    expect(readiness).not.toMatch(/\^\(\[A-Z0-9_\]\+\)=/);
  });
});
