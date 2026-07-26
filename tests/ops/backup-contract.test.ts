import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const workspaces: string[] = [];
const stamp = "20260726_120000";

function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "scm-backup-contract-"));
  workspaces.push(dir);
  return dir;
}

function runCheck(dir: string): ReturnType<typeof spawnSync> {
  return spawnSync(path.join(root, "ops/check-backup.sh"), [], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BACKUP_DIR: dir, MAX_AGE_HOURS: "1000000" },
  });
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function validSet(dir: string): { db: string; uploads: string; manifest: string } {
  const dbName = `db_${stamp}.sql.gz`;
  const uploadsName = `uploads_${stamp}.tar.gz`;
  const manifestName = `backup_${stamp}.sha256`;
  const db = path.join(dir, dbName);
  const uploads = path.join(dir, uploadsName);
  const manifest = path.join(dir, manifestName);
  writeFileSync(db, gzipSync("create table users(id int);\n"));
  const uploadRoot = path.join(dir, "upload-source");
  mkdirSync(uploadRoot);
  writeFileSync(path.join(uploadRoot, "proof.txt"), "attachment evidence\n");
  execFileSync("tar", ["czf", uploads, "-C", uploadRoot, "."]);
  writeFileSync(
    manifest,
    `${sha256(db)}  ${dbName}\n${sha256(uploads)}  ${uploadsName}\n`,
  );
  return { db, uploads, manifest };
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("production backup-set monitor", () => {
  it("rejects a directory without a published manifest", () => {
    const result = runCheck(workspace());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("无任何完整");
  });

  it("rejects a manifest that does not pair DB and attachments", () => {
    const dir = workspace();
    const dbName = `db_${stamp}.sql.gz`;
    const db = path.join(dir, dbName);
    writeFileSync(db, gzipSync("partial"));
    writeFileSync(path.join(dir, `backup_${stamp}.sha256`), `${sha256(db)}  ${dbName}\n`);
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("未同时登记");
  });

  it("rejects corruption after the manifest is published", () => {
    const dir = workspace();
    const set = validSet(dir);
    writeFileSync(set.db, gzipSync("tampered"));
    const result = runCheck(dir);
    expect(result.status).toBe(1);
  });

  it("accepts a fresh, checksummed, structurally valid pair", () => {
    const dir = workspace();
    validSet(dir);
    const result = runCheck(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DB+附件+SHA-256");
  });
});
