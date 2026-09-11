import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBuildIdentity } from "../../scripts/build-identity";
import { matchesBuildRevision, parseBuildIdentity } from "@/lib/build-identity";

const roots: string[] = [];
const revision = "a".repeat(40);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function directory() {
  const root = mkdtempSync(path.join(tmpdir(), "scm-build-identity-"));
  roots.push(root);
  return root;
}
function repository() {
  const root = directory();
  git(root, "init", "-q");
  writeFileSync(path.join(root, "source.txt"), "synthetic tracked source\n");
  git(root, "add", "source.txt");
  git(root, "-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "fixture");
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("build-time identity from the actual source", () => {
  it("reads a clean repository's full revision", () => {
    const root = repository();
    expect(readBuildIdentity(root)).toEqual({ revision: git(root, "rev-parse", "HEAD"), source: "git-clean" });
  });
  it.each(["tracked", "untracked"])("does not claim clean revision for %s edits", (kind) => {
    const root = repository();
    writeFileSync(path.join(root, kind === "tracked" ? "source.txt" : "extra.ts"), "changed\n");
    const b = readBuildIdentity(root);
    expect(b.source).toBe("git-dirty");
    expect(matchesBuildRevision(b, b.revision)).toBe(false);
  });
  it("a declared revision cannot override the actual Git checkout", () => {
    expect(() => readBuildIdentity(repository(), revision)).toThrow("不一致");
  });
  it("a source export without Git remains unknown unless a build argument is supplied", () => {
    const root = directory();
    expect(readBuildIdentity(root)).toEqual({ revision: null, source: "unknown" });
    expect(readBuildIdentity(root, revision)).toEqual({ revision, source: "build-arg" });
  });
  it.each(["main", "a6683a7", "A".repeat(40), "private/token/value"])("rejects malformed declaration without echoing it: %s", (value) => {
    expect(() => readBuildIdentity(directory(), value)).toThrow("完整40位");
  });
  it("does not borrow a containing repository's revision", () => {
    const parent = repository();
    const child = path.join(parent, "export");
    mkdirSync(child);
    expect(() => readBuildIdentity(child, revision)).toThrow("父目录");
  });
  it("unreadable Git metadata cannot be replaced by a declared clean revision", () => {
    const root = directory();
    writeFileSync(path.join(root, ".git"), "gitdir: /nonexistent-synthetic-git\n");
    expect(() => readBuildIdentity(root, revision)).toThrow("不可读取");
  });
  it("normalizes absent/unknown public identity without exposing arbitrary fields", () => {
    expect(parseBuildIdentity({ revision: "bad", source: "git-clean", secret: "private" })).toEqual({ revision: null, source: "unknown" });
    expect(parseBuildIdentity({ revision, source: "build-arg", secret: "private" })).toEqual({ revision, source: "build-arg" });
  });
});
