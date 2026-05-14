#!/usr/bin/env bash
# Kill anything holding the dev port. Use when ./dev.sh got orphaned.
set -euo pipefail
PORT="${PORT:-8000}"
pids="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -z "$pids" ]]; then
  echo "[stop] nothing listening on :$PORT"
  exit 0
fi
echo "[stop] killing $(echo "$pids" | tr '\n' ' ')"
echo "$pids" | xargs kill -9 2>/dev/null || true
echo "[stop] done"
