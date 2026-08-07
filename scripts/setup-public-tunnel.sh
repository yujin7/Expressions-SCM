#!/usr/bin/env bash
#
# 用 Cloudflare Tunnel 给系统一个**永久 HTTPS 链接**。
#
# 解决的问题：这台机器的局域网 IP 每天都在变（2026-08-05~07 实测漂了八次），
# `.local` 又只在同一网段内有效、且 Windows/安卓多半不解析。隧道给出的是一个
# 固定域名，**与本机 IP 完全无关**——换网络、换 Wi-Fi、重启都不受影响。
#
# 为什么是隧道而不是端口转发：
#   - 不需要公网 IP、不需要在路由器上开洞；
#   - Cloudflare 侧终止 TLS，同事拿到的是真 HTTPS，不再明文传密码；
#   - 出站长连接，家用宽带的动态 IP 无所谓。
#
# 前置（只有这两件必须你本人做，因为要登录你的账号）：
#   1. 一个已托管在 Cloudflare 的域名（免费计划即可）
#   2. `cloudflared tunnel login` —— 会开浏览器让你授权
#
# 用法：
#   bash scripts/setup-public-tunnel.sh exp-scm.你的域名.com
set -euo pipefail

cd "$(dirname "$0")/.."

HOSTNAME_ARG="${1:-}"
TUNNEL_NAME="exp-scm"
LOCAL_TARGET="http://localhost:3100"
ENV_FILE=".env.prod"

if [[ -z "$HOSTNAME_ARG" ]]; then
  cat >&2 <<'USAGE'
✗ 需要指定对外域名。

  bash scripts/setup-public-tunnel.sh exp-scm.你的域名.com

没有域名的话，两个选择：
  · 买一个（任意注册商，几十元/年），再把 DNS 托管到 Cloudflare（免费）
  · 或改用 Tailscale：不需要域名，但每位同事要装客户端
USAGE
  exit 2
fi

command -v cloudflared >/dev/null 2>&1 || { echo "✗ 未安装 cloudflared：brew install cloudflared" >&2; exit 1; }

echo "==> 1/6 检查 Cloudflare 登录状态"
CERT="$HOME/.cloudflared/cert.pem"
if [[ ! -f "$CERT" ]]; then
  echo "    未登录。即将打开浏览器，请选择你要用的域名并授权。"
  cloudflared tunnel login
fi
[[ -f "$CERT" ]] || { echo "✗ 登录未完成（没有生成 $CERT）" >&2; exit 1; }
echo "    已登录 ✓"

echo "==> 2/6 创建/复用隧道 ${TUNNEL_NAME}"
if cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
  echo "    已存在，复用"
else
  cloudflared tunnel create "$TUNNEL_NAME"
fi
TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n {print $1}' | head -1)"
[[ -n "$TUNNEL_ID" ]] || { echo "✗ 取不到隧道 ID" >&2; exit 1; }
echo "    隧道 ID: $TUNNEL_ID"

echo "==> 3/6 绑定域名 ${HOSTNAME_ARG}"
# 幂等：已指向同一隧道时 route dns 会报已存在，不当作失败
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_ARG" 2>&1 | tail -2 || true

echo "==> 4/6 写入隧道配置"
mkdir -p "$HOME/.cloudflared"
cat > "$HOME/.cloudflared/config.yml" <<CFG
tunnel: ${TUNNEL_ID}
credentials-file: ${HOME}/.cloudflared/${TUNNEL_ID}.json

ingress:
  - hostname: ${HOSTNAME_ARG}
    service: ${LOCAL_TARGET}
  - service: http_status:404
CFG
echo "    $HOME/.cloudflared/config.yml"

echo "==> 5/6 把 AUTH_URL 切到新域名并重启应用"
# AUTH_URL 必须与同事实际访问的地址完全一致，否则登录回跳会指向错地方。
# standalone 容器里留空会解析成 http://0.0.0.0:3000（已实测），所以必须显式写。
NEW_URL="https://${HOSTNAME_ARG}"
/usr/bin/sed -i '' "s|^AUTH_URL=.*|AUTH_URL=${NEW_URL}|" "$ENV_FILE"
# 走 HTTPS 之后才允许开 HSTS（明文 HTTP 时开会把自己锁在门外）
if grep -qE '^PUBLIC_HTTPS=' "$ENV_FILE"; then
  /usr/bin/sed -i '' "s|^PUBLIC_HTTPS=.*|PUBLIC_HTTPS=1|" "$ENV_FILE"
else
  printf '\nPUBLIC_HTTPS=1\n' >> "$ENV_FILE"
fi
docker compose --env-file "$ENV_FILE" \
  -f docker-compose.prod.yml -f docker-compose.local.yml up -d app >/dev/null
echo "    AUTH_URL = ${NEW_URL}"

echo "==> 6/6 安装隧道为后台服务（开机自启）"
if launchctl list 2>/dev/null | grep -q "com.cloudflare.cloudflared"; then
  echo "    已安装，重启服务"
  brew services restart cloudflared >/dev/null 2>&1 || true
else
  brew services start cloudflared >/dev/null 2>&1 || true
fi

echo
echo "==> 验证（最多等 60 秒让 DNS 与隧道就绪）"
for _ in $(seq 1 20); do
  sleep 3
  code="$(curl -s -m 8 -o /dev/null -w '%{http_code}' "${NEW_URL}/api/health" || true)"
  if [[ "$code" == "200" ]]; then
    echo
    echo "✓ 永久链接已就绪，发这个给所有人（任何网络、任何设备都能开）："
    echo "    ${NEW_URL}"
    echo
    echo "  这个地址与本机 IP 无关——换网络、重启、IP 再怎么变都不用管。"
    echo "  强烈建议再加一层：Cloudflare Zero Trust → Access → 只允许指定邮箱，"
    echo "  这样登录页之前还有一道闸。"
    exit 0
  fi
done

echo "✗ 60 秒内没等到 200。排查："
echo "    cloudflared tunnel info ${TUNNEL_NAME}"
echo "    brew services list | grep cloudflared"
echo "    curl -I ${NEW_URL}/api/health"
exit 1
