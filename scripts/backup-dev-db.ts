/**
 * 开发库备份 / 恢复。
 *
 * 为什么需要它（2026-07-26 事故）：`ops/backup.sh` 只备 docker-compose 的**生产**库
 * （`docker compose exec db pg_dump`），开发库 `.data/dev` **从来没有任何备份路径**。
 * 当天两个进程并发写坏了 WAL，全应用 500，只能靠 pg_resetwal 回退到最后检查点才救回来——
 * 业务数据侥幸无损，但那是运气，不是设计。5,376 SKU / 725 生效 BOM / 946 别名认领 /
 * 1,771 条待复核裁决，重建一次要重做 500+ 歧义代决。
 *
 * 做法：PGlite 的数据目录就是一个完整的 PG 数据目录，**停机时整目录打包**即为一致快照
 * （控制文件状态为 shut down 时，文件级拷贝是合法备份）。不依赖 pg_dump——
 * PGlite 是 WASM 编译（无 USE_FLOAT8_BYVAL），原生 pg_dump/postgres 打不开它的目录，
 * 这一点已实测确认。
 *
 * 用法：
 *   npx tsx scripts/backup-dev-db.ts            # 备份到 backups/dev/
 *   npx tsx scripts/backup-dev-db.ts --restore <file.tgz>
 *
 * 纪律：**必须先停 dev server**（脚本会检查写者锁，占用时直接拒绝）。
 *
 * 已做过恢复演练（2026-07-26）：解包 → pg_controldata 可读 → PGlite 打开查得 skus=5376。
 * 注意若上次是被强杀（非优雅停止），控制文件状态会是 `in production`，
 * PGlite 打开时会自行做崩溃恢复——演练中成功，但**优雅停止后再备份**更稳。
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

const DATA_DIR = safeDirectory(process.env.DEV_DATA_DIR ?? ".data/dev", "DEV_DATA_DIR");
const DEST_DIR = safeDirectory(process.env.DEV_BACKUP_DIR ?? "backups/dev", "DEV_BACKUP_DIR");
const KEEP = Number(process.env.DEV_BACKUP_KEEP ?? 10);

function safeDirectory(raw: string, label: string): string {
  const resolved = path.resolve(raw);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`${label} 不得指向文件系统根目录：${resolved}`);
  }
  return resolved;
}

function assertNoWriter(): void {
  // 必须与 src/db/index.ts 一致：锁在数据目录外侧，而不是 DATA_DIR/.writer.lock。
  const lock = path.resolve(`${DATA_DIR.replace(/\/+$/, "")}.writer.lock`);
  if (existsSync(lock)) {
    const pid = Number((readFileSync(lock, "utf8") || "").trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        throw new Error(
          `开发库正被 PID ${pid} 占用，备份会拿到不一致的快照。请先优雅停止该进程再重试。`,
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes("开发库正被 PID")) throw error;
        // 陈旧锁：继续做 lsof 二次核验，不能只信锁文件。
      }
    }
  }

  // 兼容在单写者闸上线前启动的旧进程：它们没有外置锁，但仍可能打开数据文件。
  try {
    const openFiles = execFileSync("lsof", ["+D", DATA_DIR], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (openFiles) {
      throw new Error(
        `开发库仍有进程打开文件，拒绝备份/恢复：\n${openFiles.split("\n").slice(0, 5).join("\n")}`,
      );
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { status?: number }).code;
    const status = (error as { status?: number }).status;
    const stdout = String((error as { stdout?: string | Buffer }).stdout ?? "").trim();
    // macOS 的 lsof 在受限环境中可能“有匹配输出但退出 1”；必须先看证据，不能先信退出码。
    if (stdout) {
      throw new Error(
        `开发库仍有进程打开文件，拒绝备份/恢复：\n${stdout.split("\n").slice(0, 5).join("\n")}`,
      );
    }
    if (status === 1) return; // 无输出的 exit 1 才表示没有匹配文件
    if (error instanceof Error && error.message.includes("开发库仍有进程打开文件")) throw error;
    if (code === "ENOENT") {
      throw new Error("缺少 lsof，无法证明 PGlite 数据目录没有写者；为安全起见拒绝操作。");
    }
    throw error;
  }
}

function backup(): void {
  assertNoWriter();
  if (!existsSync(DATA_DIR)) throw new Error(`数据目录不存在：${DATA_DIR}`);
  mkdirSync(DEST_DIR, { recursive: true });
  // 时间戳由调用时刻决定；脚本内不依赖固定时钟
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const out = path.join(DEST_DIR, `dev_${stamp}.tgz`);
  execFileSync("tar", ["czf", out, "-C", path.dirname(DATA_DIR), path.basename(DATA_DIR)], {
    stdio: "inherit",
  });
  const size = (statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(`✓ 备份完成：${out}（${size} MB）`);

  // 滚动保留：只留最近 KEEP 份
  const olds = readdirSync(DEST_DIR)
    .filter((f) => /^dev_\d{14}\.tgz$/.test(f))
    .sort()
    .reverse()
    .slice(KEEP);
  for (const f of olds) {
    unlinkSync(path.join(DEST_DIR, f));
    console.log(`  清理旧备份：${f}`);
  }
}

function restore(file: string): void {
  assertNoWriter();
  const archive = path.resolve(file);
  if (!existsSync(archive)) throw new Error(`备份文件不存在：${archive}`);

  const expectedRoot = `${path.basename(DATA_DIR)}/`;
  const entries = execFileSync("tar", ["tzf", archive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  if (
    entries.length === 0 ||
    entries.some((entry) => entry.startsWith("/") || entry.includes("../") || !entry.startsWith(expectedRoot))
  ) {
    throw new Error(`备份包结构异常：所有条目必须位于 ${expectedRoot} 下，且不得路径穿越`);
  }

  // 在目标同级目录解包，校验完成后 rename；原库保留为带时间戳的可恢复副本。
  const parent = path.dirname(DATA_DIR);
  mkdirSync(parent, { recursive: true });
  const tmp = mkdtempSync(path.join(parent, `.${path.basename(DATA_DIR)}.restore-`));
  execFileSync("tar", ["xzf", archive, "-C", tmp], { stdio: "inherit" });
  const inner = path.join(tmp, path.basename(DATA_DIR));
  if (!existsSync(inner)) throw new Error("备份包结构异常：找不到数据目录");
  const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const prior = `${DATA_DIR}.pre-restore-${stamp}`;
  if (existsSync(DATA_DIR)) renameSync(DATA_DIR, prior);
  renameSync(inner, DATA_DIR);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`✓ 已恢复：${archive} → ${DATA_DIR}`);
  if (existsSync(prior)) console.log(`  原库保留：${prior}`);
}

const args = process.argv.slice(2);
const i = args.indexOf("--restore");
if (i >= 0) restore(args[i + 1] ?? "");
else backup();
