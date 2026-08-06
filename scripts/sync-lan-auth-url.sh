#!/usr/bin/env bash
#
# 同步 .env.prod 的 AUTH_URL 并重启 app 容器。
#
# 默认用 Bonjour 主机名（`<LocalHostName>.local`）——**它不随 IP 变**，
# 所以换网络/DHCP 重新分配都不需要再动这里。2026-08-05~06 实测这台机器
# 一天内漂了六次（3.154 → 10.86 → 3.154 → 1.253 → 30.138 → 31.49），
# 每次都得改 AUTH_URL 重启一次，同事那边表现为"网站打不开"。
#
# 为什么 AUTH_URL 不能留空：standalone 容器里留空时 credentials 回调会解析成
# 服务端自身绑定地址 http://0.0.0.0:3000（已实测），即便 auth/config.ts 与
# middleware.ts 都已 trustHost: true——那会把全组挡在登录页外。
#
# 用法：
#   npm run lan:sync              # 用 .local 主机名（推荐）
#   npm run lan:sync -- --ip      # 改用当前局域网 IP（mDNS 解析不了的设备用）
#   npm run lan:sync -- 192.168.1.5   # 手动指定
set -euo pipefail

cd "$(dirname "$0")/.."

PORT=3100
ENV_FILE=.env.prod
MODE="host"
MANUAL=""

case "${1:-}" in
  --ip) MODE="ip" ;;
  "")   ;;
  *)    MANUAL="$1" ;;
esac

if [[ -n "$MANUAL" ]]; then
  TARGET="$MANUAL"
elif [[ "$MODE" == "host" ]]; then
  # 固定别名（由 npm run lan:alias 的守护广播，不随 IP 变、也不暴露机器主人）
  TARGET="exp-scm.local"
  if ! curl -s -m 4 -o /dev/null "http://${TARGET}:${PORT}/api/health" 2>/dev/null; then
    echo "⚠ ${TARGET} 当前解析不到——mDNS 别名守护可能没在跑。" >&2
    echo "  先执行：npm run lan:alias" >&2
    echo "  或临时改用 IP：npm run lan:sync -- --ip" >&2
    exit 1
  fi
else
  TARGET="$(ipconfig getifaddr en0 2>/dev/null || true)"
  [[ -z "$TARGET" ]] && TARGET="$(ipconfig getifaddr en1 2>/dev/null || true)"
  if [[ -z "$TARGET" ]]; then
    echo "✗ 探测不到局域网 IP（Wi-Fi 断了？）。可手动指定：npm run lan:sync -- 192.168.1.5" >&2
    exit 1
  fi
fi

[[ -f "$ENV_FILE" ]] || { echo "✗ 找不到 $ENV_FILE" >&2; exit 1; }

NEW="http://${TARGET}:${PORT}"
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
    if [[ "$MODE" == "host" && -z "$MANUAL" ]]; then
      echo
      echo "  （这个地址不随 IP 变，换网络也不用再跑本命令。）"
      echo "  若个别同事打不开——多为 Windows/安卓不解析 .local——"
      echo "  让那几台改用 IP 地址：http://$(ipconfig getifaddr en0 2>/dev/null || echo '<本机IP>'):${PORT}"
      echo "  若全组都打不开，整体切回 IP：npm run lan:sync -- --ip"
    fi
    exit 0
  fi
done

echo "✗ 30 秒内健康检查未通过，请看 docker compose logs app" >&2
exit 1
