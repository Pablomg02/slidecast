#!/usr/bin/env bash
# Starts syncdeck on this computer and opens the admin page in the browser.
# It runs until you press Ctrl+C or close the window.
#
#   ./start.sh             only this computer can connect
#   ./start.sh --network   also other devices on your network or Tailscale
#
# Decks go to ./decks and settings to ./.syncdeck (both git-ignored).
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

PORT="${SYNCDECK_PORT:-4321}"
HOST=127.0.0.1

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

open_url() {
  if command -v xdg-open >/dev/null; then xdg-open "$1" >/dev/null 2>&1 || true
  elif command -v open >/dev/null; then open "$1"
  else echo "Open $1 in your browser."
  fi
}

case "${1:-}" in
  '') ;;
  --network) HOST=0.0.0.0 ;;
  -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "unknown option: $1 (try --help)" ;;
esac

# Node.js installed with nvm is not on the PATH of menu launchers: load it.
if ! command -v node >/dev/null && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
fi
command -v node >/dev/null || die "Node.js not found; install Node.js 20 or newer"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node.js 20 or newer is needed (found $(node --version))"
[ -d node_modules ] || npm install --omit=dev --no-audit --no-fund --loglevel=error

# shellcheck disable=SC2016  # the template literal is JavaScript, not shell
up() { node -e 'fetch(`http://127.0.0.1:${process.argv[1]}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$PORT"; }

ADMIN="http://127.0.0.1:$PORT/admin"
if up; then
  echo "syncdeck is already running on port $PORT; opening it."
  open_url "$ADMIN"
  exit 0
fi

# Open the browser once the server answers.
( for _ in $(seq 1 40); do if up; then open_url "$ADMIN"; break; fi; sleep 0.25; done ) &

echo "Press Ctrl+C (or close this window) to stop syncdeck."
exec node bin/syncdeck.js serve --host "$HOST" --port "$PORT"
