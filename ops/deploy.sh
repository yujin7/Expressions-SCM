#!/usr/bin/env bash
# 部署（01 §8：迁移=门禁步骤，非启动时自动跑；发布窗口内执行）
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE_FILE=${SCM_COMPOSE_FILE:-docker-compose.prod.yml}
ENV_FILE=${SCM_ENV_FILE:-.env.prod}
BACKUP_ENV_FILE=${SCM_BACKUP_ENV_FILE:-.env.backup}
if [ ! -f "$ENV_FILE" ]; then
  echo "缺少 $ENV_FILE；先从 .env.example 复制并填写生产值" >&2
  exit 2
fi
if [ "${SCM_INITIAL_DEPLOY:-0}" != "1" ]; then
  if [ ! -f "$BACKUP_ENV_FILE" ]; then
    echo "缺少 $BACKUP_ENV_FILE；正常部署必须先配置迁移前异地备份" >&2
    exit 2
  fi
  set -a
  # shellcheck disable=SC1090
  . "$BACKUP_ENV_FILE"
  set +a
fi
# 让备份与部署始终读取同一套生产 Compose/环境配置。
export SCM_COMPOSE_FILE="$COMPOSE_FILE"
export SCM_ENV_FILE="$ENV_FILE"
compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}
echo "==> 构建镜像"
compose build app
echo "==> 启动/确认数据库"
compose up -d db
if [ "${SCM_INITIAL_DEPLOY:-0}" = "1" ]; then
  echo "==> 首次空环境部署：按显式 SCM_INITIAL_DEPLOY=1 跳过无意义的迁移前备份"
else
  echo "==> 迁移前完整备份（DB + 附件 + 异地副本）"
  ops/backup.sh
  ops/check-backup.sh
fi
echo "==> 迁移门禁（drizzle-kit migrate，对 prod 库）"
compose --profile tools run --rm migrate
echo "==> 滚动重启"
compose up -d

echo "==> 安装备份调度（systemd timer，幂等）"
install_backup_schedule() {
  local repo_dir sudo_cmd changed=0
  repo_dir=$(pwd)
  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /etc/systemd/system ]; then
    echo "    无 systemd——跳过；请按 ops/crontab.example 手工安装 cron 调度"
    return 0
  fi
  sudo_cmd=""
  if [ "$(id -u)" -ne 0 ]; then sudo_cmd="sudo"; fi
  local unit tmp
  for unit in backup.service backup.timer backup-check.service backup-check.timer; do
    tmp=$(mktemp)
    sed "s|__REPO_DIR__|$repo_dir|g" "ops/$unit" > "$tmp"
    if ! cmp -s "$tmp" "/etc/systemd/system/scm-$unit" 2>/dev/null; then
      $sudo_cmd cp "$tmp" "/etc/systemd/system/scm-$unit"
      echo "    已安装/更新 /etc/systemd/system/scm-$unit"
      changed=1
    else
      echo "    scm-$unit 无变化，跳过"
    fi
    rm -f "$tmp"
  done
  if [ "$changed" -eq 1 ]; then
    $sudo_cmd systemctl daemon-reload
  fi
  local timer
  for timer in scm-backup.timer scm-backup-check.timer; do
    if ! systemctl is-enabled --quiet "$timer" 2>/dev/null; then
      $sudo_cmd systemctl enable --now "$timer"
      echo "    已启用 $timer"
    else
      echo "    $timer 已启用"
    fi
  done
  echo "    scm-backup-check.timer 每小时验证 DB+附件配对、SHA-256、压缩结构与新鲜度"
}
install_backup_schedule

echo "==> 健康检查"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/api/health | grep -q '"ok":true'; then
    echo "部署完成 ✓"; exit 0
  fi
  sleep 2
done
echo "健康检查失败——检查 docker compose logs app" >&2
exit 1
