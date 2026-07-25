/**
 * 架构护栏：PGlite 单写者闸。
 *
 * 事故背景（2026-07-26）：PGlite 数据目录只允许一个写者。当天两个会话各自起过 dev server、
 * 还有脚本直连过同一目录，并发写把 WAL 的检查点记录写坏：
 *   `record with incorrect prev-link` → `invalid checkpoint record` → PANIC → 全应用 500。
 * 最后靠 pg_resetwal 回退到最后检查点才救回（业务数据侥幸无损）。
 * PGlite 自己不拦：它写的 postmaster.pid 里是合成 PID(-42)，无法据此判活。
 *
 * 本护栏钉住两条行为：
 *  1. 锁文件必须在数据目录**之外**——放进去会让全新空目录变成「非空且非 PG 目录」，
 *     PGlite 直接 abort。首版就是这么写的，被 redteam/master-bom-category 当场抓出。
 *  2. 活着的写者必须被拒绝；已死的写者留下的陈旧锁必须能被接管，否则崩一次就再也起不来。
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** 复刻 src/db/index.ts 的锁语义（该逻辑内联在 createDb 里，无法单独 import） */
function acquire(dir: string): { lockPath: string } {
  const lockPath = path.resolve(`${dir.replace(/\/+$/, "")}.writer.lock`);
  if (existsSync(lockPath)) {
    const prev = Number((readFileSync(lockPath, "utf8") || "").trim());
    let alive = false;
    if (Number.isInteger(prev) && prev > 0 && prev !== process.pid) {
      try {
        process.kill(prev, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) throw new Error(`PGlite 数据目录已被 PID ${prev} 占用：${dir}`);
  }
  writeFileSync(lockPath, String(process.pid), "utf8");
  return { lockPath };
}

describe("架构护栏：PGlite 单写者闸", () => {
  it("锁文件落在数据目录之外（放进去会让 PGlite 对空目录 abort）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scm-lock-"));
    const { lockPath } = acquire(dir);
    expect(lockPath.startsWith(dir + path.sep), "锁不得位于数据目录内部").toBe(false);
    expect(path.dirname(lockPath)).toBe(path.dirname(dir));
  });

  it("活着的写者被拒绝", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scm-lock-"));
    const lockPath = path.resolve(`${dir}.writer.lock`);
    writeFileSync(lockPath, String(process.pid + 0), "utf8"); // 本进程必然活着
    // 用一个确实活着、且不等于自己的 PID：父进程
    writeFileSync(lockPath, String(process.ppid), "utf8");
    expect(() => acquire(dir)).toThrow(/已被 PID .* 占用/);
  });

  it("陈旧锁（持有者已退出）可被接管——否则崩一次就再也起不来", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scm-lock-"));
    const lockPath = path.resolve(`${dir}.writer.lock`);
    writeFileSync(lockPath, "999999", "utf8"); // 几乎不可能存在的 PID
    expect(() => acquire(dir)).not.toThrow();
    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
  });
});
