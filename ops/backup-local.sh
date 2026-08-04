#!/usr/bin/env bash
# 本机实跑库的每日备份。
#
# 为什么单独写一个：ops/backup.sh 是给服务器部署用的（走 systemd、要求远端副本）。
# 这台笔记本上的实跑库是 docker compose 起的 PostgreSQL 容器，
# 数据是刚从开发库搬过去的全部真实业务数据——**没有备份等于把 5,376 个 SKU
# 和全部单据押在一个 docker volume 上**。容器误删、Docker Desktop 重置、磁盘故障都能一次清零。
#
# 装成每日任务：
#   (crontab -l 2>/dev/null; echo "30 2 * * * bash '<仓库路径>/ops/backup-local.sh' >> /tmp/scm-backup.log 2>&1") | crontab -
#
# 保留策略：默认保留最近 14 份，够覆盖"上周误操作今天才发现"。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

ENV_FILE="${ENV_FILE:-$REPO/.env.prod}"
[ -f "$ENV_FILE" ] || { echo "缺少 $ENV_FILE"; exit 1; }

DEST="${BACKUP_DIR:-$REPO/backups/live}"
KEEP="${BACKUP_KEEP:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"

# 直接在容器里 pg_dump，避免依赖宿主机装没装 postgresql 客户端
docker compose -f docker-compose.prod.yml -f docker-compose.local.yml --env-file "$ENV_FILE" \
  exec -T db pg_dump -U scm -d scm --format=custom \
  > "$DEST/scm_$STAMP.dump"

# 校验和：备份文件损坏而不自知，比没有备份更危险——恢复时才发现就晚了
shasum -a 256 "$DEST/scm_$STAMP.dump" | awk '{print $1}' > "$DEST/scm_$STAMP.sha256"

SIZE=$(du -h "$DEST/scm_$STAMP.dump" | awk '{print $1}')
echo "$(date '+%F %T') 备份完成 scm_$STAMP.dump ($SIZE)"

# 附件（上传的文件）一并备份——只备份数据库会丢掉导入的原始表格与质检照片
if docker compose -f docker-compose.prod.yml -f docker-compose.local.yml --env-file "$ENV_FILE" \
     exec -T app sh -c 'ls /data/uploads >/dev/null 2>&1'; then
  docker compose -f docker-compose.prod.yml -f docker-compose.local.yml --env-file "$ENV_FILE" \
    exec -T app tar -cf - -C /data uploads > "$DEST/uploads_$STAMP.tar"
  shasum -a 256 "$DEST/uploads_$STAMP.tar" | awk '{print $1}' > "$DEST/uploads_$STAMP.sha256"
  echo "$(date '+%F %T') 附件备份完成 uploads_$STAMP.tar"
fi

# 轮转
ls -1t "$DEST"/scm_*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old" "${old%.dump}.sha256"
done
ls -1t "$DEST"/uploads_*.tar 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old" "${old%.tar}.sha256"
done

echo "$(date '+%F %T') 当前保留 $(ls -1 "$DEST"/scm_*.dump 2>/dev/null | wc -l | tr -d ' ') 份数据库备份"
