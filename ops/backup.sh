#!/usr/bin/env bash
# 生产备份：PostgreSQL + 附件卷组成一个带 SHA-256 清单的原子备份集。
# 默认强制出主机；仅隔离演练可显式 REQUIRE_BACKUP_REMOTE=0。
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

STAMP=$(date +%Y%m%d_%H%M%S)
DEST=${BACKUP_DIR:-./backups}
REMOTE=${BACKUP_REMOTE:-}
REQUIRE_REMOTE=${REQUIRE_BACKUP_REMOTE:-1}
COMPOSE_FILE=${SCM_COMPOSE_FILE:-docker-compose.prod.yml}
ENV_FILE=${SCM_ENV_FILE:-.env.prod}

if [ "$REQUIRE_REMOTE" != "0" ] && [ -z "$REMOTE" ]; then
  echo "CRITICAL: BACKUP_REMOTE 未配置；拒绝生成仅留本机的伪安全备份" >&2
  exit 3
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "CRITICAL: 找不到 Compose 环境文件 $ENV_FILE（默认 .env.prod）" >&2
  exit 3
fi
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

mkdir -p "$DEST"
DEST_ABS=$(cd "$DEST" && pwd)
DB_NAME="db_$STAMP.sql.gz"
UPLOADS_NAME="uploads_$STAMP.tar.gz"
MANIFEST_NAME="backup_$STAMP.sha256"
DB_TMP="$DEST_ABS/.$DB_NAME.tmp"
UPLOADS_TMP="$DEST_ABS/.$UPLOADS_NAME.tmp"
MANIFEST_TMP="$DEST_ABS/.$MANIFEST_NAME.tmp"

cleanup() {
  rm -f "$DB_TMP" "$UPLOADS_TMP" "$MANIFEST_TMP"
}
trap cleanup EXIT

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

echo "==> PostgreSQL 一致性导出"
"${COMPOSE[@]}" exec -T db pg_dump -U scm scm | gzip > "$DB_TMP"

echo "==> 附件卷导出（经 compose 逻辑卷，不猜 Docker 实际卷名）"
"${COMPOSE[@]}" --profile ops run --pull never --rm --no-deps -T backup-files \
  -c 'tar czf - -C /data/uploads .' > "$UPLOADS_TMP"

test -s "$DB_TMP"
test -s "$UPLOADS_TMP"
gzip -t "$DB_TMP"
tar tzf "$UPLOADS_TMP" >/dev/null

{
  printf '%s  %s\n' "$(sha256_of "$DB_TMP")" "$DB_NAME"
  printf '%s  %s\n' "$(sha256_of "$UPLOADS_TMP")" "$UPLOADS_NAME"
} > "$MANIFEST_TMP"

# 先完整复制数据，最后才发布 manifest；监控只承认有 manifest 的成套备份。
if [ -n "$REMOTE" ]; then
  REMOTE_BASE=${REMOTE%/}
  echo "==> rsync 出主机：$REMOTE_BASE"
  rsync -az "$DB_TMP" "$REMOTE_BASE/$DB_NAME"
  rsync -az "$UPLOADS_TMP" "$REMOTE_BASE/$UPLOADS_NAME"
  rsync -az "$MANIFEST_TMP" "$REMOTE_BASE/$MANIFEST_NAME"
else
  echo "WARNING: REQUIRE_BACKUP_REMOTE=0，仅允许隔离恢复演练使用" >&2
fi

mv "$DB_TMP" "$DEST_ABS/$DB_NAME"
mv "$UPLOADS_TMP" "$DEST_ABS/$UPLOADS_NAME"
mv "$MANIFEST_TMP" "$DEST_ABS/$MANIFEST_NAME"
trap - EXIT

echo "==> 保留 14 天完整备份集"
find "$DEST_ABS" -type f \( -name 'db_*.sql.gz' -o -name 'uploads_*.tar.gz' -o -name 'backup_*.sha256' \) \
  -mtime +14 -delete
echo "备份完成: ${MANIFEST_NAME}（DB + 附件，SHA-256 已校验）"
