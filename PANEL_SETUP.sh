#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  EVENTIDE OMEGA — PANEL (VPS) ONE-LINER SETUP
#  Run this on a fresh Ubuntu/Debian VPS after SSHing in.
#  Replace YOUR_GH_TOKEN if your repo is private (else use https clone).
# ═══════════════════════════════════════════════════════════════════════

set -e

REPO_URL="https://github.com/phantom-dev-x/eventide-omega.git"
APP_DIR="phantom-p1"               # change per panel: phantom-p1, p2, p3…
APP_PORT=5000                       # change per panel: 5000, 5001, 5002…
ADMIN_EMAIL="admin@yourdomain.com"
ADMIN_PASSWORD="change_me_strong"
ALLOWED_ORIGINS="https://your-site.vercel.app"

echo "── Installing Node 20 + Python + ffmpeg ──"
if ! command -v node &>/dev/null || ! node -v | grep -q "v20"; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs python3-pip ffmpeg git
else
  apt install -y python3-pip ffmpeg git
fi

echo "── Cloning repo into /opt/$APP_DIR ──"
cd /opt
git clone "$REPO_URL" "$APP_DIR" || (cd "$APP_DIR" && git pull)
cd "$APP_DIR"

echo "── Installing deps ──"
pip3 install --quiet --upgrade yt-dlp imageio-ffmpeg bgutil-ytdlp-pot-provider || true
npm install --no-audit --no-fund

echo "── Writing .env ──"
cat > .env <<EOF
PORT=$APP_PORT
NODE_ENV=production
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
MAX_USERS=15
ALLOWED_ORIGINS=$ALLOWED_ORIGINS
EOF

echo "── Starting with pm2 ──"
npm i -g pm2 --silent
pm2 delete "$APP_DIR" 2>/dev/null || true
pm2 start index.js --name "$APP_DIR"
pm2 save
pm2 startup | tee /tmp/pm2-startup.sh
bash /tmp/pm2-startup.sh || true

echo "── Opening firewall on $APP_PORT ──"
if command -v ufw &>/dev/null; then
  ufw allow "$APP_PORT"/tcp || true
fi

echo ""
echo "✅  Done!"
echo "    Health check:  curl http://localhost:$APP_PORT/health"
echo "    Reverse-proxy this port with nginx (see DEPLOY_PLAN.md)"
echo ""
