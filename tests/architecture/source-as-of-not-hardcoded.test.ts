/**
 * 架构护栏：导入适配器不得把 `sourceAsOf` 写死成某个日期常量。
 *
 * 事故背景（2026-08-04）：inventory-long / expiry / sales-monthly / leadtime 四个适配器
 * 都写死了 `sourceAsOf: "2026-07-21"` 或 `"2026-06-30"`——那是最初一次性导入的那批文件的日期。
 * 但这些函数同时被 `/api/import/upload`（**业务自助上传**）调用，
 * 于是以后每次重传都会被盖上同一个过去的日期：9 月传的库存被记成 7 月的。
 *
 * 后果不只是显示不准：`month-close.ts` 正是按 `sourceAsOf` 做月份区间 `gte/lt` 过滤，
 * 数据会进错月份的结账证据，且没有任何报错。
 *
 * 现在改为参数：一次性回填脚本显式传历史日期；上传路径留 null，
 * 由 month-close 按既有约定回落 createdAt——宁可"没有声明源时点"，也不要"声明一个错的"。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ADAPTERS = path.resolve(__dirname, "../../src/server/import/adapters");

describe("架构护栏：sourceAsOf 不得写死", () => {
  it("适配器里没有 `sourceAsOf: \"YYYY-MM-DD\"` 这类硬编码时点", () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(ADAPTERS)) {
      if (!entry.endsWith(".ts")) continue;
      const src = readFileSync(path.join(ADAPTERS, entry), "utf8");
      for (const match of src.matchAll(/sourceAsOf:\s*(?:[^,\n]*\?\s*)?"(\d{4}-\d{2}-\d{2})"/g)) {
        offenders.push(`${entry} → sourceAsOf 写死为 ${match[1]}`);
      }
    }
    expect(
      offenders,
      `以下适配器把源时点写死了：\n${offenders.join("\n")}\n`
        + `这些函数会被业务自助上传调用，写死等于给每次重传盖上同一个过去的日期，\n`
        + `而 month-close 按 sourceAsOf 做月份过滤——数据会静默进错月份。\n`
        + `请改为参数，由调用方传入；无法确定时传 null，让 month-close 回落 createdAt。`,
    ).toEqual([]);
  });
});
