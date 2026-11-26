#!/usr/bin/env bash
# MindSpark - one-shot installer for a fresh Ubuntu VM (22.04/24.04/26.04).
#
# Installs Node 22, the app, a systemd service, and (optionally) a
# Cloudflare Tunnel. Everything it needs comes from this repository, so the
# same command works on any future VM.
#
# Usage (as root):
#   GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... \
#   APP_ORIGIN=https://mindspark.example.com \
#   DEFAULT_REPO=owner/mindspark-maps \
#   TUNNEL_TOKEN=... ./selfhost/install.sh
#
# Or copy selfhost/config.example.env to /etc/mindspark/env first, then:
#   ./selfhost/install.sh
#
# Optional variables:
#   REPO_URL     git URL to clone (default: this fork)
#   BRANCH       branch to deploy (default: main)
#   SRC_DIR      deploy an existing checkout instead of cloning
#   RUN_USER     service account (default: mindspark)
#   TUNNEL_TOKEN Cloudflare Tunnel token from the Zero Trust dashboard
#   SKIP_CLOUDFLARED=1  do not install cloudflared
set -euo pipefail
umask 027

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root (sudo -i)." >&2
  exit 1
fi

REPO_URL="${REPO_URL:-https://github.com/JamesRivers/MindSpark.git}"
BRANCH="${BRANCH:-main}"
SRC_DIR="${SRC_DIR:-}"
RUN_USER="${RUN_USER:-mindspark}"
APP_DIR=/opt/mindspark/app
ENV_DIR=/etc/mindspark
ENV_FILE=$ENV_DIR/env
PORT="${PORT:-8080}"

# Load an existing env file first, then let explicit environment win.
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

APP_ORIGIN="${APP_ORIGIN:-}"
GITHUB_CLIENT_ID="${GITHUB_CLIENT_ID:-}"
GITHUB_CLIENT_SECRET="${GITHUB_CLIENT_SECRET:-}"
DEFAULT_REPO="${DEFAULT_REPO:-mindspark-maps}"
ALLOWED_GITHUB_LOGINS="${ALLOWED_GITHUB_LOGINS:-}"
EXTRA_CONNECT_SRC="${EXTRA_CONNECT_SRC:-}"
TUNNEL_TOKEN="${TUNNEL_TOKEN:-}"

if [ -z "$APP_ORIGIN" ]; then
  echo "APP_ORIGIN is required, e.g. APP_ORIGIN=https://mindspark.example.com" >&2
  exit 1
fi
if [ -z "$GITHUB_CLIENT_ID" ] || [ -z "$GITHUB_CLIENT_SECRET" ]; then
  echo "WARNING: GITHUB_CLIENT_ID/SECRET not set - the app will start in token-only mode." >&2
  echo "         Set both and re-run to enable 'Sign in with GitHub'." >&2
fi

echo "==> Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl git gnupg rsync jq

echo "==> Installing Node.js 22"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "==> Creating service account"
if ! id "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --home /opt/mindspark --shell /usr/sbin/nologin "$RUN_USER"
fi

echo "==> Deploying application"
mkdir -p "$ENV_DIR" /opt/mindspark
if [ -n "$SRC_DIR" ]; then
  mkdir -p "$APP_DIR"
  rsync -a --delete --exclude .git "$SRC_DIR"/ "$APP_DIR"/
else
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" fetch --prune origin
    git -C "$APP_DIR" checkout "$BRANCH"
    git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
  else
    rm -rf "$APP_DIR"
    git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$APP_DIR"
  fi
fi
chown -R root:"$RUN_USER" /opt/mindspark
chmod -R g+rX,o-rwx /opt/mindspark

echo "==> Writing $ENV_FILE"
cat > "$ENV_FILE" <<EOF
HOST=127.0.0.1
PORT=$PORT
APP_ORIGIN=$APP_ORIGIN
GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET=$GITHUB_CLIENT_SECRET
DEFAULT_REPO=$DEFAULT_REPO
ALLOWED_GITHUB_LOGINS=$ALLOWED_GITHUB_LOGINS
EXTRA_CONNECT_SRC=$EXTRA_CONNECT_SRC
EOF
chown root:"$RUN_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

echo "==> Installing systemd service"
install -m 0644 "$APP_DIR/selfhost/mindspark.service" /etc/systemd/system/mindspark.service
systemctl daemon-reload
systemctl enable --now mindspark.service
sleep 1
systemctl --no-pager --lines=20 status mindspark.service || true
curl -fsS "http://127.0.0.1:$PORT/status" | jq . || true

if [ "${SKIP_CLOUDFLARED:-0}" != "1" ]; then
  echo "==> Installing cloudflared"
  if ! command -v cloudflared >/dev/null 2>&1; then
    install -d -m 0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
      > /etc/apt/sources.list.d/cloudflared.list
    apt-get update -y
    apt-get install -y cloudflared
  fi

  if [ -n "$TUNNEL_TOKEN" ]; then
    echo "==> Installing Cloudflare Tunnel service"
    cloudflared service uninstall >/dev/null 2>&1 || true
    cloudflared service install "$TUNNEL_TOKEN"
    systemctl enable --now cloudflared.service
    systemctl --no-pager --lines=10 status cloudflared.service || true
  else
    echo "TUNNEL_TOKEN not set: cloudflared is installed but no tunnel is configured." >&2
  fi
fi

cat <<EOF

MindSpark is installed.

  App:        $APP_ORIGIN
  Local:      http://127.0.0.1:$PORT
  Env:        $ENV_FILE
  Service:    systemctl status mindspark
  Logs:       journalctl -u mindspark -f
  Maps repo:  https://github.com/$DEFAULT_REPO

Cloudflare dashboard -> Zero Trust -> Networks -> Tunnels:
  Public hostname:  (your APP_ORIGIN hostname)
  Service:          http://localhost:$PORT

GitHub OAuth App (https://github.com/settings/developers):
  Homepage URL:               $APP_ORIGIN
  Authorization callback URL: $APP_ORIGIN/callback

To update later:  git -C $APP_DIR pull --ff-only && systemctl restart mindspark
EOF
