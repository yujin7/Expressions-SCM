#!/usr/bin/env bash
#
# 一条命令开通「所有人都能访问」的公网 HTTPS 链接 —— 不需要域名、不需要注册任何账号。
#
# 装完之后：开机自启、崩溃自拉；地址若变化会自动同步 AUTH_URL 并把新链接推到飞书群。
#
# 卸载：npm run access:public:remove
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"

LABEL="com.expressions.scm-public-tunnel"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
STATE_DIR="$HOME/Library/Application Support/exp-scm"
RUNTIME_DIR="$STATE_DIR/runtime"
TARGET="$STATE_DIR/public-tunnel-daemon.sh"
URL_FILE="$STATE_DIR/current-url.txt"
LOG_DIR="$HOME/Library/Logs"
LOG_FILE="$LOG_DIR/scm-public-tunnel.log"
LOCAL_PORT=3100

command -v cloudflared >/dev/null 2>&1 || {
  echo "✗ 未安装 cloudflared：brew install cloudflared" >&2; exit 1; }
[[ -f "$REPO/.env.prod" ]] || {
  echo "✗ 缺少 $REPO/.env.prod，不能核对既有应用配置" >&2; exit 1; }

echo "==> 1/7 确认应用本机可达"
if [[ "$(curl -s -m 8 -o /dev/null -w '%{http_code}' "http://localhost:${LOCAL_PORT}/api/health")" != "200" ]]; then
  echo "✗ http://localhost:${LOCAL_PORT} 不通。先把容器跑起来：docker ps | grep supply-chain" >&2
  exit 1
fi
echo "    http://localhost:${LOCAL_PORT} ✓"

echo "==> 2/7 核对已部署应用的版本、迁移与 HTTPS 安全头"
# 开公网不是部署：缺 HSTS/版本时先走受控发布（PUBLIC_HTTPS=1），不在此处绕过备份和迁移。
PROJECT="supply-chain"
ENV_FILE="$REPO/.env.prod"
COMPOSE_PROD="$REPO/docker-compose.prod.yml"
COMPOSE_LOCAL="$REPO/docker-compose.local.yml"
# shellcheck source=scripts/tunnel-app-guard.sh
source "$REPO/scripts/tunnel-app-guard.sh"
if ! tunnel_capture_app; then
  echo "✗ 既有应用版本/迁移/HSTS未就绪；请先按发布清单部署 PUBLIC_HTTPS=1 的已验收镜像。未构建或重启应用。" >&2
  exit 1
fi
echo "    已核对版本 $TUNNEL_APP_REVISION；仅安装访问入口，不发布源码"

echo "==> 3/7 复制运行期配置出 TCC 保护目录"
# 仓库在 ~/Downloads 下，launchd 派生的进程读不到（实测 Operation not permitted）。
# 因此把 compose 与 env 复制到 Application Support；每次安装都覆盖，避免与仓库版本漂移。
mkdir -p "$RUNTIME_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
chmod 700 "$STATE_DIR" "$RUNTIME_DIR"
cp "$REPO/docker-compose.prod.yml" "$RUNTIME_DIR/"
cp "$REPO/docker-compose.local.yml" "$RUNTIME_DIR/"
cp "$REPO/.env.prod" "$RUNTIME_DIR/.env.prod"
chmod 600 "$RUNTIME_DIR/.env.prod"   # 含密钥，只给本人读
echo "    ${RUNTIME_DIR}（.env.prod 权限 600）"

echo "==> 4/7 安装守护脚本"
cp "$REPO/scripts/public-tunnel-daemon.sh" "$TARGET"
cp "$REPO/scripts/tunnel-app-guard.sh" "$STATE_DIR/tunnel-app-guard.sh"
chmod +x "$TARGET"

echo "==> 5/7 收掉手工起的隧道，避免同时开两条"
pkill -f 'cloudflared tunnel --no-autoupdate' 2>/dev/null || true
rm -f "$URL_FILE"   # 清掉旧地址，强制本轮重新同步 AUTH_URL

echo "==> 6/7 写入并加载 LaunchAgent"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${TARGET}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- 守护退出时不要 SIGKILL 它拉起的 cloudflared：新守护要接管旧隧道，地址才不会变 -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
# bootout 是异步的：旧实例还没完全退出时立刻 bootstrap 会报 "Bootstrap failed: 5: Input/output error"，
# 并且此时守护**没有**被加载——2026-09-02 实测因此把公网入口整个打掉。先等旧实例消失，再带重试加载。
for _ in $(seq 1 20); do
  launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || break
  sleep 1
done
BOOTSTRAPPED=0
for _ in 1 2 3; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then BOOTSTRAPPED=1; break; fi
  sleep 2
done
if [[ "$BOOTSTRAPPED" != "1" ]]; then
  echo "✗ LaunchAgent 加载失败：launchctl bootstrap gui/$(id -u) $PLIST" >&2
  exit 1
fi
launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true

echo "==> 7/7 等待隧道就绪并验证（最多 3 分钟）"
for _ in $(seq 1 60); do
  sleep 3
  if [[ -s "$URL_FILE" ]]; then
    URL="$(cat "$URL_FILE")"
    echo
    echo "✓ 公网链接已就绪，把这条发给所有人："
    echo
    echo "    ${URL}"
    echo
    echo "  · 任何设备、任何网络都能打开，不用装任何东西"
    echo "  · 真 HTTPS，密码不再明文传输"
    echo "  · 与本机局域网 IP 无关，换 Wi-Fi、IP 再漂都不受影响"
    echo
    echo "  日志：${LOG_FILE}"
    echo "  随时查当前链接：npm run access:link"
    exit 0
  fi
done

echo "✗ 3 分钟内未就绪。看日志：tail -50 ${LOG_FILE}" >&2
exit 1
