#!/usr/bin/env bash
# Job Copilot dev runner — one command, clean restarts.
#
# Usage:
#   ./dev.sh            # start backend with reload
#   ./dev.sh --no-log   # don't tee to logs/dev.log
#
# What it does:
#   1. Kills any stale process holding :8000 (no more "address already in use")
#   2. Activates the local .venv
#   3. Verifies .env exists and key vars are present (warns, doesn't block)
#   4. Starts uvicorn with --reload watching the app/ directory
#   5. Tees stdout to logs/dev.log so you can grep history without scrolling
#
# Stop with Ctrl-C. To kill from another terminal: ./bin/stop.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT="${PORT:-8000}"
HOST="${HOST:-127.0.0.1}"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/dev.log"

# --- Color helpers (skip if not a tty) ---
if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_DIM=""; C_OFF=""
fi

log()  { printf "%s[dev]%s %s\n" "$C_DIM" "$C_OFF" "$*"; }
warn() { printf "%s[dev]%s %s\n" "$C_YEL" "$C_OFF" "$*"; }
err()  { printf "%s[dev]%s %s\n" "$C_RED" "$C_OFF" "$*" >&2; }
ok()   { printf "%s[dev]%s %s\n" "$C_GRN" "$C_OFF" "$*"; }

# --- 1. Free the port ---
if lsof -ti tcp:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  warn "Port $PORT is in use — killing the holder."
  lsof -ti tcp:"$PORT" -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
  sleep 0.3
fi

# --- 2. Activate venv ---
if [[ ! -x ".venv/bin/uvicorn" ]]; then
  err ".venv/bin/uvicorn not found. Run: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi
# shellcheck disable=SC1091
source .venv/bin/activate

# --- 3. .env sanity check (warn only) ---
if [[ ! -f ".env" ]]; then
  warn ".env not found — Notion sync will be disabled."
else
  for key in NOTION_API_KEY NOTION_DATABASE_ID; do
    if ! grep -q "^${key}=..*" .env; then
      warn "$key is empty in .env — Notion sync may fail."
    fi
  done
fi

# --- 4. Banner ---
mkdir -p "$LOG_DIR"
ok "Backend → http://$HOST:$PORT  (logs: $LOG_FILE)"
log "Watching app/ for changes. Ctrl-C to stop."

# --- 5. Run uvicorn ---
CMD=(uvicorn app.main:app --reload --reload-dir app --host "$HOST" --port "$PORT")

if [[ "${1:-}" == "--no-log" ]]; then
  exec "${CMD[@]}"
else
  # Pipe through tee, but make sure Ctrl-C still kills uvicorn cleanly.
  exec "${CMD[@]}" 2>&1 | tee -a "$LOG_FILE"
fi
