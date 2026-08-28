#!/usr/bin/env bash
# Manual deploy on the VPS (same steps as GitHub Actions).
set -euo pipefail
cd "$(dirname "$0")/.."
git fetch origin main
git reset --hard origin/main
npm ci --omit=dev 2>/dev/null || npm install --omit=dev
if [ -n "${VPS_RESTART_CMD:-}" ]; then
  eval "$VPS_RESTART_CMD"
elif command -v pm2 >/dev/null 2>&1; then
  pm2 restart smartroutine || pm2 restart routine || pm2 restart all
elif systemctl is-active --quiet smartroutine 2>/dev/null; then
  sudo systemctl restart smartroutine
else
  echo "Set VPS_RESTART_CMD or install pm2/systemd unit smartroutine"
  exit 1
fi
echo "Deploy finished."
