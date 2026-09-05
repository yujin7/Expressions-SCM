/**
 * 架构护栏：`stock_ledger` / `stock_balances` 只能由过账层写。
 *
 * 为什么这条最该有门：CLAUDE.md 里「库存只能经 `posting/registry.ts` 过账，禁止直接写
 * stock_balances/stock_ledger」是全仓风险最高的一条纪律——库存流水是仅追加事实表，
 * 多一个写入方就意味着账实可以在系统内部自相矛盾，而且**事后无法还原谁写错了**。
 * 但截至 2026-09-05，这条纪律**只写在文档里，没有任何测试钉住**。
 *
 * 本仓已经反复演示过「有权威、没门禁」会怎样：
 *  - 业务日收口后又长回 39 份本地实现（`business-day-single-authority`）；
 *  - 分域参数的键级权限表只在 category 一层生效，另外三层是敞的（安全审计 S3）；
 *  - 告警写入收口到 upsertAlerts 后**补了门**，至今没长回来——差别就在那道门。
 *
 * 纪律：写这两张表的语句只允许出现在 `src/server/posting/` 下。
 * 需要新的库存动作，就去 `posting/registry.ts` 注册一种来源，而不是另开一条写路径。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const POSTING_DIR = join("src", "server", "posting");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

/** 对这两张表的写语句（insert/update/delete），排除注释行 */
const WRITE_RE = /\.(insert|update|delete)\(\s*(?:schema\.)?(stockLedger|stockBalances)\s*\)/;

describe("库存过账唯一写入方", () => {
  it("stock_ledger / stock_balances 的写语句只允许出现在 src/server/posting/ 下", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      if (file.startsWith(POSTING_DIR)) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
        if (WRITE_RE.test(code)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(
      offenders,
      "库存流水是仅追加事实表，第二个写入方＝账实可以自相矛盾且事后查不出谁写的。"
        + `\n新的库存动作请在 posting/registry.ts 注册来源：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("过账层自己确实是那个写入方（别把门修成「谁都不写」也算通过）", () => {
    const postingSrc = walk(POSTING_DIR).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(postingSrc, "posting/ 下必须真的写 stock_ledger").toMatch(/\.insert\(\s*(?:schema\.)?stockLedger\s*\)/);
    expect(postingSrc, "posting/ 下必须真的写 stock_balances").toMatch(/\.insert\(\s*(?:schema\.)?stockBalances\s*\)/);
  });

  it("来源必须在 registry 注册——未注册来源过账要被拒（口径与 post.ts 一致）", () => {
    const registry = readFileSync(join(POSTING_DIR, "registry.ts"), "utf8");
    expect(registry).toMatch(/export/);
    const post = readFileSync(join(POSTING_DIR, "post.ts"), "utf8");
    expect(post, "未注册来源必须报 UNREGISTERED_SOURCE").toContain("UNREGISTERED_SOURCE");
  });
});
