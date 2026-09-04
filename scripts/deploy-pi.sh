#!/usr/bin/env bash
set -euo pipefail

# Build and deploy Reef Doser to a Raspberry Pi.
# Usage:
#   PI_HOST=192.168.0.33 ./scripts/deploy-pi.sh
#
# Defaults:
#   PI_HOST    (required — set to your Pi's hostname or IP)
#   PI_USER    (default: pi)
#   REMOTE_DIR (default: /home/pi/SHARLAY-DOSING-PUMP)

PI_HOST="${PI_HOST:-}"
PI_USER="${PI_USER:-pi}"
REMOTE_DIR="${REMOTE_DIR:-/home/pi/SHARLAY-DOSING-PUMP}"

if [ -z "$PI_HOST" ]; then
  echo "ERROR: Set PI_HOST to the Pi's hostname or IP address."
  echo "Example: PI_HOST=192.168.0.33 ./scripts/deploy-pi.sh"
  exit 1
fi

echo "==> Building TypeScript locally..."
npm run build

echo "==> Building mobile web bundle for /app..."
npm run export:web -w apps/mobile

echo "==> Syncing to ${PI_USER}@${PI_HOST}:${REMOTE_DIR}..."
rsync -avz --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='apps/*/dist' \
  --exclude='*.tsbuildinfo' \
  --exclude='.env' \
  --exclude='*.db' \
  --exclude='*.db-journal' \
  --exclude='*.db-wal' \
  ./ "${PI_USER}@${PI_HOST}:${REMOTE_DIR}/"

# Scoped install keeps the Pi from pulling the entire Expo mobile workspace
# and its ~684 dependencies.
echo "==> Installing dependencies on the Pi..."
ssh "${PI_USER}@${PI_HOST}" "cd ${REMOTE_DIR} && npm install -w apps/device -w packages/shared --omit=dev"

echo "==> Building device server on the Pi..."
ssh "${PI_USER}@${PI_HOST}" "cd ${REMOTE_DIR} && npm run build -w apps/device"

echo "==> Installing/starting systemd service..."
ssh "${PI_USER}@${PI_HOST}" "
  set -e
  sudo cp ${REMOTE_DIR}/systemd/reefdoser.service /etc/systemd/system/reefdoser.service
  sudo systemctl daemon-reload
  sudo systemctl enable reefdoser.service
  sudo systemctl restart reefdoser.service
"

echo "==> Waiting 2s for service status..."
sleep 2
ssh "${PI_USER}@${PI_HOST}" "sudo systemctl status reefdoser.service --no-pager"

echo "==> Deploy complete."
echo "    Logs: ssh ${PI_USER}@${PI_HOST} 'sudo journalctl -u reefdoser -f'"
