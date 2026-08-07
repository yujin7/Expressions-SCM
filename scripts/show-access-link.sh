#!/usr/bin/env bash
#
# 打印当前对外访问链接，并当场验证它是不是真的通。
#
# 存在的理由：快速隧道的地址在 cloudflared 重启后会变，守护会自动同步并推飞书，
# 但人总有找不到那条消息的时候——这里是随时可查的权威出处。
set -uo pipefail

STATE_DIR="$HOME/Library/Application Support/exp-scm"
URL_FILE="$STATE_DIR/current-url.txt"
LOG_FILE="$HOME/Library/Logs/scm-public-tunnel.log"
LABEL="com.expressions.scm-public-tunnel"

# 先取值再匹配，不要写成 `launchctl list | grep -q`。
# 在 `set -o pipefail` 下 grep -q 命中即退出 → launchctl 收到 SIGPIPE 死掉 → 整条管道退出码 141，
# 于是「守护明明在跑」却被判成没跑（2026-08-07 实测踩过）。
LAUNCH_LIST="$(launchctl list 2>/dev/null || true)"
case "$LAUNCH_LIST" in
  *"$LABEL"*) ;;
  *)
    echo "✗ 公网入口守护未在运行。开通：npm run access:public"
    exit 1
    ;;
esac

if [[ ! -s "$URL_FILE" ]]; then
  echo "⏳ 守护在跑，但还没拿到地址（可能刚启动，或应用没起来）。"
  echo "   看日志：tail -30 ${LOG_FILE}"
  exit 1
fi

URL="$(cat "$URL_FILE")"
CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "${URL}/api/health" 2>/dev/null)"

echo "当前对外链接："
echo
echo "    ${URL}"
echo
if [[ "$CODE" == "200" ]]; then
  echo "状态：✓ 在线（/api/health 返回 200）"
else
  echo "状态：✗ 不通（/api/health 返回 ${CODE:-无响应}）"
  echo "      守护会自己重建隧道；若持续不通看日志：tail -30 ${LOG_FILE}"
fi
