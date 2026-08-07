#!/usr/bin/env bash
#
# 公网入口守护：用 Cloudflare **快速隧道**给系统一个 HTTPS 地址，并保证它一直活着。
#
# 为什么是快速隧道（quick tunnel）：
#   老板的约束是「不买域名、不注册任何账号」。在这个约束下实测过的选项只剩它：
#     · 具名隧道 → 需要 Cloudflare 账号 + 自有域名        ✗
#     · Tailscale → 需要注册并登录，且每位同事要装客户端  ✗
#     · serveo.net → 2026-08-07 实测 22 端口连不上，已废弃 ✗
#     · localhost.run → 实测 20 秒内无响应，不可依赖       ✗
#     · Cloudflare 快速隧道 → 0 注册、0 费用、真 HTTPS      ✓
#
# 快速隧道唯一的代价：**地址在 cloudflared 进程重启时会变**（Cloudflare 随机分配）。
# 本守护就是为了让这个代价不落到人身上：
#   1. KeepAlive 保证进程活着 —— 只要不重启机器，地址就不变；
#   2. 地址真变了，自动把 AUTH_URL 同步过去并重启应用（不同步的话表现为
#      「页面能打开但登不进去」，因为登录回跳会指向上一个已失效的地址）；
#   3. 变更后自动往飞书群推新链接 —— 同事不用来问「怎么又打不开了」。
#
# 为什么配置要从 ~/Library/Application Support 读，而不是直接读仓库：
#   仓库在 ~/Downloads 下，属于 macOS TCC 保护目录。**launchd 派生的进程读不到**，
#   2026-08-07 实测：READ_ENV=DENIED / READ_COMPOSE=DENIED，而同一环境下 docker CLI 正常
#   （它只走 daemon socket，不碰受保护文件）。所以安装脚本会把 compose 与 env 复制出来。
#
# 由 LaunchAgent 常驻拉起：npm run access:public
set -uo pipefail

# launchd 给的 PATH 极简，必须自己补齐；docker 在 /usr/local/bin，cloudflared 在 homebrew
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

STATE_DIR="$HOME/Library/Application Support/exp-scm"
RUNTIME_DIR="$STATE_DIR/runtime"
URL_FILE="$STATE_DIR/current-url.txt"
TUNNEL_LOG="$STATE_DIR/cloudflared.log"
ENV_FILE="$RUNTIME_DIR/.env.prod"
COMPOSE_PROD="$RUNTIME_DIR/docker-compose.prod.yml"
COMPOSE_LOCAL="$RUNTIME_DIR/docker-compose.local.yml"

# 必须与既有容器同项目名，否则 compose 会另起一套容器并挂**全新空卷**——
# 表现就是「数据全没了」。实测既有项目名 supply-chain，卷 supply-chain_pgdata/_uploads。
PROJECT="supply-chain"
LOCAL_PORT=3100

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

env_get() {
  [[ -r "$ENV_FILE" ]] || return 0
  /usr/bin/grep -m1 -E "^$1=" "$ENV_FILE" 2>/dev/null \
    | /usr/bin/sed -E "s/^$1=//" \
    | /usr/bin/sed -E 's/^"(.*)"$/\1/'
}

CF_PID=""
cleanup() {
  [[ -n "$CF_PID" ]] && kill "$CF_PID" 2>/dev/null
  exit 0
}
trap cleanup TERM INT

# 往飞书群推链接。签名算法与 src/jobs/notify.ts 一致：
# 把 `时间戳\n密钥` 整体当 HMAC 的**密钥**，对**空串**做 HmacSHA256 再 Base64。
# 这里用 openssl 复刻，已与 node 实现逐字节比对过（2026-08-07 验证一致）。
announce() {
  local url="$1" kind="$2"
  local hook secret ts key sign body text
  hook="$(env_get FEISHU_WEBHOOK_URL)"
  [[ -n "$hook" ]] || { log "未配飞书 webhook，跳过播报"; return 0; }
  secret="$(env_get FEISHU_WEBHOOK_SECRET)"

  if [[ "$kind" == "new" ]]; then
    text="【供应链系统】新的访问链接
${url}

旧链接已失效，请改用这个（手机、电脑、任何网络都能打开）。
账号密码不变。"
  else
    text="【供应链系统】访问链接
${url}"
  fi

  if [[ -n "$secret" ]]; then
    ts="$(date +%s)"
    key="$(printf '%s\n%s' "$ts" "$secret")"
    sign="$(printf '' | openssl dgst -sha256 -hmac "$key" -binary | base64)"
    body="$(printf '%s' "$text" | /usr/bin/python3 -c 'import json,sys;print(json.dumps({"msg_type":"text","timestamp":sys.argv[1],"sign":sys.argv[2],"content":{"text":sys.stdin.read()}}))' "$ts" "$sign")"
  else
    body="$(printf '%s' "$text" | /usr/bin/python3 -c 'import json,sys;print(json.dumps({"msg_type":"text","content":{"text":sys.stdin.read()}}))')"
  fi

  local resp
  resp="$(curl -s -m 15 -X POST -H 'Content-Type: application/json' -d "$body" "$hook" 2>&1)"
  # 用 case 而不是 `printf | grep -q`：pipefail 下 grep -q 命中即退出会让上游收 SIGPIPE，
  # 管道退出码变 141，把成功判成失败（同一个坑已在 show-access-link.sh 上踩过）。
  case "$resp" in
    *'"code":0'*|*'"StatusCode":0'*) log "已推送链接到飞书群" ;;
    *) log "飞书推送失败：$resp" ;;
  esac
}

