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
echo "==> 健康检查"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/api/health | grep -q '"ok":true'; then
    echo "部署完成 ✓"; exit 0
  fi
  sleep 2
done
echo "健康检查失败——检查 docker compose logs app" >&2
exit 1
