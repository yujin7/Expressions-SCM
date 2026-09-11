#!/usr/bin/env bash
#
# 关闭公网入口：停掉守护与隧道，系统立刻退回「只有局域网能访问」。
#
# 注意：这不会改回 AUTH_URL。关闭后若还要在局域网用，跑一次 `npm run lan:sync`
# 把 AUTH_URL 切回局域网地址，否则登录回跳仍指向已失效的隧道域名。
set -uo pipefail

LABEL="com.expressions.scm-public-tunnel"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
STATE_DIR="$HOME/Library/Application Support/exp-scm"
OWNER_HELPER="$(dirname "$0")/tunnel-process-owner.py"
command -v python3 >/dev/null 2>&1 || { echo "✗ 需要 Python 3；未关闭公网入口" >&2; exit 1; }
python3 "$OWNER_HELPER" "$STATE_DIR" 3100 preflight || exit 1

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
for _ in $(seq 1 20); do
  launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || break
  sleep 1
done
if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
  echo "✗ 守护尚未停止，保留配置和地址；请稍后重试。" >&2; exit 1
fi
[[ ! -L "$STATE_DIR/tunnel-daemon.lock" ]] || exit 1
[[ ! -e "$STATE_DIR/tunnel-daemon.lock" || -f "$STATE_DIR/tunnel-daemon.lock" ]] || exit 1
(umask 077; touch "$STATE_DIR/tunnel-daemon.lock") || exit 1
exec 8>>"$STATE_DIR/tunnel-daemon.lock" || exit 1
python3 "$OWNER_HELPER" "$STATE_DIR" 3100 lock || exit $?
python3 "$OWNER_HELPER" "$STATE_DIR" 3100 stop || exit 1
rm -f "$PLIST"
rm -f "$STATE_DIR/current-url.txt"

echo "✓ 公网入口已关闭，隧道已断开。"
echo
echo "  运行期配置副本仍在 ${STATE_DIR}/runtime（含密钥）。"
echo "  本次保留配置副本；如需删除，请先备份并确认密钥与恢复用途。"
echo
echo "  若还要在局域网继续用，把 AUTH_URL 切回局域网地址：npm run lan:sync"
