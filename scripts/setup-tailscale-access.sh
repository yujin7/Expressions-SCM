#!/usr/bin/env bash
#
# 用 Tailscale 给系统一个**永久地址**，且完全不对公网暴露。
#
# 与 Cloudflare 隧道的取舍：
#   - Tailscale：地址固定、随处可用、**不上公网**（安全性最好）；
#     代价是每位同事要装一个客户端并登录。
#   - Cloudflare 隧道：同事什么都不用装，打开链接就行；
#     代价是这是一个公网地址（建议再叠 Cloudflare Access 限定邮箱）。
#
# 前置（必须你本人做，要登录你的账号）：
#   1. 打开 /Applications/Tailscale.app 登录（免费计划够小团队）
#   2. 在 Tailscale 后台把同事的账号邀请进同一个 tailnet
#
# 用法：bash scripts/setup-tailscale-access.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=".env.prod"
PORT=3100
TS_CLI="/Applications/Tailscale.app/Contents/MacOS/Tailscale"

echo "==> 1/4 检查 Tailscale 是否已连接"
# App Store 版的 CLI 在沙盒外调用会报 bundleIdentifier 错，因此直接看网络接口：
# 连上后本机会拿到一个 100.64.0.0/10（CGNAT 段）地址。
TS_IP="$(ifconfig 2>/dev/null | awk '/inet 100\./ {print $2; exit}')"
if [[ -z "$TS_IP" ]]; then
  cat >&2 <<'NEED'
✗ Tailscale 尚未连接（本机没有 100.x 地址）。

请先完成这一步（只需一次）：
  1. 打开 /Applications/Tailscale.app
  2. 用你的账号登录（Google/Microsoft/邮箱都行）
  3. 确认菜单栏图标显示已连接

然后重新运行本脚本。
NEED
  exit 2
fi
echo "    已连接，本机 Tailscale IP: ${TS_IP}"

echo "==> 2/4 确认应用在该地址上可达"
if ! curl -s -m 8 -o /dev/null "http://${TS_IP}:${PORT}/api/health"; then
  echo "✗ http://${TS_IP}:${PORT} 不通。容器是否在跑？docker ps | grep supply-chain" >&2
  exit 1
fi
echo "    http://${TS_IP}:${PORT} ✓"

echo "==> 3/4 切换 AUTH_URL 到 Tailscale 地址"
# AUTH_URL 必须与同事实际输入的地址一致，否则登录回跳会指向错处。
# standalone 容器里留空会解析成 http://0.0.0.0:3000（已实测），必须显式写。
NEW_URL="http://${TS_IP}:${PORT}"
/usr/bin/sed -i '' "s|^AUTH_URL=.*|AUTH_URL=${NEW_URL}|" "$ENV_FILE"
# Tailscale 内网是明文 HTTP（流量本身由 WireGuard 加密），不能开 HSTS
if grep -qE '^PUBLIC_HTTPS=' "$ENV_FILE"; then
  /usr/bin/sed -i '' "s|^PUBLIC_HTTPS=.*|PUBLIC_HTTPS=|" "$ENV_FILE"
fi
docker compose --env-file "$ENV_FILE" \
  -f docker-compose.prod.yml -f docker-compose.local.yml up -d app >/dev/null

echo "==> 4/4 验证"
for _ in $(seq 1 20); do
  sleep 2
  if [[ "$(curl -s -m 6 -o /dev/null -w '%{http_code}' "${NEW_URL}/api/health")" == "200" ]]; then
    echo
    echo "✓ 永久地址已就绪，发这个给同事（他们需先加入你的 tailnet 并装客户端）："
    echo "    ${NEW_URL}"
    echo
    echo "  这个地址不随 Wi-Fi / 局域网 IP 变化，在家、在公司、在外地都能用。"
    echo "  全程不经公网，流量由 WireGuard 加密。"
    echo
    echo "  提示：在 Tailscale 后台给本机固定一个易记名字后，还可以用"
    echo "        http://<机器名>:${PORT} 访问（MagicDNS）。"
    exit 0
  fi
done
echo "✗ 未在 40 秒内返回 200，请看 docker compose logs app" >&2
exit 1
