import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const ledger = readFileSync(path.join(root, "docs/spec/15-194项能力审计台账.md"), "utf8");
const current = readFileSync(path.join(root, "docs/spec/CURRENT.md"), "utf8");
const capabilityRows = (text: string) => [
  ...text.matchAll(/^\| C(\d{3}) \| ([^|]+) \| (✅|◐|☐|⛔) \| ([^|]+) \|$/gm),
];

/** Only explicit inline-code file citations, not routes, symbols or narrative evidence.
 * A reachable file is a navigation check, never proof that a capability works or is deployed.
 */
function evidenceIssues(text: string): string[] {
  return capabilityRows(text).flatMap((row) => [...row[4].matchAll(/`([^`]+)`/g)].flatMap((match) => {
    const ref = match[1];
    if (!/\.(?:[cm]?[jt]sx?|sql|md|json|ya?ml|sh)(?:$|[#?:])/.test(ref)) return [];
    const label = `C${row[1]}: ${ref}`;
    if (!/^(?:src|tests|drizzle|docs|scripts|ops|public)\//.test(ref)
      || path.posix.normalize(ref) !== ref || ref.split("/").includes("..")
      || /[*?#:\\]/.test(ref)) {
      return [`${label} 必须写精确的仓库相对文件路径，不用简称、通配符或行号`];
    }
    try {
      return statSync(path.join(root, ref)).isFile() ? [] : [`${label} 不是文件`];
    } catch {
      return [`${label} 文件不存在`];
    }
  }));
}

function summaryIssues(text: string, index: string): string[] {
  const rows = capabilityRows(text);
  const counts = ["✅", "◐", "☐", "⛔"].map((status) => rows.filter((row) => row[3] === status).length);
  const expectedTitle = `# ${rows.length} 项能力审计台账（当前完成 ${counts[0]} 项）`;
  const expectedSummary = `当前 ${counts[0]} 项完成、${counts[1]} 项部分、${counts[2]} 项待做、${counts[3]} 项受外部依赖阻塞`;
  const indexEntry = index.match(/\| \*\*15-194项能力审计台账\.md\*\* \| ([^|]+) \|/)?.[1] ?? "";
  const statusBlocks = index.split(/\n\s*\n/).filter((block) => /^- \*\*\d+ 项能力证据[（(]/.test(block));
  const summaryMatches = statusBlocks.length === 1
    && statusBlocks[0].startsWith(`- **${rows.length} 项能力证据`)
    && statusBlocks[0].includes(expectedSummary);
  return [
    ...(text.split("\n")[0] === expectedTitle ? [] : ["台账标题与行状态数量不一致"]),
    ...(indexEntry.includes(`当前 ${rows.length} 项去重执行证据`) ? [] : ["CURRENT索引总量与台账不一致"]),
    ...(summaryMatches ? [] : ["CURRENT状态汇总与台账不一致"]),
  ];
}

describe("202 项能力审计台账", () => {
  const rows = capabilityRows(ledger);

  it("每个显式文件证据可精确定位（不把存在性当成业务完成证明）", () => {
    expect(evidenceIssues(ledger)).toEqual([]);
  });

  it("标题和CURRENT状态汇总与真实行数一致，不仅检查完成数下限", () => {
    expect(summaryIssues(ledger, current)).toEqual([]);
  });

  it.each(["tests/core/decimal.test.ts", "src/server/posting/reversal.ts", "src/server/rules/backtest-fva.ts"])(
    "重新植入历史失效文件 %s 时门必须变红", (ref) => {
      expect(evidenceIssues(`| C001 | 合成证据 | ✅ | \`${ref}\` |`)).toEqual([`C001: ${ref} 文件不存在`]);
    },
  );

  it.each(["decimal.ts", "core/decimal.ts", "tests/rules/*.test.ts", "../src/server/core/decimal.ts",
    "src/../src/server/core/decimal.ts", "src/server/core/decimal.ts#L1"])(
    "拒绝无法精确导航的文件引用 %s", (ref) => {
      expect(evidenceIssues(`| C001 | 合成证据 | ◐ | \`${ref}\` |`)[0]).toContain("必须写精确");
    },
  );

  it("同一行所有文件都检查，但不误把路由、数据库字段和函数名当文件", () => {
    expect(evidenceIssues("| C001 | 合成证据 | ✅ | `/api/health`、`users.session_version`、`getFreshSessionUser`、`src/server/core/decimal.ts` |"))
      .toEqual([]);
    expect(evidenceIssues("| C001 | 合成证据 | ⛔ | `src/server/core/decimal.ts`、`tests/missing-ledger-evidence.test.ts` |"))
      .toEqual(["C001: tests/missing-ledger-evidence.test.ts 文件不存在"]);
  });

  it("把部分改为完成却不更新汇总时门必须变红（行数与原193下限仍通过）", () => {
    const mutated = ledger.replace(/(\| C057 \| [^|]+ \| )◐/, "$1✅");
    expect(mutated).not.toBe(ledger);
    expect(summaryIssues(mutated, current)).toEqual(["台账标题与行状态数量不一致", "CURRENT状态汇总与台账不一致"]);
  });

  it("单独篡改入口总量或完成/部分/待做/阻塞任一汇总均会变红", () => {
    expect(summaryIssues(ledger, current.replace("当前 202 项去重执行证据", "当前 999 项去重执行证据")))
      .toEqual(["CURRENT索引总量与台账不一致"]);
    for (const phrase of ["193 项完成", "4 项部分", "0 项待做", "5 项受外部依赖阻塞"]) {
      expect(summaryIssues(ledger, current.replace(phrase, phrase.replace(/^\d+/, "999"))))
        .toEqual(["CURRENT状态汇总与台账不一致"]);
    }
  });

  it("历史正确数字不能掩盖当前段落错误，也不能同时存在两个当前汇总", () => {
    const summary = current.split(/\n\s*\n/).find((block) => /^- \*\*202 项能力证据/.test(block))!;
    expect(summary).toBeTruthy();
    const staleHistory = current.replace("193 项完成", "999 项完成")
      + "\n\n## 历史快照\n当前 193 项完成、4 项部分、0 项待做、5 项受外部依赖阻塞\n";
    expect(summaryIssues(ledger, staleHistory)).toEqual(["CURRENT状态汇总与台账不一致"]);
    expect(summaryIssues(ledger, `${current}\n\n${summary}`)).toEqual(["CURRENT状态汇总与台账不一致"]);
    expect(summaryIssues(ledger, current.replace("202 项能力证据", "999 项能力证据")))
      .toEqual(["CURRENT状态汇总与台账不一致"]);
  });

  it("恰好包含 C001–C202，连续且无重复", () => {
    expect(rows).toHaveLength(202);
    expect(rows.map((match) => match[1])).toEqual(
      Array.from({ length: 202 }, (_, index) => String(index + 1).padStart(3, "0")),
    );
  });

  it("每行都有独立能力名称与证据/出口，不以空占位冒充完成", () => {
    const names = rows.map((match) => match[2].trim());
    expect(new Set(names).size).toBe(202);
    for (const row of rows) {
      expect(row[2].trim().length).toBeGreaterThanOrEqual(4);
      expect(row[4].trim().length).toBeGreaterThanOrEqual(4);
    }
  });

  it("台账明确规定只有 ✅ 计入完成，防止 partial 被虚报", () => {
    expect(ledger).toContain("只有 ✅ 才计入已执行数");
    expect(ledger).toContain("◐ 不得算完成");
    expect(rows.filter((row) => row[3] === "✅").length).toBeGreaterThanOrEqual(193);
  });
});
