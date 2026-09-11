import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const loader = createRequire(import.meta.url).resolve("tsx");
const script = path.resolve("scripts/clean-caches.ts");
const fixtures: string[] = [];
function fixture(inspect = "exit 1") {
  const root = mkdtempSync(path.join(tmpdir(), "scm-cache-contract-"));
  fixtures.push(root);
  writeFileSync(path.join(root, ".git"), "synthetic");
  writeFileSync(path.join(root, "package.json"), "{}");
  for (const name of [".cache", ".artifacts", "tmp", "uploads", ".data", "node_modules", "bin"]) {
    mkdirSync(path.join(root, name));
    writeFileSync(path.join(root, name, "keep"), name);
  }
  writeFileSync(path.join(root, "bin/lsof"), `#!/bin/sh\n${inspect}\n`, { mode: 0o700 });
  return root;
}
function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", loader, script, ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, PATH: path.join(root, "bin") },
  });
}
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true });
});
describe("recoverable cache cleanup", () => {
  it("previews without touching caches or verification receipts", () => {
    const root = fixture();
    expect(run(root, "--all").status).toBe(0);
    expect(readFileSync(path.join(root, ".cache/keep"), "utf8")).toBe(".cache");
    expect(existsSync(path.join(root, ".cache-cleanup-trash"))).toBe(false);
  });
  it("quarantines only the named cache and preserves data/evidence/dependencies", () => {
    const root = fixture();
    expect(run(root, "--apply", "--target", ".cache").status).toBe(0);
    expect(existsSync(path.join(root, ".cache"))).toBe(false);
    const [batch] = readdirSync(path.join(root, ".cache-cleanup-trash"));
    expect(readFileSync(path.join(root, ".cache-cleanup-trash", batch, ".cache/keep"), "utf8")).toBe(".cache");
    for (const name of [".artifacts", "tmp", "uploads", ".data", "node_modules"]) {
      expect(readFileSync(path.join(root, name, "keep"), "utf8")).toBe(name);
    }
  });
  it.each([["--apply"], ["--all", "--apply"], ["--apply", "--target", ".artifacts"], ["--target", "../outside"], ["--force"]].map((args) => ({ args })))("rejects unsafe arguments $args", ({ args }) => {
    const root = fixture();
    expect(run(root, ...args).status).not.toBe(0);
    expect(existsSync(path.join(root, ".cache/keep"))).toBe(true);
  });
  it.each(["echo p123; exit 0", "echo unavailable >&2; exit 1", "exit 2"])("refuses open or uninspectable cache: %s", (inspect) => {
    const root = fixture(inspect);
    expect(run(root, "--apply", "--target", ".cache").status).not.toBe(0);
    expect(existsSync(path.join(root, ".cache/keep"))).toBe(true);
  });
  it("refuses redirected targets and quarantine", () => {
    const root = fixture();
    symlinkSync("uploads", path.join(root, ".next"));
    expect(run(root, "--apply", "--target", ".next").status).not.toBe(0);
    symlinkSync("uploads", path.join(root, ".cache-cleanup-trash"));
    expect(run(root, "--apply", "--target", ".cache").status).not.toBe(0);
    expect(existsSync(path.join(root, "uploads/keep"))).toBe(true);
  });
});
