#!/usr/bin/env bash
#
# 用 mDNS 代理把固定名字 `expscm.local` 指向本机当前局域网 IP。
#
# 为什么不直接改机器名：`scutil --set LocalHostName` 需要管理员密码，
# 而且会连带改掉这台 Mac 在 AirDrop/访达里的身份。这里用 `dns-sd -P`
# 注册一条**代理记录**，不需要 sudo、不动机器本身的名字，
# 同事看到的只有 `expscm.local`，看不出是谁的机器。
#
# 为什么要常驻：
# - `dns-sd -P` 的注册随进程存活，进程退出记录就没了；
# - 这台机器的 IP 会漂（2026-08-05~06 实测一天七次），IP 变了必须重新注册，
#   否则同事解析到的还是旧地址——表现就是"网站打不开"。
#
# 由 LaunchAgent 常驻拉起（用户级，无需 sudo）：npm run lan:alias
set -uo pipefail

ALIAS_NAME="${SCM_MDNS_ALIAS:-expscm}"
ALIAS_NAME="${ALIAS_NAME%.local}"
PORT=3100
CHECK_INTERVAL=20

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

current_ip() {
  ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true
}

DNS_PID=""
LAST_IP=""

cleanup() {
  [[ -n "$DNS_PID" ]] && kill "$DNS_PID" 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT

log "mDNS 别名守护启动：${ALIAS_NAME}.local → 本机当前 IP"

while true; do
  IP="$(current_ip)"

  if [[ -z "$IP" ]]; then
    # 断网：撤掉旧记录，避免把同事指向一个已经不属于本机的地址
    if [[ -n "$DNS_PID" ]]; then
      log "未取到局域网 IP（断网？），撤销 ${ALIAS_NAME}.local 注册"
      kill "$DNS_PID" 2>/dev/null || true
      DNS_PID=""
      LAST_IP=""
    fi
    sleep "$CHECK_INTERVAL"
    continue
  fi

  # 进程死了也要重来（KeepAlive 只保守护本身，不保子进程）
  if [[ "$IP" != "$LAST_IP" ]] || [[ -n "$DNS_PID" && ! -d "/proc/$DNS_PID" && -z "$(ps -p "$DNS_PID" -o pid= 2>/dev/null)" ]] || [[ -z "$DNS_PID" ]]; then
    [[ -n "$DNS_PID" ]] && kill "$DNS_PID" 2>/dev/null || true
    dns-sd -P "$ALIAS_NAME" _http._tcp local "$PORT" "${ALIAS_NAME}.local" "$IP" >/dev/null 2>&1 &
    DNS_PID=$!
    LAST_IP="$IP"
    log "已注册 ${ALIAS_NAME}.local → ${IP}:${PORT} (dns-sd pid=${DNS_PID})"
  fi

  sleep "$CHECK_INTERVAL"
done
