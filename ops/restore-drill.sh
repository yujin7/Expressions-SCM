#!/usr/bin/env bash
# 生产式恢复演练：把完整备份集恢复到一次性 PostgreSQL 16 容器，绝不接触在线数据库。
set -euo pipefail
cd "$(dirname "$0")/.."

DEST=${BACKUP_DIR:-./backups}
requested=${BACKUP_MANIFEST:-}
manifest=${requested:-$(ls -1t "$DEST"/backup_*.sha256 2>/dev/null | head -n 1 || true)}
if [ -z "$manifest" ] || [ ! -f "$manifest" ]; then
  echo "没有可演练的完整备份集；先运行 ops/backup.sh" >&2
  exit 2
fi

manifest=$(cd "$(dirname "$manifest")" && pwd)/$(basename "$manifest")
backup_dir=$(dirname "$manifest")
base=$(basename "$manifest")
stamp=${base#backup_}
stamp=${stamp%.sha256}
db_file="$backup_dir/db_$stamp.sql.gz"
uploads_file="$backup_dir/uploads_$stamp.tar.gz"
container="scm-restore-drill-${stamp//_/-}-$$"
attachments_tmp=$(mktemp -d)
started=$(date +%s)

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$attachments_tmp"
}
trap cleanup EXIT

BACKUP_DIR="$backup_dir" BACKUP_MANIFEST="$manifest" MAX_AGE_HOURS=1000000 \
  ops/check-backup.sh >/dev/null

docker run -d --name "$container" \
  -e POSTGRES_USER=scm \
  -e POSTGRES_PASSWORD=scm_restore_drill_only \
  -e POSTGRES_DB=scm \
  postgres:16-alpine >/dev/null

ready=0
for _ in $(seq 1 30); do
  if docker exec "$container" pg_isready -U scm -d scm >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "恢复演练 PostgreSQL 未就绪" >&2
  exit 1
fi

gunzip -c "$db_file" | docker exec -i "$container" \
  psql -v ON_ERROR_STOP=1 -U scm -d scm >/dev/null
tar xzf "$uploads_file" -C "$attachments_tmp"

applied=$(docker exec "$container" psql -Atqc \
  'select count(*) from drizzle.__drizzle_migrations' -U scm -d scm)
users=$(docker exec "$container" psql -Atqc 'select count(*) from users' -U scm -d scm)
required_tables=$(docker exec "$container" psql -Atqc \
  "select count(*) from information_schema.tables where table_schema='public' and table_name in ('users','stock_ledger','stock_balances','audit_logs','batches')" \
  -U scm -d scm)
expected=$(find drizzle -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')
attachment_files=$(find "$attachments_tmp" -type f | wc -l | tr -d ' ')
duration=$(( $(date +%s) - started ))

if [ "$applied" -ne "$expected" ] || [ "$users" -lt 1 ] || [ "$required_tables" -ne 5 ]; then
  echo "恢复校验失败: migrations=$applied/$expected users=$users requiredTables=$required_tables/5" >&2
  exit 1
fi

mkdir -p .artifacts/restore-drill
report=".artifacts/restore-drill/$stamp.json"
printf '{"ok":true,"backupSet":"%s","durationSeconds":%s,"appliedMigrations":%s,"users":%s,"requiredTables":%s,"attachmentFiles":%s}\n' \
  "$stamp" "$duration" "$applied" "$users" "$required_tables" "$attachment_files" > "$report"
echo "READY: 恢复演练通过（${duration}s；migrations=${applied}；users=${users}；attachments=${attachment_files}）"
echo "Report: $report"
