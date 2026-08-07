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
  API_ROUTE: 214,
  AUTH_PAGE: 81,
  MIGRATION: 42,
  ARCH_GATE: 54,
  REDTEAM_GATE: 11,
  RELEASE_GATE: 13,
  PROJECT_SKILL: 7,
  LINT_EXCEPTION: 90,
  DATA_SOURCE: 20,
  CRITICAL_INVARIANT: 32,
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

describe("564 项系统执行审计台账", () => {
  it("ID 恰好 A001–A564、对象唯一、分类数量固定", () => {
    expect(controls).toHaveLength(564);
    expect(controls.map((control) => control.id)).toEqual(
      Array.from({ length: 564 }, (_, index) => `A${String(index + 1).padStart(3, "0")}`),
    );
    expect(new Set(controls.map((control) => `${control.category}:${control.subject}`)).size).toBe(564);
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
