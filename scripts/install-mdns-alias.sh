#!/usr/bin/env bash
#
# 把 mDNS 别名守护装成用户级 LaunchAgent（**不需要 sudo**）。
# 装完 `exp-scm.local` 常驻可用：开机自启、崩溃自拉、IP 变了自动重注册。
#
# 注意：脚本会被**复制**到 ~/Library/Application Support/ 再由 launchd 拉起。
# 不能直接从仓库路径运行——本仓库在 ~/Downloads 下，属于 macOS TCC 保护目录，
# launchd 派生的进程读不到，实测报 `Operation not permitted`。
#
# 卸载：npm run lan:alias:remove
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"
LABEL="com.expressions.scm-mdns-alias"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
INSTALL_DIR="$HOME/Library/Application Support/exp-scm"
TARGET="$INSTALL_DIR/mdns-alias.sh"
LOG_DIR="$HOME/Library/Logs"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR" "$INSTALL_DIR"

# 复制出 TCC 保护目录；每次安装都覆盖，保证与仓库版本一致
cp "$REPO/scripts/mdns-alias.sh" "$TARGET"
chmod +x "$TARGET"

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
  <key>StandardOutPath</key><string>${LOG_DIR}/scm-mdns-alias.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/scm-mdns-alias.log</string>
</dict>
</plist>
PLISTEOF

# 幂等：先卸后装，避免重复注册
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true

echo "已安装并启动：${LABEL}"
echo "  守护脚本：${TARGET}"
echo "  日志：    ${LOG_DIR}/scm-mdns-alias.log"
