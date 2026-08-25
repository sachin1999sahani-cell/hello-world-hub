#!/usr/bin/env bash
# HTTPS setup for rbnt-analytics.test-hub.xyz via Caddy (auto Let's Encrypt)
# Prereq: DNS A record for the subdomain -> this VPS IP, ports 80+443 reachable.
# Run as root: bash caddy-setup.sh [subdomain]
set -euo pipefail

DOMAIN="${1:-rbnt-analytics.test-hub.xyz}"

echo "== [1/3] install caddy"
apt-get update -qq
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
apt-get update -qq && apt-get install -y -qq caddy >/dev/null

echo "== [2/3] firewall ports 80/443"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  echo "ufw rules added"
else
  echo "ufw inactive - make sure provider firewall allows 80/443"
fi

echo "== [3/3] Caddyfile -> reverse proxy $DOMAIN to 127.0.0.1:8600"
cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
  encode gzip
  reverse_proxy 127.0.0.1:8600
}
CADDY
systemctl enable --now caddy
systemctl restart caddy

sleep 3
echo "status:"
systemctl is-active caddy
echo
echo "DONE in ~30s cert will be issued. Check: https://${DOMAIN}"
echo "If cert fails, check DNS: dig +short ${DOMAIN}  (must return this VPS IP)"
