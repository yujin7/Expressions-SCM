#!/usr/bin/env bash
#
# 把 mDNS 别名守护装成用户级 LaunchAgent（**不需要 sudo**）。
# 装完 `expscm.local` 常驻可用：开机自启、崩溃自拉、IP 变了自动重注册。
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

# bootout 返回时 launchd 仍可能在异步清理旧 job（其最短运行窗口约 10 秒），
# 紧接着 bootstrap 会报 `Bootstrap failed: 5: Input/output error`。先等旧 job
# 真正消失，再有限重试 bootstrap；超时仍返回非零，不伪装成安装成功。
JOB_GONE=false
for _ in $(seq 1 20); do
  if ! launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
    JOB_GONE=true
    break
  fi
  sleep 1
done

if [[ "$JOB_GONE" != "true" ]]; then
  echo "✗ 等待旧 ${LABEL} 退出超时" >&2
  exit 1
fi

STARTED=false
for attempt in 1 2 3; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
    STARTED=true
    break
  fi
  sleep "$attempt"
done

if [[ "$STARTED" != "true" ]]; then
  echo "✗ 三次尝试后仍无法启动 ${LABEL}" >&2
  exit 1
fi

launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true

echo "已安装并启动：${LABEL}"
echo "  守护脚本：${TARGET}"
echo "  日志：    ${LOG_DIR}/scm-mdns-alias.log"
