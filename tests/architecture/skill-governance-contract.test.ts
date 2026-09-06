import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const skillRoot = path.join(root, ".claude/skills");
const agentSkillRoot = path.join(root, ".agents/skills");
const historyRoot = path.join(root, "docs/skill-history");
const yaml = createRequire(import.meta.url)("js-yaml") as {
  load(source: string): unknown;
};

const CANONICAL_SKILLS = [
  "design-supply-chain-flows",
  "integrate-supply-chain-data",
  "measure-first",
  "parallel-sessions",
  "release-sweep",
  "supply-chain",
  "write-path",
] as const;

const REMOVED_SKILLS = [
  "alert-budget",
  "caliber-change",
  "decision-log",
  "govern-cosmetics-quality",
  "list-page",
  "plan-beauty-supply",
  "reconcile-supply-chain-truth",
  "redteam-pass",
  "schema-change",
] as const;

function read(file: string): string {
  return readFileSync(file, "utf8");
}

function record(value: unknown, label: string): Record<string, unknown> {
  expect(value, `${label} must be a YAML mapping`).not.toBeNull();
  expect(Array.isArray(value), `${label} must not be a YAML sequence`).toBe(false);
  expect(typeof value, `${label} must be a YAML mapping`).toBe("object");
  return value as Record<string, unknown>;
}

function frontmatter(file: string): { attributes: Record<string, unknown>; body: string } {
  const source = read(file);
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  expect(match, `${path.relative(root, file)} must start with closed YAML frontmatter`).not.toBeNull();
  const attributes = record(yaml.load(match![1]), `${path.relative(root, file)} frontmatter`);
  return { attributes, body: source.slice(match![0].length) };
}

function walkMarkdown(directory: string, output: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walkMarkdown(target, output);
    else if (entry.isFile() && entry.name.endsWith(".md")) output.push(target);
  }
  return output;
}

function walkActiveText(directory: string, output: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walkActiveText(target, output);
    else if (
      entry.isFile() &&
      /\.(?:md|tsx?|sh|json|toml)$/.test(entry.name) &&
      target !== path.resolve(import.meta.dirname, "skill-governance-contract.test.ts")
    ) {
      output.push(target);
    }
  }
  return output;
}

function markdownTargets(source: string): string[] {
  const targets: string[] = [];
  const link = /!?\[[^\]]*]\((<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g;
  for (const match of source.matchAll(link)) {
    targets.push(match[1].replace(/^<|>$/g, ""));
  }
  return targets;
}

/**
 * Active instructions must describe preservation/recovery in prose, not prescribe these
 * copy-pastable working-tree mutations. This is a documentation guard, not a shell sandbox.
 * Quarantined historical examples are intentionally outside its executable-guidance scope.
 */
function unsafeGitRecoveryCommands(source: string): string[] {
  const command = /\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree)\s+(?:"[^"]*"|'[^']*'|[^\s`]+)\s+)*(?:reset|checkout|restore|clean|stash)\b/g;
  return [...source.matchAll(command)].map((match) => match[0]);
}

const activeMarkdown = walkMarkdown(skillRoot);
const historyMarkdown = walkMarkdown(historyRoot);
const governedMarkdown = [...activeMarkdown, ...historyMarkdown];
const activeGovernance = [
  path.join(root, "CLAUDE.md"),
  path.join(root, "README.md"),
  ...activeMarkdown,
  ...walkActiveText(path.join(root, "src")),
  ...walkActiveText(path.join(root, "scripts")),
  ...walkActiveText(path.join(root, "tests")),
];

