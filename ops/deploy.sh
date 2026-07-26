#!/usr/bin/env bash
# 部署（01 §8：迁移=门禁步骤，非启动时自动跑；发布窗口内执行）
set -euo pipefail
cd "$(dirname "$0")/.."
echo "==> 构建镜像"
docker compose -f docker-compose.prod.yml build app
echo "==> 迁移门禁（drizzle-kit migrate，对 prod 库）"
docker compose -f docker-compose.prod.yml run --rm app npx drizzle-kit migrate
echo "==> 滚动重启"
docker compose -f docker-compose.prod.yml up -d

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
  for unit in backup.service backup.timer; do
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
  if ! systemctl is-enabled --quiet scm-backup.timer 2>/dev/null; then
    $sudo_cmd systemctl enable --now scm-backup.timer
    echo "    已启用 scm-backup.timer（每日 02:30 Asia/Shanghai）"
  else
    echo "    scm-backup.timer 已启用"
  fi
  echo "    新鲜度监控：把 ops/check-backup.sh 接入 cron/监控（>25h 非零退出），见 ops/crontab.example"
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
