#!/usr/bin/env bash
# RBNT Analytics - one-shot VPS setup
# Run as root on a fresh Ubuntu 22.04/24.04 box:
#   bash vps-setup.sh
set -euo pipefail

APP_DIR="/opt/rbnt-analytics"
REPO_URL="${REPO_URL:-https://github.com/0xDarkSeidBull/rbnt-analytics.git}"
BRANCH="${BRANCH:-main}"

echo "== [1/6] system packages"
apt-get update -qq
apt-get install -y -qq python3-venv python3-pip git curl >/dev/null

echo "== [2/6] clone repo -> $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git fetch origin "$BRANCH" && git reset --hard "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "== [3/6] python venv + deps"
python3 -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt

echo "== [4/6] systemd service"
cat > /etc/systemd/system/rbnt-analytics.service <<UNIT
[Unit]
Description=RBNT Analytics dashboard (poller + API + site)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}/backend
ExecStart=${APP_DIR}/.venv/bin/python -u serve.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
# optional: set your CoinGecko demo key
# Environment=COINGECKO_DEMO_KEY=your_key_here

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now rbnt-analytics

echo "== [5/6] waiting for first API response"
for i in $(seq 1 30); do
  sleep 2
  if curl -sf -m 3 http://localhost:8600/api/system >/dev/null; then break; fi
done

echo "== [6/6] status"
systemctl is-active rbnt-analytics
curl -sS -m 5 http://localhost:8600/api/system | head -c 200; echo
echo
echo "DONE. Dashboard: http://$(curl -sS -m 5 ifconfig.me || echo YOUR_VPS_IP):8600"
echo "Logs:      journalctl -u rbnt-analytics -f"
echo "Update:    cd $APP_DIR && git pull && systemctl restart rbnt-analytics"
