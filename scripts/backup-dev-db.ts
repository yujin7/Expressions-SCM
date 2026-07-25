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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DEV_DATA_DIR ?? ".data/dev";
const DEST_DIR = process.env.DEV_BACKUP_DIR ?? "backups/dev";
const KEEP = Number(process.env.DEV_BACKUP_KEEP ?? 10);

function assertNoWriter(): void {
  const lock = path.join(DATA_DIR, ".writer.lock");
  if (!existsSync(lock)) return;
  const pid = Number((readFileSync(lock, "utf8") || "").trim());
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 0);
  } catch {
    return; // 陈旧锁，持有者已退出
  }
  throw new Error(
    `开发库正被 PID ${pid} 占用，备份会拿到不一致的快照。请先停掉它（kill ${pid}）再重试。`,
  );
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
  if (!existsSync(file)) throw new Error(`备份文件不存在：${file}`);
  // 解到临时目录再原子替换，避免解一半把现库毁了
  const tmp = `${DATA_DIR}.restoring`;
  execFileSync("rm", ["-rf", tmp]);
  mkdirSync(tmp, { recursive: true });
  execFileSync("tar", ["xzf", file, "-C", tmp], { stdio: "inherit" });
  const inner = path.join(tmp, path.basename(DATA_DIR));
  if (!existsSync(inner)) throw new Error("备份包结构异常：找不到数据目录");
  execFileSync("rm", ["-rf", `${DATA_DIR}.old`]);
  if (existsSync(DATA_DIR)) execFileSync("mv", [DATA_DIR, `${DATA_DIR}.old`]);
  execFileSync("mv", [inner, DATA_DIR]);
  execFileSync("rm", ["-rf", tmp]);
  console.log(`✓ 已恢复：${file} → ${DATA_DIR}（原库保留在 ${DATA_DIR}.old，确认无误后自行删除）`);
}

const args = process.argv.slice(2);
const i = args.indexOf("--restore");
if (i >= 0) restore(args[i + 1] ?? "");
else backup();
