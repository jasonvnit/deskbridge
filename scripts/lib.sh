#!/usr/bin/env bash
# Shared helpers for the DeskBridge scripts. Source this file; do not run it.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${DESKBRIDGE_ENV_FILE:-$ROOT_DIR/.env}"
STATE_DIR="${DESKBRIDGE_STATE_DIR:-$HOME/.deskbridge}"
RUN_DIR="$STATE_DIR/run"
LOG_DIR="$STATE_DIR/logs"
HELPER_BIN="$ROOT_DIR/helper-macos/.build/release/deskbridge-helper"
MIN_NODE_VERSION="22.18.0"

if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_BOLD=""; C_RESET=""
fi

info() { printf '%s\n' "$*"; }
ok() { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die() { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

load_env() {
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
  DESKBRIDGE_HOST="${DESKBRIDGE_HOST:-127.0.0.1}"
  DESKBRIDGE_PORT="${DESKBRIDGE_PORT:-8765}"
  DESKBRIDGE_TUNNEL_MODE="${DESKBRIDGE_TUNNEL_MODE:-named}"
  DESKBRIDGE_TUNNEL_NAME="${DESKBRIDGE_TUNNEL_NAME:-deskbridge}"
  DESKBRIDGE_TUNNEL_HOSTNAME="${DESKBRIDGE_TUNNEL_HOSTNAME:-}"
}

ensure_dirs() {
  mkdir -p "$RUN_DIR" "$LOG_DIR"
  chmod 700 "$STATE_DIR"
}

pid_file() { printf '%s/%s.pid' "$RUN_DIR" "$1"; }

# Prints the PID of a managed process if it is still alive.
running_pid() {
  local file
  file="$(pid_file "$1")"
  [[ -f "$file" ]] || return 1
  local pid
  pid="$(cat "$file")"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    printf '%s' "$pid"
    return 0
  fi
  rm -f "$file"
  return 1
}

stop_process() {
  local name="$1" pid
  pid="$(running_pid "$name")" || { rm -f "$(pid_file "$name")"; return 0; }
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$(pid_file "$name")"
  ok "Stopped $name (pid $pid)"
}

version_ge() {
  # Returns success when $1 >= $2 (dotted versions).
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

check_node() {
  command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install Node.js $MIN_NODE_VERSION or newer (e.g. brew install node)."
  local version
  version="$(node -p 'process.versions.node')"
  version_ge "$version" "$MIN_NODE_VERSION" || die "Node.js $version is too old; DeskBridge needs $MIN_NODE_VERSION or newer."
}

# Prints "screenRecording accessibility" as true/false words.
helper_permissions() {
  "$HELPER_BIN" permissions | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const p = JSON.parse(s); console.log(`${p.screenRecording} ${p.accessibility}`);
    });'
}

# Runs cloudflared management commands with an empty config file, so a tunnel set in
# ~/.cloudflared/config.yml cannot override the DeskBridge tunnel name.
cf() {
  ensure_dirs
  local config="$RUN_DIR/cloudflared-cli.yml"
  [[ -f "$config" ]] || echo "no-autoupdate: true" >"$config"
  cloudflared --config "$config" "$@"
}

public_url() {
  case "$DESKBRIDGE_TUNNEL_MODE" in
    named) printf 'https://%s' "$DESKBRIDGE_TUNNEL_HOSTNAME" ;;
    quick) [[ -f "$RUN_DIR/quick-url" ]] && cat "$RUN_DIR/quick-url" ;;
    *) printf 'http://%s:%s' "$DESKBRIDGE_HOST" "$DESKBRIDGE_PORT" ;;
  esac
}
