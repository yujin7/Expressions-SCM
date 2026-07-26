import { closeSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = path.resolve("scripts/backup-dev-db.ts");

function runBackup(dataDir: string) {
  return spawnSync(process.execPath, ["--import", "tsx", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEV_DATA_DIR: dataDir,
      DEV_BACKUP_DIR: path.join(path.dirname(dataDir), "backups"),
    },
    encoding: "utf8",
  });
}

describe("PGlite 开发库备份安全", () => {
  it("识别应用实际使用的数据目录外置 writer lock", () => {
    const root = mkdtempSync(path.join(tmpdir(), "scm-backup-lock-"));
    const dataDir = path.join(root, "dev");
    writeFileSync(`${dataDir}.writer.lock`, String(process.pid));

    const result = runBackup(dataDir);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(`PID ${process.pid}`);
  });

  it("旧进程没有 lock 时仍通过 lsof 拒绝打开中的数据文件", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "scm-backup-open-"));
    const file = path.join(dataDir, "open.dat");
    writeFileSync(file, "x");
    const fd = openSync(file, "r");
    try {
      const result = runBackup(dataDir);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("仍有进程打开文件");
    } finally {
      closeSync(fd);
    }
  });
});
