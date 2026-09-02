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

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "$PLIST"
pkill -f 'cloudflared tunnel --no-autoupdate' 2>/dev/null || true
rm -f "$STATE_DIR/current-url.txt"

echo "✓ 公网入口已关闭，隧道已断开。"
echo
echo "  运行期配置副本仍在 ${STATE_DIR}/runtime（含密钥）。"
echo "  要一并清掉：rm -rf \"${STATE_DIR}/runtime\""
echo
echo "  若还要在局域网继续用，把 AUTH_URL 切回局域网地址：npm run lan:sync"
