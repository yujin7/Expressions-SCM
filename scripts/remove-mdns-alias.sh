#!/usr/bin/env bash
# 卸载 mDNS 别名守护（不需要 sudo）
set -uo pipefail
LABEL="com.expressions.scm-mdns-alias"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/${LABEL}.plist"
rm -rf "$HOME/Library/Application Support/exp-scm"
pkill -f "dns-sd -P expscm" 2>/dev/null || true
pkill -f "dns-sd -P exp-scm" 2>/dev/null || true
echo "已卸载 ${LABEL}，expscm.local 不再广播"
