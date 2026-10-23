#!/usr/bin/env bash
# First-time install of syncdeck on a Raspberry Pi (Raspberry Pi OS / Debian),
# as a systemd service published through Cloudflare Tunnel.
#
#   curl -fsSL https://raw.githubusercontent.com/Pablomg02/syncdeck/main/deploy/install.sh | sudo bash
#   # or, from a clone:  sudo bash deploy/install.sh
#
# Safe to run again: every step checks what is already there.
#
# Optional environment variables:
#   TUNNEL_TOKEN     token of a tunnel created in the Cloudflare dashboard
#                    (asked for if missing; leave empty to skip the tunnel)
#   SYNCDECK_REPO    git URL      (default: https://github.com/Pablomg02/syncdeck.git)
#   SYNCDECK_BRANCH  branch       (default: main)
#   SYNCDECK_PORT    local port   (default: 4321)
set -euo pipefail

REPO="${SYNCDECK_REPO:-https://github.com/Pablomg02/syncdeck.git}"
BRANCH="${SYNCDECK_BRANCH:-main}"
PORT="${SYNCDECK_PORT:-4321}"
APP_DIR=/opt/syncdeck
DATA_DIR=/var/lib/syncdeck
STATE_DIR="$DATA_DIR/state"
DECKS_DIR="$DATA_DIR/decks"
SERVICE_USER=syncdeck
NODE_MAJOR=22

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok() { printf '    \033[32mok\033[0m  %s\n' "$*"; }
warn() { printf '    \033[33m!!\033[0m  %s\n' "$*"; }
die() { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Prompts read from the terminal, also when the script itself comes from a pipe.
have_tty() { [ -r /dev/tty ] && [ -w /dev/tty ] && : </dev/tty 2>/dev/null; }
ask() { local answer=''; if have_tty; then read -r -p "$1" answer </dev/tty || true; fi; printf '%s' "$answer"; }

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
say "syncdeck code in $APP_DIR"
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
syncdeck_cli() { sudo -u "$SERVICE_USER" /usr/bin/node "$APP_DIR/bin/syncdeck.js" "$@"; }
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
    until syncdeck_cli passwd "$role" --state "$STATE_DIR" </dev/tty; do echo "    Try again."; done
    ok "$role password set"
  else
    warn "no terminal to ask for the $role password; set it later with:"
    warn "  sudo -u $SERVICE_USER node $APP_DIR/bin/syncdeck.js passwd $role --state $STATE_DIR"
  fi
done

# ---- systemd service ----------------------------------------------------------
say "systemd service"
unit=/etc/systemd/system/syncdeck.service
sed "s/^Environment=SYNCDECK_PORT=.*/Environment=SYNCDECK_PORT=$PORT/" "$APP_DIR/deploy/syncdeck.service" > "$unit.new"
mv "$unit.new" "$unit"
systemctl daemon-reload
systemctl enable --quiet syncdeck
systemctl restart syncdeck
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
if [ "$healthy" -ne 1 ]; then
  journalctl -u syncdeck -n 30 --no-pager >&2 || true
  die "syncdeck did not answer on http://127.0.0.1:$PORT/health (log above)"
fi
ok "syncdeck is running and answers on http://127.0.0.1:$PORT"
ln -sf "$APP_DIR/deploy/update.sh" /usr/local/bin/syncdeck-update
ok "update later with: sudo syncdeck-update"

# ---- Cloudflare Tunnel --------------------------------------------------------
say "Cloudflare Tunnel"
if systemctl list-unit-files cloudflared.service >/dev/null 2>&1 \
  && systemctl list-unit-files cloudflared.service | grep -q cloudflared; then
  systemctl is-active --quiet cloudflared || systemctl restart cloudflared
  if systemctl is-active --quiet cloudflared; then ok "cloudflared service already installed and running"
  else warn "cloudflared is installed but not running: journalctl -u cloudflared"; fi
else
  token="${TUNNEL_TOKEN:-}"
  if [ -z "$token" ]; then
    echo "    Create a tunnel in the Cloudflare dashboard (Zero Trust > Networks > Tunnels >"
    echo "    Create a tunnel > Cloudflared) and paste its token here (empty to skip)."
    token="$(ask '    Tunnel token: ')"
  fi
  if [ -z "$token" ]; then
    warn "skipped; run this script again with TUNNEL_TOKEN=... to add the tunnel"
  else
    if ! command -v cloudflared >/dev/null; then
      install -d -m 0755 /usr/share/keyrings
      curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
      echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
        > /etc/apt/sources.list.d/cloudflared.list
      apt-get update -qq
      apt-get install -y -qq cloudflared >/dev/null
    fi
    cloudflared service install "$token" >/dev/null 2>&1 || die "cloudflared service install failed"
    sleep 3
    if systemctl is-active --quiet cloudflared; then ok "cloudflared installed and running"
    else warn "cloudflared did not start: journalctl -u cloudflared"; fi
  fi
fi

say "Done"
cat <<EOF
    In the tunnel's "Public hostname" tab (Cloudflare dashboard), point your
    hostname to:  http://localhost:$PORT
    Then open https://<your hostname>/admin and upload a deck.
    Recommended: Cloudflare Access and a bot check (docs/deploy-raspberry.md).
EOF
