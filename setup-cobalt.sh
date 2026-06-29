#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  COBALT API SELF-HOST SETUP — Eventide Omega Downloader
#  Run this on your VPS panel (4GB RAM, 100% CPU recommended)
#
#  What this does:
#   1. Installs Docker + docker-compose (if not already)
#   2. Clones the cobalt API repo
#   3. Builds the Docker image (cobalt supports 20+ platforms)
#   4. Starts cobalt on port 9000 with an API key
#   5. Prints the URL you need to set on Render as COBALT_LOCAL_URL
#
#  After this completes:
#   - On Render: set env var COBALT_LOCAL_URL=http://YOUR_VPS_IP:9000/
#   - Optional: set COBALT_LOCAL_KEY=<the secret key generated below>
# ═══════════════════════════════════════════════════════════════════════

set -e

echo "═══════════════════════════════════════════════════"
echo "  COBALT API — EVENTIDE OMEGA DOWNLOADER SETUP"
echo "═══════════════════════════════════════════════════"

# 1. Install Docker if missing
if ! command -v docker &>/dev/null; then
  echo "[1/5] Installing Docker..."
  apt update -qq
  apt install -y docker.io docker-compose-v2 curl git
  systemctl enable --now docker
else
  echo "[1/5] Docker already installed ✓"
fi

# 2. Clone cobalt API
COBALT_DIR="/opt/cobalt-api"
if [ ! -d "$COBALT_DIR" ]; then
  echo "[2/5] Cloning cobalt API..."
  git clone --depth 1 https://github.com/imputnet/cobalt.git "$COBALT_DIR"
else
  echo "[2/5] Cobalt already cloned at $COBALT_DIR ✓"
fi

cd "$COBALT_DIR"

# 3. Generate a random API key (32 chars hex)
API_KEY=$(openssl rand -hex 24)
echo "[3/5] Generated API key: $API_KEY"
echo "         (SAVE THIS — you'll need it for COBALT_LOCAL_KEY env var)"

# 4. Create docker-compose.yml with our config
cat > docker-compose.yml <<EOF
services:
  cobalt-api:
    build: .
    container_name: cobalt-api
    restart: unless-stopped
    ports:
      - "9000:9000"
    environment:
      # Listen on all interfaces so Render can reach us
      API_HOST: 0.0.0.0
      API_PORT: "9000"
      # Allow HTTP (HTTPS optional — Render is already HTTPS at its end)
      API_ALLOW_HTTP: "true"
      # Require API key for all requests
      API_AUTH_REQUIRED: "true"
      API_KEY: "$API_KEY"
      # Cobalt data folder
      API_DATA_FOLDER: /tmp/.cache/cobalt
    volumes:
      - cobalt-data:/tmp/.cache/cobalt

volumes:
  cobalt-data:
EOF

# 5. Build and start
echo "[4/5] Building cobalt Docker image (may take 3-5 min)..."
docker compose build --no-cache 2>&1 | tail -20

echo "[5/5] Starting cobalt..."
docker compose up -d

sleep 5

# Health check
echo ""
echo "═══════════════════════════════════════════════════"
echo "  COBALT API IS UP!"
echo "═══════════════════════════════════════════════════"

# Try to get VPS public IP
PUBLIC_IP=$(curl -s https://api.ipify.org 2>/dev/null || echo "YOUR_VPS_IP")

# Check if cobalt is responding locally
if curl -sf -m 5 http://localhost:9000/ -o /dev/null; then
  echo "✓ Local health check: PASS"
else
  echo "⚠️ Local health check: waiting for startup (may take ~30s more)"
  sleep 30
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  NEXT STEPS — Set these env vars on Render:"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  COBALT_LOCAL_URL=http://$PUBLIC_IP:9000/"
echo "  COBALT_LOCAL_KEY=$API_KEY"
echo ""
echo "  Then ensure your VPS firewall allows inbound port 9000:"
echo "    ufw allow 9000/tcp"
echo ""
echo "═══════════════════════════════════════════════════"
echo "  SUPPORTED PLATFORMS (cobalt v10+)"
echo "═══════════════════════════════════════════════════"
echo "  YouTube (incl. Shorts, Music, 8K/4K/HDR)"
echo "  TikTok (no watermark)"
echo "  Instagram (Reels, Photos, Videos)"
echo "  Facebook (public videos)"
echo "  Twitter/X"
echo "  Pinterest, Reddit, Vimeo, SoundCloud"
echo "  Bluesky, Snapchat, Twitch, Tumblr, VK"
echo "  And 10+ more!"
echo ""

# Save API key to a local file so user can find it later
cat > /opt/cobalt-api.env <<EOF
COBALT_LOCAL_URL=http://$PUBLIC_IP:9000/
COBALT_LOCAL_KEY=$API_KEY
EOF
chmod 600 /opt/cobalt-api.env
echo "Env vars saved to /opt/cobalt-api.env"
echo ""
echo "Done! ✓"
