#!/usr/bin/env bash
# Run as root from a checkout of this repo on Ubuntu 22.04+. Idempotent: safe to re-run to update.
# Usage: sudo [DOMAIN=rb.example.com] [VNC=10.147.20.2:5900] ./deploy/install.sh [login-user-to-grant-socket-access]
# PROXY=host:port sends browser traffic through a SOCKS5 exit (see tools/mac-exit), falling back to direct if it is down.
# DOMAIN sets up nginx + a Let's Encrypt cert. VNC enables the /vnc.html viewer for that host:port.
set -euo pipefail
ME=${1:-${SUDO_USER:-}}
SRC=$(cd "$(dirname "$0")/.." && pwd)
DST=/opt/remote-browser

id rbrowser &>/dev/null || useradd --system --home-dir /var/lib/remote-browser --shell /usr/sbin/nologin rbrowser
[ -n "$ME" ] && usermod -aG rbrowser "$ME"

mkdir -p "$DST"
cp -r "$SRC"/{server.js,url.js,totp.js,userscripts.js,package.json,package-lock.json,public} "$DST"/
(cd "$DST" && npm ci --omit=dev --silent && PLAYWRIGHT_BROWSERS_PATH="$DST/browsers" npx --no-install playwright-core install --with-deps chromium)
chown -R root:root "$DST"; chmod -R go+rX "$DST"

if [ ! -f /etc/remote-browser.env ]; then
  (umask 077; echo "RB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')" > /etc/remote-browser.env)
  echo "Generated a password: sudo cat /etc/remote-browser.env"
fi

touch /etc/remote-browser.env; chmod 600 /etc/remote-browser.env
grep -q '^RB_TOTP_SECRET=' /etc/remote-browser.env || echo "RB_TOTP_SECRET=$(head -c20 /dev/urandom | base32 | tr -d =)" >> /etc/remote-browser.env
[ -n "${VNC:-}" ] && { sed -i '/^RB_VNC=/d' /etc/remote-browser.env; echo "RB_VNC=$VNC" >> /etc/remote-browser.env; }
[ -n "${PROXY:-}" ] && { sed -i '/^RB_PROXY=/d' /etc/remote-browser.env; echo "RB_PROXY=$PROXY" >> /etc/remote-browser.env; }
ALLOW_IPS=$(grep -E '^RB_(VNC|PROXY)=' /etc/remote-browser.env | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | sort -u | sed 's#$#/32#' | tr '\n' ' ' || true)

# Also deny public addresses configured on this host. On NAT clouds (e.g. Oracle) there are none, so the public IP only exposes what is already public.
PUB=$(ip -o addr show scope global | awk '{print $4}' | grep -v '^10\.\|^172\.\(1[6-9]\|2.\|3[01]\)\.\|^192\.168\.\|^fd\|^fc' | sed 's#/.*#/32#; s#^\(.*:.*\)/32#\1/128#' | tr '\n' ' ' || true)
sed "s#^IPAddressDeny=.*#& $PUB#; ${ALLOW_IPS:+s#^IPAddressAllow=.*#& $ALLOW_IPS#}" "$SRC/deploy/remote-browser.service" > /etc/systemd/system/remote-browser.service
systemctl daemon-reload
systemctl enable remote-browser
systemctl restart remote-browser
if [ -n "${DOMAIN:-}" ]; then
  usermod -aG rbrowser www-data
  sed "s#__DOMAIN__#$DOMAIN#" "$SRC/deploy/nginx.conf" > /etc/nginx/sites-available/remote-browser
  ln -sf /etc/nginx/sites-available/remote-browser /etc/nginx/sites-enabled/remote-browser
  nginx -t || { rm -f /etc/nginx/sites-enabled/remote-browser; echo 'nginx config invalid, rolled back'; exit 1; }
  systemctl restart nginx # restart, not reload: picks up the new group
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
  echo "Public at https://$DOMAIN"
fi
echo "2FA: add this secret to an authenticator app (SHA1, 6 digits): sudo grep TOTP /etc/remote-browser.env"
echo "Running. Connect with: ssh -L 8080:/run/remote-browser/sock $ME@<this-host>  then open http://localhost:8080"
