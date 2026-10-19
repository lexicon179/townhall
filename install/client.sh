#!/usr/bin/env bash
# townhall · step 2 · build and serve the client from your server, over HTTPS.
#
# Runs ON THE SERVER, after step 1. Builds the client from source (so what runs
# is what you can read in the repo) and serves it with Caddy. Caddy also proxies
# /v1/* to your node, so the browser talks only to your server: reads come from
# your node, writes are submitted to your node, which relays them to validators.
#
#   curl -fsSL https://raw.githubusercontent.com/lexicon179/townhall/main/install/client.sh | bash
#
# Options:
#   DOMAIN   your own domain pointed at this server (default: <ip>.sslip.io, works with no setup)
#   REPO     git URL of townhall (default: https://github.com/lexicon179/townhall)
set -euo pipefail

say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
REPO="${REPO:-https://github.com/lexicon179/townhall}"
APP_DIR=/opt/townhall

command -v docker >/dev/null 2>&1 || die "Docker not found. Run step 1 (node.sh) first."
curl -fsS localhost:3381/v1/info >/dev/null 2>&1 || echo "  ! Your node's API is not answering yet. That's fine; the client will show it as syncing."

# 1. Address
IP=$(curl -fsS -4 https://api.ipify.org || hostname -I | awk '{print $1}')
DOMAIN="${DOMAIN:-$(echo "$IP" | tr . -).sslip.io}"
say "Client address: https://$DOMAIN"

# 2. Build from source in a throwaway Node container
say "Building the client from source"
$SUDO rm -rf "$APP_DIR/src"; $SUDO mkdir -p "$APP_DIR"
$SUDO docker run --rm -v "$APP_DIR:/out" node:22-alpine sh -c "
  apk add --no-cache git >/dev/null &&
  git clone --depth 1 $REPO /out/src >/dev/null 2>&1 &&
  cd /out/src/client && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null &&
  rm -rf /out/www && cp -r dist /out/www"
[ -f "$APP_DIR/www/index.html" ] || die "Build failed."

# 3. Caddy: HTTPS certificate, static client, /v1 → node
$SUDO tee "$APP_DIR/Caddyfile" >/dev/null <<EOF
$DOMAIN {
	encode gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		Content-Security-Policy "default-src 'self'; img-src * data:; connect-src 'self' https:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
	}
	handle /v1/* {
		reverse_proxy 127.0.0.1:3381
	}
	handle /api/* {
		reverse_proxy 127.0.0.1:3390
	}
	handle {
		root * /srv
		try_files {path} /index.html
		file_server
	}
}
EOF

say "Starting the web server"
$SUDO docker rm -f townhall-web >/dev/null 2>&1 || true
$SUDO docker run -d --name townhall-web --restart unless-stopped --network host \
  -v "$APP_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$APP_DIR/www:/srv:ro" \
  -v townhall-caddy-data:/data caddy:2-alpine >/dev/null

for _ in $(seq 1 30); do curl -fsS "https://$DOMAIN" >/dev/null 2>&1 && break; sleep 3; done

cat <<EOF

✓ Your client is live: https://$DOMAIN

Open it, choose "Just read" with your username, or connect your account to post.
Connecting needs your recovery phrase once, used only in your browser to sign a
gasless KEY_ADD. No ETH, no transaction. Use a test account.

Update later:  re-run this command.
EOF
