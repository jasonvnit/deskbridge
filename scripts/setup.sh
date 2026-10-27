#!/usr/bin/env bash
# One-time setup: checks tools, installs dependencies, builds the helper,
# creates .env, asks for macOS permissions and prepares the Cloudflare Tunnel.
#
# Usage: scripts/setup.sh [--skip-tunnel]
set -euo pipefail
source "$(dirname "$0")/lib.sh"

skip_tunnel=false
for arg in "$@"; do
  case "$arg" in
    --skip-tunnel) skip_tunnel=true ;;
    *) die "Unknown option: $arg" ;;
  esac
done

cd "$ROOT_DIR"

# ---- Tools ---------------------------------------------------------------------------
[[ "$(uname -s)" == "Darwin" ]] || die "DeskBridge only supports macOS."
macos_version="$(sw_vers -productVersion)"
version_ge "$macos_version" "13.0" || die "macOS 13 or newer is required (found $macos_version)."
ok "macOS $macos_version"

check_node
ok "Node.js $(node -p 'process.versions.node')"

command -v swift >/dev/null 2>&1 || die "Swift is not installed. Run: xcode-select --install"
ok "Swift $(swift --version 2>/dev/null | head -n1 | sed -E 's/.*Swift version ([0-9.]+).*/\1/')"

# ---- Dependencies and build ---------------------------------------------------------------
info "Installing Node.js dependencies…"
npm install --omit=dev --no-audit --no-fund --loglevel=error
ok "Dependencies installed"

info "Building the macOS helper (first build takes a minute)…"
swift build -c release --package-path helper-macos 2>&1 | grep -Ev "ld: warning: search path|^\[" || true
[[ -x "$HELPER_BIN" ]] || die "Helper build failed."
ok "Helper built: $HELPER_BIN"

# ---- .env ---------------------------------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ROOT_DIR/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  password="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  sed -i '' "s/^DESKBRIDGE_PASSWORD=.*/DESKBRIDGE_PASSWORD=$password/" "$ENV_FILE"
  ok "Created .env with a random password:"
  info "    ${C_BOLD}$password${C_RESET}"
  info "  Save it in your password manager. You can change it in .env at any time."
else
  ok ".env already exists (left unchanged)"
fi
load_env

# ---- macOS permissions --------------------------------------------------------------------------
read -r screen_ok access_ok < <(helper_permissions)
if [[ "$screen_ok" == "true" && "$access_ok" == "true" ]]; then
  ok "Screen Recording and Accessibility permissions are granted"
else
  warn "DeskBridge needs Screen Recording and Accessibility permissions."
  warn "macOS grants them to the terminal app that runs DeskBridge (Terminal, iTerm, …)."
  warn "Turn the switch on for that app, then restart the terminal app if macOS asks you to."
  "$HELPER_BIN" request-permissions >/dev/null || true
  [[ "$screen_ok" == "true" ]] || open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" 2>/dev/null || true
  [[ "$access_ok" == "true" ]] || open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" 2>/dev/null || true
fi

# ---- Cloudflare Tunnel ------------------------------------------------------------------------
if [[ "$skip_tunnel" == "true" || "$DESKBRIDGE_TUNNEL_MODE" == "none" ]]; then
  info "Skipping tunnel setup."
elif [[ "$DESKBRIDGE_TUNNEL_MODE" == "quick" ]]; then
  command -v cloudflared >/dev/null 2>&1 || die "cloudflared is not installed (brew install cloudflared)."
  ok "Quick tunnel mode: a random https://*.trycloudflare.com URL is created on every start"
else
  command -v cloudflared >/dev/null 2>&1 || die "cloudflared is not installed (brew install cloudflared)."
  if [[ -z "$DESKBRIDGE_TUNNEL_HOSTNAME" || "$DESKBRIDGE_TUNNEL_HOSTNAME" == "desk.example.com" ]]; then
    warn "Set DESKBRIDGE_TUNNEL_HOSTNAME in .env (e.g. desk.yourdomain.com), then run setup again."
    warn "No domain? Set DESKBRIDGE_TUNNEL_MODE=quick instead."
    exit 1
  fi

  if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
    info "Log in to Cloudflare in the browser window that opens and pick your domain…"
    cloudflared tunnel login
  fi
  ok "Logged in to Cloudflare"

  if cloudflared tunnel list --output json --name "$DESKBRIDGE_TUNNEL_NAME" 2>/dev/null | grep -q '"id"'; then
    ok "Tunnel \"$DESKBRIDGE_TUNNEL_NAME\" already exists"
  else
    cloudflared tunnel create "$DESKBRIDGE_TUNNEL_NAME"
    ok "Created tunnel \"$DESKBRIDGE_TUNNEL_NAME\""
  fi

  if cloudflared tunnel route dns "$DESKBRIDGE_TUNNEL_NAME" "$DESKBRIDGE_TUNNEL_HOSTNAME" >/dev/null 2>&1; then
    ok "DNS: $DESKBRIDGE_TUNNEL_HOSTNAME → tunnel \"$DESKBRIDGE_TUNNEL_NAME\""
  else
    warn "Could not create the DNS record for $DESKBRIDGE_TUNNEL_HOSTNAME."
    warn "If the record already points to this tunnel, you can ignore this. Otherwise check the DNS tab in Cloudflare."
  fi
fi

echo
ok "Setup finished. Start DeskBridge with: scripts/start.sh"
