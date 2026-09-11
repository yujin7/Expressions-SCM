#!/usr/bin/env bash
# Source in a short-lived operation shell. Reserve FD 9 until that shell exits.
# Scope: same host + OS user + Docker daemon + resolved Compose project. Never unlink
# lock files: replacing the inode would allow a second owner while the first still runs.
app_operation_acquire() {
  local config project daemon key root rc
  command -v python3 >/dev/null 2>&1 || { echo "应用操作锁需要 Python 3；未执行变更。" >&2; return 1; }
  config="$("$1" config --format json 2>/dev/null)" || { echo "无法解析目标 Compose 项目；未执行变更。" >&2; return 1; }
  project="$(printf '%s' "$config" | python3 -c '
import json,re,sys
try:
    name=json.load(sys.stdin).get("name", "")
    if not isinstance(name,str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,127}",name): sys.exit(1)
    print(name)
except Exception: sys.exit(1)
' 2>/dev/null)" || { echo "目标 Compose 项目身份无效；未执行变更。" >&2; return 1; }
  unset config
  daemon="$(docker info --format '{{.ID}}' 2>/dev/null)" || return 1
  [[ "$daemon" =~ ^[a-zA-Z0-9:-]+$ && ${#daemon} -le 128 ]] || { echo "Docker daemon 身份不可确认；未执行变更。" >&2; return 1; }
  key="$(python3 -c 'import hashlib,sys;print(hashlib.sha256((sys.argv[1]+"\n"+sys.argv[2]).encode()).hexdigest())' "$daemon" "$project")" || return 1
  # Fixed /tmp, not per-shell TMPDIR or checkout: launchd and terminal must meet.
  root="/tmp/exp-scm-app-operations-$(id -u)"
  if [[ ! -e "$root" && ! -L "$root" ]]; then
    (umask 077; mkdir "$root") 2>/dev/null || true
  fi
  [[ -d "$root" && ! -L "$root" && -O "$root" ]] || return 1
  chmod 700 "$root" || return 1
  [[ ! -L "$root/$key.lock" ]] || return 1
  (umask 077; touch "$root/$key.lock") || return 1
  [[ -f "$root/$key.lock" && -O "$root/$key.lock" ]] || return 1
  exec 9>>"$root/$key.lock" || return 1
  # flock belongs to the shared open-file description. Python exits but Bash and
  # its operation descendants retain FD 9; the last close releases the kernel lock.
  if python3 -c '
import fcntl,sys
try: fcntl.flock(9,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: sys.exit(75)
except OSError: sys.exit(1)
'; then
    APP_OPERATION_PROJECT="$project"
    return 0
  else
    rc=$?
    exec 9>&-
    if [[ "$rc" == 75 ]]; then
      echo "应用项目 ${project} 正在部署或更新访问配置；本轮不变更，稍后重试。" >&2
    else
      echo "应用操作锁不可用；未执行变更。" >&2
    fi
    return "$rc"
  fi
}