describe("skill package governance", () => {
  it("keeps AGENTS.md linked to the single canonical operating contract", () => {
    const agents = path.join(root, "AGENTS.md");
    const canonical = path.join(root, "CLAUDE.md");
    expect(lstatSync(agents).isSymbolicLink()).toBe(true);
    expect(realpathSync(agents)).toBe(realpathSync(canonical));
  });

  it.each([
    "基线缺失则 `git reset --hard <当前 HEAD>`。",
    "lock 多删的先 `git checkout` 再手改根块。",
    "git -C 'temporary worktree' reset HEAD --hard",
    "git\nreset --hard HEAD",
    "git restore --source=HEAD -- package-lock.json",
    "git clean -fd",
    "git stash push -u",
  ])("rejects unsafe recovery instruction: %s", (source) => {
    expect(unsafeGitRecoveryCommands(source).length).toBeGreaterThan(0);
  });

  it.each([
    "先核对 `git status --short` 和 `git diff package-lock.json`，保留并行工作后逐差异修复。",
    "git worktree add --detach <全新临时路径> <已核对commit>",
    "禁止原地重置、整文件还原或清理未知文件；差异归属不明时停止并协调。",
  ])("allows preservation-oriented guidance: %s", (source) => {
    expect(unsafeGitRecoveryCommands(source)).toEqual([]);
  });

  it("keeps active operating and skill guidance free of destructive Git recovery recipes", () => {
    const offenders = [path.join(root, "CLAUDE.md"), ...activeMarkdown].flatMap((file) =>
      unsafeGitRecoveryCommands(read(file)).map((command) => `${path.relative(root, file)} -> ${command}`),
    );
    expect(offenders, `unsafe active recovery guidance:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("has exactly seven canonical, well-formed skill packages", () => {
    const directories = readdirSync(skillRoot)
      .filter((name) => statSync(path.join(skillRoot, name)).isDirectory())
      .sort();
    expect(directories).toEqual([...CANONICAL_SKILLS]);

    for (const name of CANONICAL_SKILLS) {
      const file = path.join(skillRoot, name, "SKILL.md");
      const { attributes } = frontmatter(file);
      expect(Object.keys(attributes).sort(), `${name} frontmatter keys`).toEqual([
        "description",
        "name",
      ]);
      expect(attributes.name).toBe(name);
      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(typeof attributes.description).toBe("string");
      expect((attributes.description as string).trim().length).toBeGreaterThan(40);
      expect((attributes.description as string).length).toBeLessThanOrEqual(1024);
    }
  });

  it("parses every OpenAI interface and keeps invocation metadata exact", () => {
    for (const name of CANONICAL_SKILLS) {
      const file = path.join(skillRoot, name, "agents/openai.yaml");
      const source = read(file);
      const document = record(yaml.load(source), `${name} openai.yaml`);
      expect(Object.keys(document)).toEqual(["interface"]);
      const interfaceConfig = record(document.interface, `${name} interface`);
      expect(Object.keys(interfaceConfig).sort()).toEqual([
        "default_prompt",
        "display_name",
        "short_description",
      ]);

      for (const key of ["display_name", "short_description", "default_prompt"] as const) {
        expect(typeof interfaceConfig[key], `${name} ${key}`).toBe("string");
        expect((interfaceConfig[key] as string).trim(), `${name} ${key}`).toBe(
          interfaceConfig[key],
        );
      }
      const shortDescription = interfaceConfig.short_description as string;
      expect(shortDescription.length).toBeGreaterThanOrEqual(25);
      expect(shortDescription.length).toBeLessThanOrEqual(64);
      expect(interfaceConfig.default_prompt).toContain(`$${name}`);
      expect(source).toMatch(
        /^\s+default_prompt:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*$/m,
      );
    }
  });

  it("exposes each canonical package through an exact, resolving symlink", () => {
    const links = readdirSync(agentSkillRoot).sort();
    expect(links).toEqual([...CANONICAL_SKILLS]);

    for (const name of CANONICAL_SKILLS) {
      const link = path.join(agentSkillRoot, name);
      const canonical = path.join(skillRoot, name);
      expect(lstatSync(link).isSymbolicLink(), `${name} must be a symlink`).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(canonical));
      expect(existsSync(path.join(link, "SKILL.md"))).toBe(true);
    }
  });

  it("keeps every local Markdown link inside the repository and resolvable", () => {
    const broken: string[] = [];
    for (const file of governedMarkdown) {
      for (const rawTarget of markdownTargets(read(file))) {
        if (
          rawTarget.startsWith("#") ||
          /^(?:https?:|mailto:|tel:|data:)/i.test(rawTarget)
        ) {
          continue;
        }
        const withoutAnchor = rawTarget.split("#", 1)[0].split("?", 1)[0];
        if (!withoutAnchor) continue;
        let decoded: string;
        try {
          decoded = decodeURIComponent(withoutAnchor);
        } catch {
          broken.push(`${path.relative(root, file)} -> invalid URL encoding: ${rawTarget}`);
          continue;
        }
        const resolved = decoded.startsWith("/")
          ? path.join(root, decoded.slice(1))
          : path.resolve(path.dirname(file), decoded);
        const relative = path.relative(root, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(resolved)) {
          broken.push(`${path.relative(root, file)} -> ${rawTarget}`);
        }
      }
    }
    expect(broken, `broken or escaping Markdown links:\n${broken.join("\n")}`).toEqual([]);
  });

  it("quarantines history and rejects stale routing or authority paths", () => {
    expect(existsSync(path.join(historyRoot, "README.md"))).toBe(true);
    for (const file of historyMarkdown) {
      if (path.basename(file) !== "README.md") {
        expect(read(file), path.relative(root, file)).toContain("ARCHIVE ONLY");
      }
    }

    const stale: string[] = [];
    for (const file of governedMarkdown) {
      const source = read(file);
      if (source.includes("../spec")) {
        stale.push(`${path.relative(root, file)} -> ../spec`);
      }
      for (const name of REMOVED_SKILLS) {
        if (source.includes(`$${name}`)) {
          stale.push(`${path.relative(root, file)} -> $${name}`);
        }
      }
    }
    expect(stale, `stale skill or authority routing:\n${stale.join("\n")}`).toEqual([]);

    const activeResidue: string[] = [];
    for (const file of activeGovernance) {
      const source = read(file);
      if (/\bdoc_counter\b/.test(source)) {
        activeResidue.push(`${path.relative(root, file)} -> singular doc_counter`);
      }
      for (const name of REMOVED_SKILLS) {
        if (
          source.includes(`$${name}`) ||
          source.includes(`/${name}`) ||
          source.includes(`skill \`${name}\``)
        ) {
          activeResidue.push(`${path.relative(root, file)} -> retired ${name} route`);
        }
      }
    }
    expect(
      activeResidue,
      `stale active governance residue:\n${activeResidue.join("\n")}`,
    ).toEqual([]);

    for (const name of CANONICAL_SKILLS) {
      const { body } = frontmatter(path.join(skillRoot, name, "SKILL.md"));
      expect(body, `${name} must use runtime-neutral routing`).not.toMatch(
        /\$(?:design-supply-chain-flows|integrate-supply-chain-data|measure-first|parallel-sessions|release-sweep|supply-chain|write-path)\b/,
      );
      if (name !== "supply-chain") expect(body).not.toContain("docs/skill-history/");
    }
    expect(frontmatter(path.join(skillRoot, "supply-chain/SKILL.md")).body).toContain(
      "quarantined,",
    );

    const orchestrator = frontmatter(path.join(skillRoot, "supply-chain/SKILL.md")).body;
    expect(orchestrator).toContain("exactly one primary skill");
    expect(orchestrator).toContain("minimum safety constraint");

    const release = frontmatter(path.join(skillRoot, "release-sweep/SKILL.md")).body;
    expect(release).toContain("`READY` only when every required");
    expect(release).not.toContain("READY WITH EXPLICIT ACCEPTANCE");
  });

  it("keeps executable guidance free of the retired literal credential", () => {
    const retiredCredential = ["admin", "123"].join("");
    const offenders = governedMarkdown
      .filter((file) => read(file).includes(retiredCredential))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });

  it("routes truth audits and scans the current implementation shape", () => {
    const integration = read(
      path.join(skillRoot, "integrate-supply-chain-data/SKILL.md"),
    );
    expect(integration).toContain("[single-claim.md](../supply-chain/reference/single-claim.md)");
    expect(integration).toContain("[reachability.md](../supply-chain/reference/reachability.md)");
    expect(integration).toContain("[file-release.md](references/file-release.md)");

    const reachability = read(path.join(skillRoot, "supply-chain/reference/reachability.md"));
    expect(reachability).toContain(
      '/usr/bin/grep -rq --include="*.ts" --include="*.tsx" --exclude-dir=api -- "$u" src',
    );

    const fileRelease = read(
      path.join(skillRoot, "integrate-supply-chain-data/references/file-release.md"),
    );
    expect(fileRelease).toContain("src/server/modules/release/engine");
    expect(fileRelease).not.toContain("src/server/modules/release/engine.ts");
  });
});
