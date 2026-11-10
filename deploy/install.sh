#!/usr/bin/env bash
# Run as root from a checkout of this repo on Ubuntu 22.04+. Idempotent: safe to re-run to update.
# Usage: sudo ./deploy/install.sh [login-user-to-grant-socket-access]   (default: $SUDO_USER)
set -euo pipefail
ME=${1:-${SUDO_USER:-}}
SRC=$(cd "$(dirname "$0")/.." && pwd)
DST=/opt/remote-browser

id rbrowser &>/dev/null || useradd --system --home-dir /var/lib/remote-browser --shell /usr/sbin/nologin rbrowser
[ -n "$ME" ] && usermod -aG rbrowser "$ME"

mkdir -p "$DST"
cp -r "$SRC"/{server.js,url.js,package.json,package-lock.json,public} "$DST"/
(cd "$DST" && npm ci --omit=dev --silent && PLAYWRIGHT_BROWSERS_PATH="$DST/browsers" npx --no-install playwright-core install --with-deps chromium)
chown -R root:root "$DST"; chmod -R go+rX "$DST"

if [ ! -f /etc/remote-browser.env ]; then
  (umask 077; echo "RB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')" > /etc/remote-browser.env)
  echo "Generated a password: sudo cat /etc/remote-browser.env"
fi

# Also deny public addresses configured on this host. On NAT clouds (e.g. Oracle) there are none, so the public IP only exposes what is already public.
PUB=$(ip -o addr show scope global | awk '{print $4}' | grep -v '^10\.\|^172\.\(1[6-9]\|2.\|3[01]\)\.\|^192\.168\.\|^fd\|^fc' | sed 's#/.*#/32#; s#^\(.*:.*\)/32#\1/128#' | tr '\n' ' ' || true)
sed "s#^IPAddressDeny=.*#& $PUB#" "$SRC/deploy/remote-browser.service" > /etc/systemd/system/remote-browser.service
systemctl daemon-reload
systemctl enable remote-browser
systemctl restart remote-browser
echo "Running. Connect with: ssh -L 8080:/run/remote-browser/sock $ME@<this-host>  then open http://localhost:8080"
