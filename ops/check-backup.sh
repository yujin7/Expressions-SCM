#!/usr/bin/env bash
# 备份新鲜度检查（外部监控/cron 用）：最新 db_*.sql.gz 超过 MAX_AGE_HOURS（默认 25h，
# 给每日 02:30 的调度留 1h 余量）即非零退出——接告警通道（cron 邮件/监控探针）。
# 退出码：0=新鲜；1=过期；2=无任何备份文件。
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=${BACKUP_DIR:-./backups}
MAX_AGE_HOURS=${MAX_AGE_HOURS:-25}

latest=$(ls -1t "$DEST"/db_*.sql.gz 2>/dev/null | head -n 1 || true)
if [ -z "$latest" ]; then
  echo "CRITICAL: $DEST 下无任何 db_*.sql.gz 备份文件" >&2
  exit 2
fi

now=$(date +%s)
# GNU stat（Linux）与 BSD stat（macOS）取 mtime 的旗标不同
mtime=$(stat -c %Y "$latest" 2>/dev/null || stat -f %m "$latest")
age_hours=$(( (now - mtime) / 3600 ))

if [ "$age_hours" -ge "$MAX_AGE_HOURS" ]; then
  echo "CRITICAL: 最新备份 $latest 已 ${age_hours}h 未更新（阈值 ${MAX_AGE_HOURS}h）——检查 backup.timer/cron 与磁盘" >&2
  exit 1
fi
echo "OK: 最新备份 $latest（${age_hours}h 前）"