wait_for_docker() {
  local i
  for i in $(seq 1 60); do
    docker info >/dev/null 2>&1 && return 0
    sleep 5
  done
  return 1
}

# 把新地址落到应用上。
# 关键：用**环境变量覆盖**而不是改写 env 文件——compose 的插值优先级是
# shell 环境 > --env-file，因此磁盘上的配置始终只有一份真相，不会漂。
apply_url() {
  local url="$1"
  local prev
  prev="$(cat "$URL_FILE" 2>/dev/null || true)"
  log "落地 AUTH_URL → ${url}"

  if ! AUTH_URL="$url" PUBLIC_HTTPS=1 docker compose -p "$PROJECT" \
      --env-file "$ENV_FILE" -f "$COMPOSE_PROD" -f "$COMPOSE_LOCAL" up -d --no-build app 2>&1 | tail -3; then
    log "✗ 重启应用失败"
    return 1
  fi

  local i code redir
  for i in $(seq 1 30); do
    sleep 3
    code="$(curl -s -m 8 -o /dev/null -w '%{http_code}' "${url}/api/health" 2>/dev/null)"
    [[ "$code" == "200" ]] || continue
    # 健康 200 还不够：AUTH_URL 没生效时页面照样能开，但登录回跳会指向旧地址。
    # 真正的证据是根路径的跳转目标已经换成新域名。
    redir="$(curl -s -m 8 -o /dev/null -w '%{redirect_url}' "${url}/" 2>/dev/null)"
    if [[ "$redir" == "${url}"* ]]; then
      printf '%s\n' "$url" > "$URL_FILE"
      log "✓ 已生效：${url}（登录回跳指向 ${redir}）"
      # 只有换了新地址才打扰群里；修复漂移不播报（地址没变，同事无需知道）
      if [[ "$prev" != "$url" ]]; then
        announce "$url" "new"
      fi
      return 0
    fi
    log "健康检查已通过，但回跳仍指向 ${redir}，继续等待应用完成重建…"
  done

  log "✗ 90 秒内未确认生效，保留旧状态待下轮重试"
  return 1
}

# 确保应用当前真的在用这个地址。
#
# 不能只比对「地址有没有变」：任何人手工跑一次 `docker compose up -d app`，
# 容器就会按 env 文件里的旧 AUTH_URL 重建，而隧道地址并没有变——
# 于是守护以为一切正常，实际表现是「网页能打开但登不进去」。
# 因此判据取应用的**实际行为**（根路径回跳指向哪里），而不是守护自己的记忆。
ensure_url() {
  local url="$1" redir
  redir="$(curl -s -m 8 -o /dev/null -w '%{redirect_url}' "${url}/" 2>/dev/null)"
  if [[ -n "$redir" && "$redir" == "${url}"* ]]; then
    [[ "$(cat "$URL_FILE" 2>/dev/null || true)" == "$url" ]] || printf '%s\n' "$url" > "$URL_FILE"
    return 0
  fi
  [[ -n "$redir" ]] && log "应用回跳指向 ${redir}，与隧道地址不符——重新同步"
  apply_url "$url"
}

log "=== 公网入口守护启动 ==="

while true; do
  if ! wait_for_docker; then
    log "Docker 5 分钟内未就绪，30 秒后重试"
    sleep 30
    continue
  fi

  : > "$TUNNEL_LOG"
  cloudflared tunnel --no-autoupdate --url "http://localhost:${LOCAL_PORT}" >> "$TUNNEL_LOG" 2>&1 &
  CF_PID=$!
  log "cloudflared 已启动 (pid=${CF_PID})，等待分配地址…"

  URL=""
  for _ in $(seq 1 40); do
    sleep 3
    URL="$(/usr/bin/grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)"
    [[ -n "$URL" ]] && break
    kill -0 "$CF_PID" 2>/dev/null || break
  done

  if [[ -z "$URL" ]]; then
    log "✗ 未取到隧道地址，重建（cloudflared 日志见 ${TUNNEL_LOG}）"
    kill "$CF_PID" 2>/dev/null
    wait "$CF_PID" 2>/dev/null
    CF_PID=""
    sleep 15
    continue
  fi

  log "隧道地址：${URL}"
  ensure_url "$URL"

  # 守着 cloudflared。只要它活着，地址就不会变；期间每分钟核对一次应用是否还在用这个
  # 地址，防的是「别人手工重启了容器把 AUTH_URL 还原」这类静默漂移。
  while kill -0 "$CF_PID" 2>/dev/null; do
    sleep 60
    ensure_url "$URL"
  done

  log "cloudflared 已退出，5 秒后重建隧道（地址会变，届时自动同步并播报）"
  CF_PID=""
  sleep 5
done
