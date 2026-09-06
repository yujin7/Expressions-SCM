#!/usr/bin/env bash
# 部署（01 §8：迁移=门禁步骤，非启动时自动跑；发布窗口内执行）
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE_FILE=${SCM_COMPOSE_FILE:-docker-compose.prod.yml}
ENV_FILE=${SCM_ENV_FILE:-.env.prod}
BACKUP_ENV_FILE=${SCM_BACKUP_ENV_FILE:-.env.backup}
if [ ! -f "$ENV_FILE" ]; then
  echo "缺少 $ENV_FILE；先从 .env.example 复制并填写生产值" >&2
  exit 2
fi
if [ "${SCM_INITIAL_DEPLOY:-0}" != "1" ]; then
  if [ ! -f "$BACKUP_ENV_FILE" ]; then
    echo "缺少 $BACKUP_ENV_FILE；正常部署必须先配置迁移前异地备份" >&2
    exit 2
  fi
  set -a
  # shellcheck disable=SC1090
  . "$BACKUP_ENV_FILE"
  set +a
fi
# 让备份与部署始终读取同一套生产 Compose/环境配置。
export SCM_COMPOSE_FILE="$COMPOSE_FILE"
export SCM_ENV_FILE="$ENV_FILE"
compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}
echo "==> 给当前在跑的镜像打回滚标签"
# 回滚点必须在 **build 之前** 打，不是 up -d 之前：`compose build` 一接管 latest，旧镜像就变成悬空层，
# Docker Desktop 的构建 GC 会直接回收它——2026-09-06 实测：标签块放在 build 之后，执行时报 No such image，
# 回滚点当场丢失。先打标签再 build，标签会把旧镜像钉住不被回收。
# 停止的容器也有应保留的上一镜像。查询失败不等于首次部署，不能吞错后继续。
if ! app_container="$(compose ps -a -q app 2>/dev/null)"; then
  echo "无法确认原应用容器，回滚保护未建立；停止构建。" >&2
  exit 1
fi
if [ -z "$app_container" ]; then
  if [ "${SCM_INITIAL_DEPLOY:-0}" != "1" ]; then
    echo "未找到原应用容器，无法建立回滚点；只有确认全新空环境后才可使用 SCM_INITIAL_DEPLOY=1。" >&2
    exit 1
  fi
  echo "    已显式确认首次空环境部署，无原应用镜像"
