# 恢复演练（每季一次，RTO≤4h——01 §8）

生产备份以 `backup_<时间>.sha256` 为完成标志；清单必须同时登记同时间戳的 DB 与附件归档。
日常演练不接触在线库：

```bash
set -a; . ./.env.backup; set +a
npm run db:restore-drill:prod
```

脚本会校验配对、SHA-256 与压缩结构，把 DB 恢复进一次性 PostgreSQL 16 容器，核对当前迁移数、
关键表和用户，再解开附件到临时目录；退出时精确删除一次性容器/目录，并把 JSON 证据写入
`.artifacts/restore-drill/`。指定备份集时设置
`BACKUP_MANIFEST=/absolute/path/backup_YYYYMMDD_HHMMSS.sha256`。

真实灾难恢复仍须在新机器上完成：安装 Docker → clone 同一 release commit → 复制
`.env.prod` / `.env.backup` → 从异地目录取回同一 manifest 的三件套 → 运行上述演练 →
恢复正式卷 → `ops/deploy.sh` → 验证 health、登录、三张单据与流水。每一步记录耗时，RTO 必须 ≤4h。

## 备份调度与新鲜度监控
- 调度: `ops/deploy.sh` 的 install-backup-schedule 步骤自动安装 systemd 单元
  `scm-backup.timer` + `scm-backup.service`（每日 02:30 Asia/Shanghai，`Persistent=true`
  停机补跑；源文件 `ops/backup.timer` / `ops/backup.service`，`__REPO_DIR__` 安装时替换）。
  无 systemd 的主机按 `ops/crontab.example` 装 cron（二选一，勿双装）。
- 环境: 从 `.env.backup.example` 复制 `.env.backup`，配置 `BACKUP_DIR` / `BACKUP_REMOTE`
  以及实际 `.env.prod` 路径；
  `BACKUP_REMOTE` 必须配置出主机目的地（01 §8）。
- 完整性/新鲜度: `scm-backup-check.timer` 每小时运行 `ops/check-backup.sh`；DB/附件不成对、
  SHA-256 或压缩结构失败、最新完整集超 25h 均非零退出。
- 手动验证: `systemctl list-timers scm-backup.timer scm-backup-check.timer` 看下次触发；
  `systemctl start scm-backup.service` 即时试跑一轮备份。

## 演练日志
| 日期 | 执行人 | 耗时 | 结果 |
|---|---|---|---|
| 2026-07-26 | Codex / PostgreSQL 16 隔离容器 | 2s | ✅ 22 migrations · 5 required tables · 1 user · 1 attachment；一次性资源已清理 |
| 2026-07-24 | Claude / dev PGlite | 432ms | ✅ `scripts/restore-drill-dev.ts`；skus 5376 · ledger 348 · snapshots 1731 · transit 8305 · review 1769 全对 |

## dev/PGlite 安全流程

1. 先确认 `.data/dev` 的唯一写者并优雅停止；不要复制正在打开的数据目录。
2. `npm run db:backup`：同时核对外置 writer lock 与 `lsof`，任一写者存在即拒绝。
3. `npm run db:restore-drill`：只解开最近的已完成归档到临时目录，不读取 live `.data/dev`。
4. 指定归档时使用
   `DEV_BACKUP_FILE=/absolute/path/dev_YYYYMMDDHHMMSS.tgz npm run db:restore-drill`。
5. 真恢复使用 `npm run db:restore -- /absolute/path/archive.tgz`；原库保留为
   `.data/dev.pre-restore-<timestamp>`，验证成功前不得删除。
