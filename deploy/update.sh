#!/usr/bin/env bash
# Updates an install made with deploy/install.sh to the latest code on GitHub
# and restarts it. If the new version does not come up healthy, it goes back
# to the previous one and restarts that instead.
#
#   sudo syncdeck-update            # same as: sudo bash /opt/syncdeck/deploy/update.sh
#   sudo syncdeck-update --force    # reinstall and restart even if up to date
#
# Before updating, the state folder (passwords, settings) is copied to
# /var/lib/syncdeck/backups/ (the last 5 copies are kept).
set -euo pipefail

BRANCH="${SYNCDECK_BRANCH:-main}"
APP_DIR="${SYNCDECK_APP_DIR:-/opt/syncdeck}"
DATA_DIR="${SYNCDECK_DATA_DIR:-/var/lib/syncdeck}"
STATE_DIR="$DATA_DIR/state"
BACKUP_DIR="$DATA_DIR/backups"
UNIT="${SYNCDECK_UNIT:-/etc/systemd/system/syncdeck.service}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok() { printf '    \033[32mok\033[0m  %s\n' "$*"; }
warn() { printf '    \033[33m!!\033[0m  %s\n' "$*"; }
die() { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run it with sudo: sudo $0"
[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a syncdeck clone; install first with deploy/install.sh"
[ -f "$UNIT" ] || die "$UNIT is missing; install first with deploy/install.sh"
PORT="$(sed -n 's/^Environment=SYNCDECK_PORT=//p' "$UNIT")"
PORT="${PORT:-4321}"

healthy() {
  for _ in $(seq 1 "${1:-30}"); do
    if systemctl is-active --quiet syncdeck && curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Installs the code at HEAD: dependencies, the unit file (keeping the port), restart.
deploy_head() {
  (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
  sed "s/^Environment=SYNCDECK_PORT=.*/Environment=SYNCDECK_PORT=$PORT/" "$APP_DIR/deploy/syncdeck.service" > "$UNIT.new"
  mv "$UNIT.new" "$UNIT"
  systemctl daemon-reload
  systemctl restart syncdeck
}

cd "$APP_DIR"
say "Fetching $BRANCH from GitHub"
[ -z "$(git status --porcelain --untracked-files=no)" ] \
  || die "there are local changes in $APP_DIR (git status); undo them before updating"
git fetch --quiet origin "$BRANCH"
old="$(git rev-parse HEAD)"
new="$(git rev-parse FETCH_HEAD)"

if [ "$old" = "$new" ] && [ "$FORCE" -eq 0 ]; then
  ok "already up to date ($(git rev-parse --short HEAD))"
  if healthy 5; then ok "syncdeck running"
  else
    warn "syncdeck was not answering: restarting it"
    systemctl restart syncdeck
    healthy 30 || die "syncdeck does not start: journalctl -u syncdeck -n 50"
    ok "syncdeck running"
  fi
  exit 0
fi

git merge-base --is-ancestor "$old" "$new" \
  || die "the GitHub branch is not a continuation of this copy; nothing changed"
echo "    $(git rev-parse --short "$old") -> $(git rev-parse --short "$new"):"
git --no-pager log --oneline "$old..$new" | sed 's/^/      /'

say "Backing up the state folder"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
backup="$BACKUP_DIR/state-$(date +%Y%m%d-%H%M%S)"
cp -a "$STATE_DIR" "$backup"
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -name 'state-*' | sort | head -n -5 | xargs -r rm -rf
ok "$backup"

say "Installing the new version"
git merge --quiet --ff-only "$new"
deploy_head
if healthy 30; then
  ok "syncdeck $(git rev-parse --short HEAD) is running"
  say "Done"
  exit 0
fi

journalctl -u syncdeck -n 30 --no-pager >&2 || true
say "The new version did not start: going back to $(git rev-parse --short "$old")"
git reset --quiet --hard "$old"
deploy_head
if healthy 30; then
  ok "previous version running again"
  die "update failed (log above); syncdeck is back on the previous version"
fi
die "update failed and the previous version does not start either: journalctl -u syncdeck -n 50; state backup in $backup"
