#!/usr/bin/env bash
#
# 把 .env.prod 的 AUTH_URL 同步到本机当前局域网 IP，并重启 app 容器。
#
# 为什么需要它：AUTH_URL 必须是同事实际访问的地址，而这台机器的 IP 会随
# DHCP/换网络漂移（2026-08-05 一天内实测漂了三次）。AUTH_URL 指向旧 IP 时
# 页面还能打开，但登录回跳会指向一个不存在的地址——症状是"网站打不开了"。
#
# 不能靠 trustHost 省掉这一步：standalone 容器里 AUTH_URL 留空时，
# credentials 回调会解析成服务端自身绑定地址 http://0.0.0.0:3000（已实测）。
#
# 用法：npm run lan:sync        （不带参数=自动探测 IP）
#       npm run lan:sync -- 192.168.1.253   （手动指定）
set -euo pipefail

cd "$(dirname "$0")/.."

PORT=3100
ENV_FILE=.env.prod

if [[ $# -ge 1 && -n "${1:-}" ]]; then
  IP="$1"
else
  IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
  [[ -z "$IP" ]] && IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
fi

if [[ -z "${IP:-}" ]]; then
  echo "✗ 探测不到局域网 IP（Wi-Fi 断了？）。可手动指定：npm run lan:sync -- 192.168.1.2" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "✗ 找不到 $ENV_FILE" >&2
  exit 1
fi

NEW="http://${IP}:${PORT}"
OLD="$(grep -E '^AUTH_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"

if [[ "$OLD" == "$NEW" ]]; then
  echo "AUTH_URL 已经是 $NEW，无需改动。"
else
  # 只改这一行，不碰文件里的其它密钥
  /usr/bin/sed -i '' "s|^AUTH_URL=.*|AUTH_URL=${NEW}|" "$ENV_FILE"
  echo "AUTH_URL: ${OLD:-（空）}  →  ${NEW}"
fi

echo "重启 app 容器…"
docker compose --env-file "$ENV_FILE" \
  -f docker-compose.prod.yml -f docker-compose.local.yml up -d app >/dev/null

# 等健康检查转绿再报成功，避免"命令跑完了但站点还没起来"
for _ in $(seq 1 30); do
  sleep 2
  code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "${NEW}/api/health" || true)"
  if [[ "$code" == "200" ]]; then
    echo
    echo "✓ 站点已就绪，请把这个地址发给同事："
    echo "    ${NEW}"
    exit 0
  fi
done

echo "✗ 30 秒内健康检查未通过，请看 docker compose logs app" >&2
exit 1
