#!/usr/bin/env bash
# 每日备份（01 §8：DB+附件卷，出主机；crontab: 0 2 * * * /path/ops/backup.sh）
set -euo pipefail
cd "$(dirname "$0")/.."
STAMP=$(date +%Y%m%d_%H%M%S)
DEST=${BACKUP_DIR:-./backups}
REMOTE=${BACKUP_REMOTE:-} # 例: user@nas:/backups/scm —— 必须配置出主机目的地
mkdir -p "$DEST"
echo "==> pg_dump"
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U scm scm | gzip > "$DEST/db_$STAMP.sql.gz"
echo "==> 附件卷"
docker run --rm -v supply-chain_uploads:/data -v "$(cd "$DEST" && pwd)":/backup alpine \
  tar czf "/backup/uploads_$STAMP.tar.gz" -C /data .
echo "==> 保留 14 天"
find "$DEST" -name '*.gz' -mtime +14 -delete
if [ -n "$REMOTE" ]; then
  echo "==> rsync 出主机"
  rsync -az "$DEST/" "$REMOTE/"
else
  echo "警告: BACKUP_REMOTE 未配置——备份仍在本机（违反 01 §8 出主机要求）" >&2
fi
echo "备份完成: db_$STAMP.sql.gz + uploads_$STAMP.tar.gz"
