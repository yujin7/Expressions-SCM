/**
 * B9 放行门：`sales_velocity` 是**休眠废弃表**，不得被任何业务代码读写。
 *
 * 背景与裁决（2026-09-04）：该表零读取方、零写入方，日均销速唯一权威是 `core/velocity.ts`。
 * 未删表的理由写在 `src/db/schema/dimensions.ts` 的定义注释里（生产实例在跑、无生产行数取证、
 * 备份仅同主机、仓库既有裁决要求「待 D 号」）。既然留着表，就必须有一道门保证它不会被悄悄接线——
 * 否则「休眠废弃」会在下一次有人搜到这张表时变成事实上的第二套销速口径。
 *
 * 允许出现的引用只有三处：schema 定义本身、约束回归测试、本门。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

/** 允许引用该表/该 Drizzle 实体的文件（相对仓库根，POSIX 路径） */
const ALLOWED = new Set([
  "src/db/schema/dimensions.ts",              // 定义 + 废弃说明
  "tests/dimensions/resolver.test.ts",        // UNIQUE NULLS NOT DISTINCT 约束回归
  "tests/release/dead-table-sales-velocity.test.ts", // 本门
]);

function walk(relative: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(root, relative))) {
    const child = path.posix.join(relative, entry);
    if (statSync(path.join(root, child)).isDirectory()) walk(child, out);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry)) out.push(child);
  }
  return out;
}

describe("sales_velocity 休眠废弃表", () => {
  const files = ["src", "tests", "scripts"].flatMap((dir) => walk(dir));

  it("schema 定义带 DEPRECATED 标注与不得读写的明确指示", () => {
    const schema = readFileSync(path.join(root, "src/db/schema/dimensions.ts"), "utf8");
    expect(schema).toContain("DEPRECATED");
    expect(schema).toContain("任何新代码都不得读写本表");
    expect(schema).toContain("core/velocity.ts");
  });

  it("除 schema 定义、约束回归与本门外，没有任何代码引用 sales_velocity / salesVelocity", () => {
    const offenders = files.filter((relative) => {
      if (ALLOWED.has(relative)) return false;
      const body = readFileSync(path.join(root, relative), "utf8");
      return /\bsales_velocity\b/.test(body) || /\bsalesVelocity\b/.test(body);
    });
    expect(
      offenders,
      `sales_velocity 是休眠废弃表：销速唯一权威是 core/velocity.ts。若确需物化，先出 D 号并更新本门白名单。\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("白名单本身不腐化：登记的文件必须真的还引用该表", () => {
    for (const relative of ALLOWED) {
      if (relative.endsWith("dead-table-sales-velocity.test.ts")) continue;
      const body = readFileSync(path.join(root, relative), "utf8");
      expect(/\bsales_velocity\b|\bsalesVelocity\b/.test(body), `${relative} 已不再引用，应从白名单移除`).toBe(true);
    }
  });
});
