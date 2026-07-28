import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const srcRoot = path.join(root, "src");
const styles = readFileSync(path.join(srcRoot, "app/globals.css"), "utf8");

interface SourceFile {
  path: string;
  source: string;
}

interface CssRule {
  selectors: string[];
  declarations: string;
}

interface LayoutContract {
  marker: string;
  rootSelector: string;
  shrinkSelector: string;
}

function collectTsxFiles(directory: string): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectTsxFiles(absolute);
      if (!entry.isFile() || !entry.name.endsWith(".tsx")) return [];
      return [{
        path: path.relative(root, absolute),
        source: readFileSync(absolute, "utf8"),
      }];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function parseLeafRules(css: string): CssRule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({
      selectors: match[1].split(",").map((selector) => selector.trim()),
      declarations: match[2],
    }))
    .filter((rule) => rule.selectors.every((selector) => !selector.startsWith("@")));
}

function extractContainerBlocks(css: string): string[] {
  const blocks: string[] = [];
  const header = /@container\s+app-surface\s*\([^)]*max-width\s*:[^)]+\)\s*\{/g;

  for (const match of css.matchAll(header)) {
    const openBrace = match.index + match[0].lastIndexOf("{");
    let depth = 1;
    let cursor = openBrace + 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === "{") depth += 1;
      if (css[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    if (depth === 0) blocks.push(css.slice(openBrace + 1, cursor - 1));
  }

  return blocks;
}

function rulesFor(css: string, selector: string): CssRule[] {
  return parseLeafRules(css).filter((rule) => rule.selectors.includes(selector));
}

function declarationsFor(css: string, selector: string): string {
  return rulesFor(css, selector).map((rule) => rule.declarations).join("\n");
}

const tsxFiles = collectTsxFiles(srcRoot);
const listToolbarConsumers = tsxFiles.filter(({ source }) => /<ListToolbar(?:\s|\/|>)/.test(source));

const layoutContracts: LayoutContract[] = [
  {
    marker: "compact-kpi-row",
    rootSelector: ".compact-kpi-row",
    shrinkSelector: ".compact-kpi-row > .ant-col",
  },
  {
    marker: "compact-stat-strip",
    rootSelector: ".compact-stat-strip.ant-space",
    shrinkSelector: ".compact-stat-strip > .ant-space-item",
  },
  {
    marker: "dashboard-kpi-grid",
    rootSelector: ".dashboard-kpi-grid",
    shrinkSelector: ".dashboard-kpi-grid__item",
  },
  {
    marker: "process-mining-kpis",
    rootSelector: ".process-mining-kpis",
    shrinkSelector: ".process-mining-kpis .ant-card",
  },
  {
    marker: "plan-version-kpis",
    rootSelector: ".plan-version-kpis",
    shrinkSelector: ".plan-version-kpis .ant-card",
  },
  {
    marker: "supplier-scorecard-kpis",
    rootSelector: ".supplier-scorecard-kpis",
    shrinkSelector: ".supplier-scorecard-kpis .ant-card",
  },
];

const layoutInventory = layoutContracts.map((contract) => ({
  ...contract,
  consumers: tsxFiles.filter(({ source }) => source.includes(contract.marker)),
}));

describe("shared layout consumer contract", () => {
  it("discovers every ListToolbar consumer and keeps its list table in a horizontal viewport", () => {
    expect(listToolbarConsumers.length).toBeGreaterThan(0);

    const wrongImports = listToolbarConsumers
      .filter(({ source }) => !/import\s+ListToolbar\s+from\s+["']@\/components\/ListToolbar["']/.test(source))
      .map(({ path: file }) => file);
    const uncontainedTables = listToolbarConsumers
      .filter(({ source }) => /<Table(?:<[^>]+>)?(?:\s|\/|>)/.test(source))
      .filter(({ source }) => !/\bscroll\s*=\s*\{\{\s*x\s*:/.test(source))
      .map(({ path: file }) => file);

    expect(wrongImports, `ListToolbar must come from the shared component:\n${wrongImports.join("\n")}`).toEqual([]);
    expect(
      uncontainedTables,
      `ListToolbar pages with tables must provide an AntD x-scroll viewport:\n${uncontainedTables.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the shared toolbar and table viewport bounded by the app surface", () => {
    expect(declarationsFor(styles, ".app-workspace")).toMatch(/min-width:\s*0\s*;/);
    expect(declarationsFor(styles, ".app-content")).toMatch(/min-width:\s*0\s*;/);
    expect(declarationsFor(styles, ".app-surface")).toMatch(/overflow:\s*hidden\s*;/);
    expect(declarationsFor(styles, ".app-surface .ant-table-wrapper")).toMatch(
      /overflow:\s*hidden\s*;/,
    );

    const toolbar = declarationsFor(styles, ".list-toolbar");
    expect(toolbar).toMatch(/flex-wrap:\s*wrap\s*;/);
    expect(toolbar).toMatch(/max-width:\s*100%\s*;/);
    const filters = declarationsFor(styles, ".list-toolbar__filters");
    expect(filters).toMatch(/display:\s*flex\s*;/);
    expect(filters).toMatch(/flex-wrap:\s*wrap\s*;/);
    expect(filters).toMatch(/min-width:\s*0\s*;/);
    expect(declarationsFor(styles, ".list-toolbar__right")).toMatch(/min-width:\s*0\s*;/);
    expect(declarationsFor(styles, ".list-toolbar__actions")).toMatch(/flex-wrap:\s*wrap\s*;/);
    expect(declarationsFor(styles, ".list-toolbar__primary-actions")).toMatch(
      /max-width:\s*100%\s*;/,
    );
    expect(declarationsFor(styles, ".list-toolbar__filters > .ant-space")).toMatch(
      /flex-wrap:\s*wrap\s*;/,
    );
    expect(declarationsFor(styles, ".list-toolbar__filters > .ant-space")).toMatch(
      /max-width:\s*100%\s*;/,
    );
  });

  it.each(layoutInventory)(
    "covers every $marker consumer with a shrink-safe responsive grid",
    ({ marker, rootSelector, shrinkSelector, consumers }) => {
      expect(consumers.length, `No TSX consumer discovered for ${marker}`).toBeGreaterThan(0);

      const rootDeclarations = declarationsFor(styles, rootSelector);
      expect(rootDeclarations, `${rootSelector} must use the shared grid`).toMatch(
        /display:\s*grid(?:\s*!important)?\s*;/,
      );
      expect(rootDeclarations, `${rootSelector} must use shrink-safe tracks`).toMatch(
        /grid-template-columns:[^;]*minmax\(/,
      );
      expect(declarationsFor(styles, shrinkSelector), `${shrinkSelector} must be shrinkable`).toMatch(
        /min-width:\s*0\s*;/,
      );

      const hasContainerOverride = extractContainerBlocks(styles).some((block) =>
        rulesFor(block, rootSelector).some((rule) =>
          /grid-template-columns\s*:/.test(rule.declarations),
        ),
      );
      expect(
        hasContainerOverride,
        `${rootSelector} must respond to the actual app-surface width`,
      ).toBe(true);
    },
  );
});
