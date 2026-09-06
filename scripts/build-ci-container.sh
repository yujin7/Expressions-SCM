#!/usr/bin/env bash
# CI builds the actual checkout (including GitHub's PR merge commit), never a guessed branch SHA.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! source_root="$(git rev-parse --show-toplevel 2>/dev/null)" || [ "$source_root" != "$(pwd -P)" ] ||
  ! source_revision="$(git rev-parse HEAD 2>/dev/null)" || [[ ! "$source_revision" =~ ^[0-9a-f]{40}$ ]] ||
  ! source_dirty="$(git status --porcelain=v1 -uall 2>/dev/null)" || [ -n "$source_dirty" ]; then
  echo "CI源码不明或不干净，拒绝构建。" >&2
  exit 1
fi
docker build --build-arg "SCM_BUILD_REVISION=$source_revision" --build-arg PUBLIC_HTTPS=1 --tag supply-chain:ci .
if ! finished_revision="$(git rev-parse HEAD 2>/dev/null)" || [ "$finished_revision" != "$source_revision" ] ||
  ! finished_dirty="$(git status --porcelain=v1 -uall 2>/dev/null)" || [ -n "$finished_dirty" ]; then
  echo "构建期间源码发生变化，CI构建不可验收。" >&2
  exit 1
fi
echo "CI构建源码版本：${source_revision}（未部署）"
