#!/usr/bin/env bash
# Shows whether DeskBridge is running and where to reach it.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

load_env
ensure_dirs

show() {
  local name="$1" label="$2" pid
  if pid="$(running_pid "$name")"; then
    ok "$label running (pid $pid)"
  else
    warn "$label not running"
  fi
}

show server "Server     "
if [[ "$DESKBRIDGE_TUNNEL_MODE" != "none" ]]; then
  show tunnel "Tunnel     "
fi
show caffeinate "Keep awake "

if running_pid server >/dev/null; then
  echo
  info "  URL:  $(public_url)"
  info "  Logs: $LOG_DIR"
fi