else
  if [ "${SCM_INITIAL_DEPLOY:-0}" = "1" ]; then
    echo "已有应用容器，不能使用首次部署标记跳过备份与回滚保护。" >&2
    exit 1
  fi
  if [[ "$app_container" == *$'\n'* ]]; then
    echo "找到多个应用容器，回滚目标不唯一；请先核对部署范围。" >&2
    exit 1
  fi
  if ! running_image="$(docker inspect --format '{{.Image}}' "$app_container" 2>/dev/null)" ||
    [[ ! "$running_image" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "无法确认原应用镜像摘要，回滚保护未建立；停止构建。" >&2
    exit 1
  fi
  # 用旧镜像的完整内容摘要命名，不用新源码HEAD：同一源码重复部署不能覆盖不同旧镜像的回滚点。
  rollback_label="rollback-image-${running_image#sha256:}"
  if ! docker tag "$running_image" "supply-chain-app:${rollback_label}"; then
    echo "回滚镜像保存失败；停止构建，不执行迁移或重启。" >&2
    exit 1
  fi
  if ! rollback_image="$(docker image inspect --format '{{.Id}}' "supply-chain-app:${rollback_label}" 2>/dev/null)" ||
    [ "$rollback_image" != "$running_image" ]; then
    echo "回滚标签与原镜像摘要不一致或不可读取；停止构建。" >&2
    exit 1
  fi
  echo "    已验证 ${rollback_label} → ${running_image}"
fi
echo "==> 构建镜像"
# Only a clean repository-root checkout can claim a deployed source revision.
# Ignore any supplied revision variable: derive it from this actual build context.
if ! release_root="$(git rev-parse --show-toplevel 2>/dev/null)" || [ "$release_root" != "$(pwd -P)" ] ||
  ! release_revision="$(git rev-parse HEAD 2>/dev/null)" || [[ ! "$release_revision" =~ ^[0-9a-f]{40}$ ]] ||
  ! release_dirty="$(git status --porcelain=v1 -uall 2>/dev/null)" || [ -n "$release_dirty" ]; then
  echo "源码版本无法锚定或工作区有未提交内容；停止构建，不执行迁移或重启。" >&2
  exit 1
fi
# app 与 migrate 必须一起构建：预热（warm_read_models）跑在 migrate 服务里，只 build app 会让工具镜像
# 停在旧代码——run-job 一旦改过，预热就整批在 1 秒内"失败"，而预热失败按设计不阻断部署，
# 于是每次部署都静默预热失败（2026-09-05 手动部署时实测踩过）。
compose build --build-arg "SCM_BUILD_REVISION=$release_revision" app migrate
if ! finished_revision="$(git rev-parse HEAD 2>/dev/null)" || [ "$finished_revision" != "$release_revision" ] ||
  ! finished_dirty="$(git status --porcelain=v1 -uall 2>/dev/null)" || [ -n "$finished_dirty" ]; then
  echo "构建期间源码发生变化或无法复核；停止部署，不执行迁移或重启。" >&2
  exit 1
fi
echo "==> 启动/确认数据库"
compose up -d db
if [ "${SCM_INITIAL_DEPLOY:-0}" = "1" ]; then
  echo "==> 首次空环境部署：按显式 SCM_INITIAL_DEPLOY=1 跳过无意义的迁移前备份"
else
  echo "==> 迁移前完整备份（DB + 附件 + 异地副本）"
  ops/backup.sh
  ops/check-backup.sh
fi
echo "==> 迁移门禁（drizzle-kit migrate，对 prod 库）"
compose --profile tools run --rm migrate
echo "==> 滚动重启"
compose up -d

echo "==> 安装备份调度（systemd timer，幂等）"
install_backup_schedule() {
  local repo_dir sudo_cmd changed=0
  repo_dir=$(pwd)
  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /etc/systemd/system ]; then
    echo "    无 systemd——跳过；请按 ops/crontab.example 手工安装 cron 调度"
    return 0
  fi
  sudo_cmd=""
  if [ "$(id -u)" -ne 0 ]; then sudo_cmd="sudo"; fi
  local unit tmp
  for unit in backup.service backup.timer backup-check.service backup-check.timer; do
    tmp=$(mktemp)
    sed "s|__REPO_DIR__|$repo_dir|g" "ops/$unit" > "$tmp"
    if ! cmp -s "$tmp" "/etc/systemd/system/scm-$unit" 2>/dev/null; then
      $sudo_cmd cp "$tmp" "/etc/systemd/system/scm-$unit"
      echo "    已安装/更新 /etc/systemd/system/scm-$unit"
      changed=1
    else
      echo "    scm-$unit 无变化，跳过"
    fi
    rm -f "$tmp"
  done
  if [ "$changed" -eq 1 ]; then
    $sudo_cmd systemctl daemon-reload
  fi
  local timer
  for timer in scm-backup.timer scm-backup-check.timer; do
    if ! systemctl is-enabled --quiet "$timer" 2>/dev/null; then
      $sudo_cmd systemctl enable --now "$timer"
      echo "    已启用 $timer"
    else
      echo "    $timer 已启用"
    fi
  done
  echo "    scm-backup-check.timer 每小时验证 DB+附件配对、SHA-256、压缩结构与新鲜度"
}
install_backup_schedule

echo "==> 健康检查"
# 在同一Compose目标的app容器内检查，不误读宿主机3000上另一实例。
# 不跟随跳转、不复述响应/异常；旧版仅ok=true不够，数据库与迁移必须明确就绪。
APP_HEALTH_CHECK='fetch("http://127.0.0.1:3000/api/health", { signal: AbortSignal.timeout(5000), redirect: "error", cache: "no-store" })
  .then(async r => {
    const b = await r.json();
    if (!r.ok || b?.ok !== true || b.dbOk !== true || b.drift !== false || b.migrationState !== "current" ||
      !Number.isSafeInteger(b.migrationFiles) || b.migrationFiles <= 0 || b.applied !== b.migrationFiles ||
      !/^[0-9a-f]{40}$/.test(process.argv[1] || "") || b.build?.revision !== process.argv[1] ||
      !["git-clean", "build-arg"].includes(b.build?.source)) process.exit(1);
  }).catch(() => process.exit(1));'
healthy=0
for i in $(seq 1 30); do
  if compose exec -T app node -e "$APP_HEALTH_CHECK" "$release_revision" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
if [ "$healthy" -ne 1 ]; then
  echo "健康检查失败——检查 docker compose logs app" >&2
  exit 1
fi

# ==> 读模型预热（部署后第一个用户不该替全公司付一次全量重算的钱）
#
# 背景：读模型缓存键随口径升版（`report_read_model_cache` 的 key 带 /vN）。一次升版之后旧键
# 再没有读者，于是**部署后第一个打开页面的人**触发同步重算——爆单模型实测要几分钟，
# 期间他只看到页面转圈。缓存冷不是坏，只是慢，所以这里预热、并且**预热失败绝不让部署失败**。
#
# 为什么在容器里跑而不是宿主机：
#   - runner 镜像是 standalone 精简产物，**没有 tsx、也没有 src/**，跑不了 jobs/cli.ts；
#   - 宿主机**连不到库**：docker-compose.prod.yml 的 db 服务没有 `ports:`，
#     只在 compose 网络内以主机名 `db` 可达，宿主机上 `postgres://…@db:5432` 无法解析；
#     宿主仓库也不保证装了 node_modules。
#   - migrate 服务（migrator 阶段 = build 阶段）**同时具备三样东西**：完整 node_modules（含 tsx）、
#     源码，以及指向 db:5432 的 DATABASE_URL（迁移门禁用的就是它）。所以预热复用它。
# 任务名走 `run-job`，与调度器同一份白名单（INTERVAL_JOBS），并落 job_runs——
# 预热失败不会被伪装成"没跑过"，失败看门狗照常看得见。
# 护栏：tests/architecture/deploy-read-model-warm.test.ts
WARM_JOBS=${SCM_WARM_JOBS:-"inventory-position-refresh inventory-cover-watchdog sales-spike-watchdog transfer-cost-watchdog purchase-order-metrics supplier-payment-term"}
warm_read_models() {
  local job rc warmed=0 failed=0
  if [ "${SCM_SKIP_WARM:-0}" = "1" ]; then
    echo "    SCM_SKIP_WARM=1——跳过预热（缓存冷只是慢，不是坏）"
    return 0
  fi
  for job in $WARM_JOBS; do
    rc=0
    compose --profile tools run --rm -T migrate npx tsx src/jobs/cli.ts run-job "$job" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "    预热完成 $job"
      warmed=$((warmed + 1))
    else
      # 预热失败只记录：冷缓存会在第一个请求时自行重算，部署本身是成功的
      echo "    预热失败 $job（退出码 $rc）——已跳过，首个访问者会自行触发重算" >&2
      failed=$((failed + 1))
    fi
  done
  echo "    预热汇总：成功 $warmed，失败 $failed（失败不影响部署结论）"
  return 0
}
echo "==> 读模型预热"
warm_read_models

echo "部署完成 ✓"
exit 0
