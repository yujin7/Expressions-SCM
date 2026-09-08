import { describe, expect, it } from "vitest";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const ledgerPath = path.join(root, "docs/spec/16-500项系统执行审计台账.md");
const ledger = readFileSync(ledgerPath, "utf8");

type Category =
  | "API_ROUTE"
  | "AUTH_PAGE"
  | "MIGRATION"
  | "ARCH_GATE"
  | "REDTEAM_GATE"
  | "RELEASE_GATE"
  | "PROJECT_SKILL"
  | "LINT_EXCEPTION"
  | "DATA_SOURCE"
  | "CRITICAL_INVARIANT";

interface Control {
  id: string;
  category: Category;
  subject: string;
  evidence: string;
}

const controls: Control[] = [
  ...ledger.matchAll(
    /^\| (A\d{3}) \| ([A-Z_]+) \| `([^`]+)` \| `([^`]+)` \| ✅ \|$/gm,
  ),
].map((match) => ({
  id: match[1],
  category: match[2] as Category,
  subject: match[3],
  evidence: match[4],
}));

const expectedCounts: Record<Category, number> = {
  API_ROUTE: 282,
  AUTH_PAGE: 97,
  MIGRATION: 62,
  ARCH_GATE: 80,
  REDTEAM_GATE: 12,
  RELEASE_GATE: 15,
  PROJECT_SKILL: 7,
  LINT_EXCEPTION: 93,
  DATA_SOURCE: 20,
  CRITICAL_INVARIANT: 36,
};

function walkFiles(relative: string, matcher: string | RegExp): string[] {
  const absolute = path.join(root, relative);
  return readdirSync(absolute)
    .flatMap((entry) => {
      const childRelative = path.posix.join(relative, entry);
      const childAbsolute = path.join(root, childRelative);
      return statSync(childAbsolute).isDirectory()
        ? walkFiles(childRelative, matcher)
        : (typeof matcher === "string" ? entry.endsWith(matcher) : matcher.test(entry))
          ? [childRelative]
          : [];
    })
    .sort();
}

