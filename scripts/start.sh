#!/usr/bin/env bash
# Starts DeskBridge: local server, Cloudflare Tunnel and sleep prevention.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

load_env
ensure_dirs

[[ "$(uname -s)" == "Darwin" ]] || die "DeskBridge only supports macOS."
check_node
[[ -x "$HELPER_BIN" ]] || die "The helper is not built yet. Run scripts/setup.sh first."
[[ -f "$ENV_FILE" ]] || die "Missing $ENV_FILE. Run scripts/setup.sh first."
[[ ${#DESKBRIDGE_PASSWORD} -ge 12 ]] || die "DESKBRIDGE_PASSWORD in .env must be at least 12 characters."

if running_pid server >/dev/null; then
  warn "DeskBridge is already running."
  exec "$ROOT_DIR/scripts/status.sh"
fi

# ---- Permissions --------------------------------------------------------------
read -r screen_ok access_ok < <(helper_permissions)
if [[ "$screen_ok" != "true" || "$access_ok" != "true" ]]; then
  warn "macOS permissions are missing (Screen Recording: $screen_ok, Accessibility: $access_ok)."
  warn "Grant them to the terminal app you run this script from, then run start again."
  warn "System Settings → Privacy & Security → Screen & System Audio Recording / Accessibility."
  "$HELPER_BIN" request-permissions >/dev/null || true
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" 2>/dev/null || true
  exit 1
fi

# ---- Tunnel prerequisites -------------------------------------------------------
tunnel_id=""
if [[ "$DESKBRIDGE_TUNNEL_MODE" == "named" || "$DESKBRIDGE_TUNNEL_MODE" == "quick" ]]; then
  command -v cloudflared >/dev/null 2>&1 || die "cloudflared is not installed (brew install cloudflared)."
fi
if [[ "$DESKBRIDGE_TUNNEL_MODE" == "named" ]]; then
  [[ -n "$DESKBRIDGE_TUNNEL_HOSTNAME" && "$DESKBRIDGE_TUNNEL_HOSTNAME" != "desk.example.com" ]] \
    || die "Set DESKBRIDGE_TUNNEL_HOSTNAME in .env (or use DESKBRIDGE_TUNNEL_MODE=quick)."
  tunnel_id="$(cloudflared tunnel list --output json --name "$DESKBRIDGE_TUNNEL_NAME" 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const list = JSON.parse(s); console.log(list[0]?.id ?? ""); } catch { console.log(""); }
    });')"
  [[ -n "$tunnel_id" ]] || die "Tunnel \"$DESKBRIDGE_TUNNEL_NAME\" not found. Run scripts/setup.sh to create it."
  credentials="$HOME/.cloudflared/$tunnel_id.json"
  [[ -f "$credentials" ]] || die "Tunnel credentials not found at $credentials."
fi

# ---- Server -------------------------------------------------------------------------
if lsof -nP -iTCP:"$DESKBRIDGE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "Port $DESKBRIDGE_PORT is already in use by another program. Change DESKBRIDGE_PORT in .env or stop that program."
fi

info "Starting server on http://$DESKBRIDGE_HOST:$DESKBRIDGE_PORT …"
nohup node "$ROOT_DIR/server/src/main.ts" >>"$LOG_DIR/server.log" 2>&1 &
server_pid=$!
echo "$server_pid" >"$(pid_file server)"
disown "$server_pid" 2>/dev/null || true

healthy=false
for _ in $(seq 1 50); do
  if curl -fsS "http://$DESKBRIDGE_HOST:$DESKBRIDGE_PORT/api/health" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  kill -0 "$server_pid" 2>/dev/null || break
  sleep 0.2
done
kill -0 "$server_pid" 2>/dev/null || healthy=false
if [[ "$healthy" != "true" ]]; then
  tail -n 20 "$LOG_DIR/server.log" >&2 || true
  stop_process server >/dev/null
  die "The server did not start. See $LOG_DIR/server.log"
fi
ok "Server is running (pid $server_pid)"

# Keep the Mac awake while the server runs; caffeinate exits on its own when the server stops.
nohup caffeinate -dimsu -w "$server_pid" >/dev/null 2>&1 &
echo $! >"$(pid_file caffeinate)"
disown $! 2>/dev/null || true
ok "Sleep prevention is on"

# ---- Tunnel -------------------------------------------------------------------------
tunnel_log="$LOG_DIR/cloudflared.log"
case "$DESKBRIDGE_TUNNEL_MODE" in
  named)
    config="$RUN_DIR/cloudflared.yml"
    cat >"$config" <<EOF
tunnel: $tunnel_id
credentials-file: $credentials
no-autoupdate: true
ingress:
  - hostname: $DESKBRIDGE_TUNNEL_HOSTNAME
    service: http://$DESKBRIDGE_HOST:$DESKBRIDGE_PORT
  - service: http_status:404
EOF
    : >"$tunnel_log"
    nohup cloudflared tunnel --config "$config" run >>"$tunnel_log" 2>&1 &
    ;;
  quick)
    config="$RUN_DIR/cloudflared-quick.yml"
    echo "no-autoupdate: true" >"$config"
    rm -f "$RUN_DIR/quick-url"
    : >"$tunnel_log"
    nohup cloudflared tunnel --config "$config" --url "http://$DESKBRIDGE_HOST:$DESKBRIDGE_PORT" >>"$tunnel_log" 2>&1 &
    ;;
  none)
    ;;
  *)
    die "Unknown DESKBRIDGE_TUNNEL_MODE: $DESKBRIDGE_TUNNEL_MODE (use named, quick or none)."
    ;;
esac

if [[ "$DESKBRIDGE_TUNNEL_MODE" != "none" ]]; then
  tunnel_pid=$!
  echo "$tunnel_pid" >"$(pid_file tunnel)"
  disown "$tunnel_pid" 2>/dev/null || true

  connected=false
  for _ in $(seq 1 60); do
    kill -0 "$tunnel_pid" 2>/dev/null || break
    if [[ "$DESKBRIDGE_TUNNEL_MODE" == "quick" ]]; then
      url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$tunnel_log" | head -n1 || true)"
      if [[ -n "$url" ]]; then
        echo "$url" >"$RUN_DIR/quick-url"
        connected=true
        break
      fi
    elif grep -q "Registered tunnel connection" "$tunnel_log"; then
      connected=true
      break
    fi
    sleep 0.5
  done

  if [[ "$connected" == "true" ]]; then
    ok "Cloudflare Tunnel is connected (pid $tunnel_pid)"
  else
    tail -n 20 "$tunnel_log" >&2 || true
    warn "The tunnel did not report a connection yet. See $tunnel_log"
  fi
fi

url="$(public_url)"
echo
info "${C_BOLD}DeskBridge is running.${C_RESET}"
info "  Open: ${C_BOLD}${url}${C_RESET}"
info "  Stop: scripts/stop.sh"
if command -v qrencode >/dev/null 2>&1 && [[ -n "$url" ]]; then
  echo
  qrencode -t ansiutf8 "$url"
fi
