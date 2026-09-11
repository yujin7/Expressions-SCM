#!/usr/bin/env bash
# Sourced by the installer and daemon. Only the existing Compose app may be reconfigured.
# No source build, pull, database start, or migration belongs to public-access setup.
# shellcheck source=scripts/app-operation-lock.sh
source "$(dirname "${BASH_SOURCE[0]}")/app-operation-lock.sh" || return 1
tunnel_compose() {
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_PROD" -f "$COMPOSE_LOCAL" "$@"
}

TUNNEL_APP_HEALTH='fetch("http://127.0.0.1:3000/api/health", { signal: AbortSignal.timeout(5000), redirect: "error", cache: "no-store" })
  .then(async r => {
    const b = await r.json();
    const hsts = r.headers.get("strict-transport-security") || "";
    if (!r.ok || b?.ok !== true || b.dbOk !== true || b.drift !== false || b.migrationState !== "current" ||
      !Number.isSafeInteger(b.migrationFiles) || b.migrationFiles <= 0 || b.applied !== b.migrationFiles ||
      !/^[0-9a-f]{40}$/.test(b.build?.revision || "") || !["git-clean", "build-arg"].includes(b.build?.source) ||
      !/(?:^|;)\s*max-age=[1-9][0-9]*(?:\s*;|\s*$)/i.test(hsts)) process.exit(1);
    process.stdout.write(b.build.revision);
  }).catch(() => process.exit(1));'

tunnel_capture_app() {
  TUNNEL_APP_CONTAINER="" TUNNEL_APP_IMAGE="" TUNNEL_APP_REVISION=""
  TUNNEL_APP_CONTAINER="$(tunnel_compose ps -q app 2>/dev/null)" || return 1
  [[ -n "$TUNNEL_APP_CONTAINER" && "$TUNNEL_APP_CONTAINER" != *$'\n'* ]] || return 1
  TUNNEL_APP_IMAGE="$(docker inspect --format '{{.Image}}' "$TUNNEL_APP_CONTAINER" 2>/dev/null)" || return 1
  [[ "$TUNNEL_APP_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  TUNNEL_APP_REVISION="$(docker exec "$TUNNEL_APP_CONTAINER" node -e "$TUNNEL_APP_HEALTH" 2>/dev/null)" || return 1
  [[ "$TUNNEL_APP_REVISION" =~ ^[0-9a-f]{40}$ ]] || return 1
  # A concurrent deployment must not mix one container's image with another's health.
  [[ "$(tunnel_compose ps -q app 2>/dev/null)" == "$TUNNEL_APP_CONTAINER" ]] || return 1
}

tunnel_sync_url() {
  local url="$1" pin_file current_container rc=0
  [[ "$url" =~ ^https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com$ ]] || return 1
  app_operation_acquire tunnel_compose || return $?
  tunnel_capture_app || return 1
  TUNNEL_EXPECTED_IMAGE="$TUNNEL_APP_IMAGE"
  TUNNEL_EXPECTED_REVISION="$TUNNEL_APP_REVISION"
  pin_file="$(mktemp "$RUNTIME_DIR/.app-image.XXXXXX")" || return 1
  if ! printf 'services:\n  app:\n    image: "%s"\n' "$TUNNEL_EXPECTED_IMAGE" > "$pin_file"; then
    rm -f "$pin_file"
    return 1
  fi
  current_container="$(tunnel_compose ps -q app 2>/dev/null)" || rc=1
  if [[ "$rc" == 0 && "$current_container" == "$TUNNEL_APP_CONTAINER" ]]; then
    # Pin the actual running image digest, not supply-chain-app:latest. --no-deps
    # also prevents this access-only operation from creating/reconfiguring the database.
    AUTH_URL="$url" tunnel_compose -f "$pin_file" up -d --no-build --no-deps --pull never app >/dev/null 2>&1 || rc=1
  else
    rc=1
  fi
  rm -f "$pin_file"
  return "$rc"
}

tunnel_verify_same_app() {
  tunnel_capture_app || return 1
  [[ "$TUNNEL_APP_IMAGE" == "$TUNNEL_EXPECTED_IMAGE" && "$TUNNEL_APP_REVISION" == "$TUNNEL_EXPECTED_REVISION" ]]
}