function source(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

function discoverLintExceptions(): string[] {
  return ["scripts", "src", "tests"]
    .flatMap((relative) => walkFiles(relative, /\.(?:[cm]?[jt]sx?)$/))
    .sort()
    .flatMap((relative) => {
      let ordinal = 0;
      return source(relative)
        .split("\n")
        .flatMap((line) => {
          if (!/^(?:\s*\/\/|\s*\/\*)\s*eslint-disable/.test(line)) return [];
          ordinal += 1;
          return [`${relative}#eslint-${ordinal}`];
        });
    })
    .sort();
}

function assertTestModule(relative: string): void {
  expect(existsSync(path.join(root, relative)), `${relative} 不存在`).toBe(true);
  expect(source(relative), `${relative} 没有可执行测试定义`).toMatch(
    /\b(?:describe|it|test)(?:\.each)?\s*\(/,
  );
}

function verify(control: Control): void {
  if (control.category === "API_ROUTE") {
    expect(existsSync(path.join(root, control.subject))).toBe(true);
    const body = source(control.subject);
    const namedHandler =
      /export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\b/.test(body);
    const authAlias =
      control.subject === "src/app/api/auth/[...nextauth]/route.ts"
      && /export\s+const\s*\{\s*GET,\s*POST\s*\}\s*=\s*handlers/.test(body);
    expect(namedHandler || authAlias, `${control.subject} 未导出 HTTP handler`).toBe(true);
    expect(body, `${control.subject} 裸调 req.json 会把坏 JSON 误报为 500`).not.toMatch(
      /await\s+req\.json\(\)/,
    );
    expect(body, `${control.subject} 把审计放在业务事务之外`).not.toContain("auditFromRoute");
    const ownsErrorBoundary =
      body.includes("errorResponse")
      || control.subject === "src/app/api/auth/[...nextauth]/route.ts"
      || control.subject === "src/app/api/health/route.ts";
    expect(ownsErrorBoundary, `${control.subject} 缺少统一或专用错误边界`).toBe(true);
    return;
  }

  if (control.category === "AUTH_PAGE") {
    expect(existsSync(path.join(root, control.subject))).toBe(true);
    expect(source(control.subject), `${control.subject} 缺少默认页面导出`).toMatch(
      /export\s+default\s+/,
    );
    return;
  }

  if (control.category === "MIGRATION") {
    expect(existsSync(path.join(root, control.subject))).toBe(true);
    const journal = JSON.parse(source("drizzle/meta/_journal.json")) as {
      entries: { tag: string }[];
    };
    const tag = path.basename(control.subject, ".sql");
    expect(journal.entries.some((entry) => entry.tag === tag), `${tag} 未登记 journal`).toBe(true);
    return;
  }

  if (
    control.category === "ARCH_GATE"
    || control.category === "REDTEAM_GATE"
    || control.category === "RELEASE_GATE"
  ) {
    assertTestModule(control.subject);
    return;
  }

  if (control.category === "PROJECT_SKILL") {
    const canonical = path.join(root, control.subject);
    expect(existsSync(canonical)).toBe(true);
    expect(source(control.subject)).toContain("---");
    const name = path.basename(path.dirname(control.subject));
    const exposed = path.join(root, ".agents/skills", name);
    expect(lstatSync(exposed).isSymbolicLink(), `${name} 未通过 .agents 暴露`).toBe(true);
    expect(realpathSync(exposed)).toBe(realpathSync(path.dirname(canonical)));
    return;
  }

  if (control.category === "LINT_EXCEPTION") {
    const match = control.subject.match(/^(.*)#eslint-(\d+)$/);
    expect(match, `${control.subject} 不是稳定的 file#eslint-N 标识`).not.toBeNull();
    const [, relative, rawOrdinal] = match!;
    const directives = source(relative)
      .split("\n")
      .filter((line) => /^(?:\s*\/\/|\s*\/\*)\s*eslint-disable/.test(line));
    const directive = directives[Number(rawOrdinal) - 1] ?? "";
    expect(directive, `${control.subject} 对应的规则抑制已不存在`).toMatch(/eslint-disable/);
    expect(directive, `${control.subject} 缺少 -- 理由`).toMatch(/\s--\s+\S/);
    return;
  }

  if (control.category === "DATA_SOURCE") {
    const lineage = source("docs/data/DATA-LINEAGE-AUDIT-2026-07-27.md");
    expect(lineage, `${control.subject} 未进入逐源血缘表`).toContain(`\`${control.subject}\``);
    return;
  }

  const [label, testPath] = control.evidence.split("；");
  expect(label?.trim().length, `${control.id} 缺少不变量名称`).toBeGreaterThan(3);
  expect(existsSync(path.join(root, control.subject)), `${control.subject} 不存在`).toBe(true);
  assertTestModule(testPath);
}

describe("704 项系统执行审计台账", () => {
  it("ID 恰好 A001–A704、对象唯一、分类数量固定", () => {
    expect(controls).toHaveLength(704);
    expect(controls.map((control) => control.id)).toEqual(
      Array.from({ length: 704 }, (_, index) => `A${String(index + 1).padStart(3, "0")}`),
    );
    expect(new Set(controls.map((control) => `${control.category}:${control.subject}`)).size).toBe(704);
    // Keep the same component's control ID when retiring its hook suppression;
    // do not restore a lint exception or substitute an unrelated object to fill the slot.
    expect(controls.find((control) => control.id === "A373")).toEqual({
      id: "A373",
      category: "CRITICAL_INVARIANT",
      subject: "src/components/RemoteSelect.tsx",
      evidence: "有界搜索、精确回显与已选值主动移除；tests/components/remote-select.test.ts",
    });
    expect(controls.find((control) => control.id === "A643")).toEqual({
      id: "A643",
      category: "CRITICAL_INVARIANT",
      subject: "src/app/(app)/master/supply-params/supply-params-client.tsx",
      evidence: "草稿原值、保存回执与跨刷新恢复；tests/components/supply-param-drafts.test.ts",
    });
    for (const [category, count] of Object.entries(expectedCounts)) {
      expect(
        controls.filter((control) => control.category === category).length,
        `${category} 数量漂移`,
      ).toBe(count);
    }
  });

  it("路由、页面、迁移、测试门与项目技能与当前目录完全一致", () => {
    const subjects = (category: Category) => controls
      .filter((control) => control.category === category)
      .map((control) => control.subject)
      .sort();
    expect(subjects("API_ROUTE")).toEqual(walkFiles("src/app/api", "route.ts"));
    expect(subjects("AUTH_PAGE")).toEqual(walkFiles("src/app/(app)", "page.tsx"));
    expect(subjects("MIGRATION")).toEqual(
      readdirSync(path.join(root, "drizzle"))
        .filter((entry) => /^\d{4}_.+\.sql$/.test(entry))
        .map((entry) => `drizzle/${entry}`)
        .sort(),
    );
    expect(subjects("ARCH_GATE")).toEqual(walkFiles("tests/architecture", ".test.ts"));
    expect(subjects("REDTEAM_GATE")).toEqual(walkFiles("tests/redteam", ".test.ts"));
    expect(subjects("RELEASE_GATE")).toEqual(walkFiles("tests/release", ".test.ts"));
    expect(subjects("PROJECT_SKILL")).toEqual(walkFiles(".claude/skills", "SKILL.md"));
  });

  /**
   * 台账正文（标题 / 范围段 / 分类汇总表）此前不受任何断言约束：合并两次冲突后逐次漂移，
   * 到 2026-09-04 已变成「标题 582、API_ROUTE 单元格 260、合计 653、各行相加 650」四者互相矛盾。
   * 行级数据一直是对的，因为行被钉住了；正文错了，因为没被钉住。这里把正文也钉上。
   */
  /**
   * 索引也会漂：`docs/spec/CURRENT.md` 是 SSOT 的入口页，它引用本台账的条数。
   * 2026-09-05 实测——台账真实 696 条，CURRENT.md 里写着 580，差了 116 条。
   * 台账正文自己已经被上面那条门钉住，但**引用它的索引没有门**，于是同一种漂移
   * 换了一层继续发生：读者从入口页拿到的是一个三周前的数字。
   */
  it("CURRENT.md 引用的台账条数必须与真实行数一致（索引漂移＝入口页说谎）", () => {
    const current = readFileSync(path.resolve(__dirname, "../../docs/spec/CURRENT.md"), "utf8");
    const total = controls.length;
    const cited = [...current.matchAll(/16-500项系统执行审计台账[^|\n]*\|[^|\n]*?(\d{3,4})\s*个可定位/g)]
      .map((m) => Number(m[1]));
    expect(cited.length, "CURRENT.md 的文档角色表里必须仍然引用本台账的条数").toBeGreaterThan(0);
    for (const n of cited) {
      expect(n, `CURRENT.md 写着 ${n} 条，台账实际 ${total} 条`).toBe(total);
    }
  });

  it("台账正文的标题、范围段与分类汇总表必须与行数据一致（正文漂移是历史真实事故）", () => {
    const doc = readFileSync(ledgerPath, "utf8");
    const total = controls.length;
    const countOf = (category: Category) => controls.filter((c) => c.category === category).length;

    expect(doc, "标题条数").toMatch(new RegExp(`^# ${total} 项系统执行审计台账`, "m"));
    expect(doc, "范围段条数").toContain(`**${total} 个互不重复`);
    expect(doc, "合计单元格").toMatch(new RegExp(`^> \\| \\*\\*合计\\*\\* \\| \\*\\*${total}\\*\\* \\|`, "m"));

    for (const category of Object.keys(expectedCounts) as Category[]) {
      expect(doc, `${category} 汇总单元格`).toMatch(new RegExp(`^> \\| ${category} \\| ${countOf(category)} \\|`, "m"));
    }

    // 汇总表各行之和必须等于合计，否则表格自相矛盾
    const cells = [...doc.matchAll(/^> \| ([A-Z_]+) \| (\d+) \|/gm)].map((m) => Number(m[2]));
    expect(cells.reduce((a, b) => a + b, 0), "汇总各行之和 = 合计").toBe(total);

    // 范围段里逐个分类的数字也必须对（曾长期停留在 218 路由 / 81 页面 / 47 迁移）
    const scope = doc.match(/> 范围由 [\s\S]*?组成。/)?.[0] ?? "";
    for (const [category, label] of [["API_ROUTE", "个 API 路由"], ["AUTH_PAGE", "个认证页面"], ["MIGRATION", "个迁移"],
      ["ARCH_GATE", "个架构门"], ["REDTEAM_GATE", "个红队门"], ["RELEASE_GATE", "个放行门"],
      ["PROJECT_SKILL", "个项目技能"], ["LINT_EXCEPTION", "个代码规则例外"]] as [Category, string][]) {
      expect(scope, `范围段 ${category}`).toContain(`${countOf(category)} ${label}`);
    }
  });

  it("规则抑制与当前代码逐项一致，新增或删除都不得漏审", () => {
    const subjects = controls
      .filter((control) => control.category === "LINT_EXCEPTION")
      .map((control) => control.subject)
      .sort();
    expect(subjects).toEqual(discoverLintExceptions());
  });

  it.each(controls)("$id $category $subject", (control) => {
    verify(control);
  });
});
