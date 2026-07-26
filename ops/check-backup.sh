#!/usr/bin/env bash
# 备份监控：只承认 manifest 已发布、DB/附件成对存在且校验和与压缩结构均有效的备份集。
# 退出码：0=健康；1=过期/损坏；2=无完整备份集。
set -euo pipefail
cd "$(dirname "$0")/.."

DEST=${BACKUP_DIR:-./backups}
MAX_AGE_HOURS=${MAX_AGE_HOURS:-25}
requested=${BACKUP_MANIFEST:-}
latest=${requested:-$(ls -1t "$DEST"/backup_*.sha256 2>/dev/null | head -n 1 || true)}

if [ -z "$latest" ]; then
  echo "CRITICAL: $DEST 下无任何完整 backup_*.sha256 备份集" >&2
  exit 2
fi

base=$(basename "$latest")
stamp=${base#backup_}
stamp=${stamp%.sha256}
if ! [[ "$stamp" =~ ^[0-9]{8}_[0-9]{6}$ ]]; then
  echo "CRITICAL: 非法备份集标识 $stamp" >&2
  exit 1
fi
db="db_$stamp.sql.gz"
uploads="uploads_$stamp.tar.gz"

line_count=$(wc -l < "$latest" | tr -d ' ')
if [ "$line_count" -ne 2 ] ||
   ! grep -Eq "^[0-9a-f]{64}  $db$" "$latest" ||
   ! grep -Eq "^[0-9a-f]{64}  $uploads$" "$latest"; then
  echo "CRITICAL: $latest 未同时登记 $db 与 $uploads" >&2
  exit 1
fi

if [ ! -s "$DEST/$db" ] || [ ! -s "$DEST/$uploads" ]; then
  echo "CRITICAL: 备份集 $stamp 缺 DB 或附件归档" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$DEST" && sha256sum -c "$base" >/dev/null)
else
  (cd "$DEST" && shasum -a 256 -c "$base" >/dev/null)
fi
gzip -t "$DEST/$db"
tar tzf "$DEST/$uploads" >/dev/null

now=$(date +%s)
mtime=$(stat -c %Y "$latest" 2>/dev/null || stat -f %m "$latest")
age_hours=$(( (now - mtime) / 3600 ))
if [ "$age_hours" -ge "$MAX_AGE_HOURS" ]; then
  echo "CRITICAL: 最新完整备份集 $stamp 已 ${age_hours}h 未更新（阈值 ${MAX_AGE_HOURS}h）" >&2
  exit 1
fi

echo "OK: 完整备份集 ${stamp}（${age_hours}h 前；DB+附件+SHA-256）"
