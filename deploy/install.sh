#!/usr/bin/env bash
# First-time install of slidecast on a Raspberry Pi (Raspberry Pi OS / Debian),
# as a systemd service listening on 127.0.0.1. Publishing it on the Internet
# (Cloudflare Tunnel) is a separate step: see docs/deploy-raspberry.md.
#
#   curl -fsSL https://raw.githubusercontent.com/Pablomg02/slidecast/main/deploy/install.sh | sudo bash
#   # or, from a clone:  sudo bash deploy/install.sh
#
# Safe to run again: every step checks what is already there.
#
# Optional environment variables:
#   SLIDECAST_REPO    git URL      (default: https://github.com/Pablomg02/slidecast.git)
#   SLIDECAST_BRANCH  branch       (default: main)
#   SLIDECAST_PORT    local port   (default: 4321)
set -euo pipefail

REPO="${SLIDECAST_REPO:-https://github.com/Pablomg02/slidecast.git}"
BRANCH="${SLIDECAST_BRANCH:-main}"
PORT="${SLIDECAST_PORT:-4321}"
APP_DIR=/opt/slidecast
DATA_DIR=/var/lib/slidecast
STATE_DIR="$DATA_DIR/state"
DECKS_DIR="$DATA_DIR/decks"
SERVICE_USER=slidecast
NODE_MAJOR=22

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok() { printf '    \033[32mok\033[0m  %s\n' "$*"; }
warn() { printf '    \033[33m!!\033[0m  %s\n' "$*"; }
die() { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Prompts read from the terminal, also when the script itself comes from a pipe.
have_tty() { [ -r /dev/tty ] && [ -w /dev/tty ] && : </dev/tty 2>/dev/null; }

[ "$(id -u)" -eq 0 ] || die "run it with sudo: sudo bash $0"
command -v apt-get >/dev/null || die "this script needs a Debian-based system (Raspberry Pi OS)"
command -v systemctl >/dev/null || die "this script needs systemd"

# ---- packages ---------------------------------------------------------------
say "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg >/dev/null
ok "git, curl"

node_major() { /usr/bin/node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 20 ]; then
  say "Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
[ "$(node_major)" -ge 20 ] || die "Node.js 20 or newer is needed at /usr/bin/node"
ok "node $(/usr/bin/node --version)"

# ---- code -------------------------------------------------------------------
say "slidecast code in $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  ok "already cloned ($(git -C "$APP_DIR" rev-parse --short HEAD)); use update.sh to update it"
else
  [ ! -e "$APP_DIR" ] || die "$APP_DIR exists and is not a git clone; move it away first"
  git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
  ok "cloned $REPO ($BRANCH)"
fi
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
ok "dependencies installed"

# ---- user and folders -------------------------------------------------------
say "Service user and data folders"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
mkdir -p "$DECKS_DIR" "$STATE_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chmod 700 "$STATE_DIR"
ok "user $SERVICE_USER, decks in $DECKS_DIR, state in $STATE_DIR"

# ---- passwords --------------------------------------------------------------
slidecast_cli() { sudo -u "$SERVICE_USER" /usr/bin/node "$APP_DIR/bin/slidecast.js" "$@"; }
has_password() {
  [ -f "$STATE_DIR/config.json" ] && /usr/bin/node -e \
    'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(c[process.argv[2]] ? 0 : 1)' \
    "$STATE_DIR/config.json" "$1"
}
say "Passwords (8+ characters, at least one letter and one digit)"
for role in admin presenter; do
  if has_password "${role}Hash"; then
    ok "$role password already set"
  elif have_tty; then
    echo "    Choose the $role password:"
    until slidecast_cli passwd "$role" --state "$STATE_DIR" </dev/tty; do echo "    Try again."; done
    ok "$role password set"
  else
    warn "no terminal to ask for the $role password; set it later with:"
    warn "  sudo -u $SERVICE_USER node $APP_DIR/bin/slidecast.js passwd $role --state $STATE_DIR"
  fi
done

# ---- systemd service ----------------------------------------------------------
say "systemd service"
unit=/etc/systemd/system/slidecast.service
sed "s/^Environment=SLIDECAST_PORT=.*/Environment=SLIDECAST_PORT=$PORT/" "$APP_DIR/deploy/slidecast.service" > "$unit.new"
mv "$unit.new" "$unit"
systemctl daemon-reload
systemctl enable --quiet slidecast
systemctl restart slidecast
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
if [ "$healthy" -ne 1 ]; then
  journalctl -u slidecast -n 30 --no-pager >&2 || true
  die "slidecast did not answer on http://127.0.0.1:$PORT/health (log above)"
fi
ok "slidecast is running and answers on http://127.0.0.1:$PORT"
ln -sf "$APP_DIR/deploy/update.sh" /usr/local/bin/slidecast-update
ok "update later with: sudo slidecast-update"

say "Done"
cat <<EOF
    slidecast answers on http://127.0.0.1:$PORT (this machine only).
    To publish it on the Internet, set up Cloudflare Tunnel and point your
    hostname to http://localhost:$PORT: see docs/deploy-raspberry.md.
EOF
