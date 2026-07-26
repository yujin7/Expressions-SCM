import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const sourceGuard = path.resolve(".claude/hooks/guard.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; guard: string } {
  const root = mkdtempSync(path.join(tmpdir(), "scm-agent-hook-"));
  roots.push(root);
  const hooks = path.join(root, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  const guard = path.join(hooks, "guard.sh");
  copyFileSync(sourceGuard, guard);
  execFileSync("/usr/bin/git", ["init", "-q"], { cwd: root });
  writeFileSync(path.join(root, "untracked.txt"), "risk\n");
  return { root, guard };
}

function invoke(guard: string, mode: "git" | "schema", toolInput: unknown): string {
  const result = spawnSync("/bin/bash", [guard, mode], {
    input: JSON.stringify({ tool_input: toolInput }),
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("shared Claude/Codex advisory guard", () => {
  it.each([
    { command: "git add -A" },
    { command: "/usr/bin/git -C . commit -m test" },
    { command: "env FOO=bar git stash push" },
    { command: "command git --no-pager commit -m test" },
    { command: "bash -lc 'git add -A'" },
    { command: "sudo -u nobody git add -A" },
    { cmd: "git -c advice.detachedHead=false add ." },
  ])("warns for mutation variant %#", (toolInput) => {
    const output = JSON.parse(invoke(fixture().guard, "git", toolInput)) as {
      systemMessage: string;
    };
    expect(output.systemMessage).toContain("advisory / parallel-sessions");
  });

  it.each([
    { command: "git status --short" },
    { command: "echo 'git add -A'" },
    { cmd: "printf '%s' 'git commit'" },
  ])("stays silent for non-mutating command %#", (toolInput) => {
    expect(invoke(fixture().guard, "git", toolInput)).toBe("");
  });

  it("parses command text without executing it", () => {
    const fx = fixture();
    const marker = path.join(fx.root, "must-not-exist");
    const output = invoke(fx.guard, "git", {
      cmd: `echo $(/usr/bin/touch ${marker}); git add -A`,
    });
    expect(JSON.parse(output)).toHaveProperty("systemMessage");
    expect(existsSync(marker)).toBe(false);
  });

  it("recognizes schema paths in Codex apply_patch input", () => {
    const output = JSON.parse(
      invoke(fixture().guard, "schema", {
        patch: "*** Begin Patch\n*** Update File: src/db/schema/users.ts\n@@\n*** End Patch\n",
      }),
    ) as { systemMessage: string };
    expect(output.systemMessage).toContain("advisory / schema-change");
    expect(output.systemMessage).toContain("src/db/schema/users.ts");
  });

  it("keeps Codex hook matchers aligned with current tool names", () => {
    const config = readFileSync(path.resolve(".codex/config.toml"), "utf8");
    expect(config).toContain('matcher = "^Bash$"');
    expect(config).toContain('matcher = "^(apply_patch|Edit|Write)$"');
    expect(config).toContain(".claude/hooks/guard.sh");
  });
});
