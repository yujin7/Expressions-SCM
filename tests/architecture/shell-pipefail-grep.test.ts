/**
 * `set -o pipefail` 的脚本里禁止写 `... | grep -q`（真实事故护栏）。
 *
 * 机制：`grep -q` 一旦命中就立即退出，上游进程随即被 SIGPIPE 杀掉（退出码 141）。
 * 开了 pipefail 时，管道的退出码取**最后一个非零**，于是 141 成了整条管道的结果——
 * **命中反而被判成失败**。它只在上游输出量大到写不进管道缓冲区时才发作，
 * 因此本地小数据下常常"看起来没问题"，换个环境就翻车。
 *
 * 事故经过：`scripts/show-access-link.sh` 用 `launchctl list | grep -q "$LABEL"`
 * 判断守护是否在跑。守护明明活着（launchctl 里有、cloudflared 进程也在、状态文件也写了），
 * 却一直报「公网入口守护未在运行」。实测该管道退出码 141。
 * 同样的写法当时还潜伏在 `ops/deploy.sh` 的健康检查里——那条一旦发作，
 * **健康的部署会被判成失败**。
 *
 * 正确写法二选一：
 *   1. 先取值再用 `case "$out" in *pat*)` 匹配；
 *   2. 用 `grep -c ... >/dev/null`（-c 会读完全部输入，不产生 SIGPIPE）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function shellScripts(): string[] {
  const out: string[] = [];
  for (const dir of ["scripts", "ops"]) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith(".sh")) out.push(join(dir, name));
    }
  }
  return out.sort();
}

/** 该行是否是「管道喂给 grep -q」的形态（读文件的 `grep -q pat file` 不算，没有管道） */
function hasPipedQuietGrep(line: string): boolean {
  const code = line.replace(/#.*$/, "");
  if (!/\|\s*[^|]*\bgrep\b/.test(code)) return false;
  // 取管道最后一段里的 grep 参数：-q / -qx / -qE 等短选项组合，或长选项
  return /\|\s*(?:\/usr\/bin\/)?grep\s+(?:-[A-Za-z]*q[A-Za-z]*|--quiet|--silent)\b/.test(code);
}

describe("shell 脚本：pipefail 下禁止 `| grep -q`", () => {
  const scripts = shellScripts();

  it("能找到待检脚本（否则本护栏形同虚设）", () => {
    expect(scripts.length).toBeGreaterThan(5);
  });

  it("开了 pipefail 的脚本里没有管道喂 grep -q 的写法", () => {
    const offenders: string[] = [];
    for (const file of scripts) {
      const src = readFileSync(file, "utf8");
      if (!/^\s*set\s+-[a-z]*o\s+pipefail|^\s*set\s+-o\s+pipefail/m.test(src)) continue;
      src.split("\n").forEach((line, i) => {
        if (hasPipedQuietGrep(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(
      offenders,
      "这些行在 pipefail 下会因 SIGPIPE 把「命中」判成「失败」（退出码 141）。\n"
        + "改成先取值再 `case \"$out\" in *pat*)`，或用 `grep -c ... >/dev/null`。\n"
        + offenders.join("\n"),
    ).toEqual([]);
  });
});
