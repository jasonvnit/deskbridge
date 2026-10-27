#!/usr/bin/env bash
# Stops DeskBridge: tunnel first (cuts remote access), then the server and sleep prevention.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

load_env
ensure_dirs

stop_process tunnel
stop_process server
stop_process caffeinate
rm -f "$RUN_DIR/quick-url"

# Safety net for processes started by an older run whose PID files were lost.
leftover="$(pgrep -f "$ROOT_DIR/server/src/main.ts" || true)"
if [[ -n "$leftover" ]]; then
  kill $leftover 2>/dev/null || true
  ok "Stopped leftover server process(es): $leftover"
fi
leftover="$(pgrep -f "cloudflared tunnel --config $RUN_DIR/" || true)"
if [[ -n "$leftover" ]]; then
  kill $leftover 2>/dev/null || true
  ok "Stopped leftover tunnel process(es): $leftover"
fi

ok "DeskBridge is stopped. Remote control is off."
