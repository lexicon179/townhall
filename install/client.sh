#!/usr/bin/env bash
# townhall · step 2 · build and serve the client from your server, over HTTPS.
#
# Runs ON THE SERVER, after step 1. Builds the client from source (so what runs
# is what you can read in the repo) and serves it with Caddy. Caddy also proxies
# /v1/* to your node, so the browser talks only to your server: reads come from
# your node, writes are submitted to your node, which relays them to validators.
#
#   curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/client.sh | bash
#
# Options:
#   DOMAIN   your own domain pointed at this server (default: <ip>.sslip.io, works with no setup).
#            The <ip>.sslip.io address keeps working alongside it.
#   REPO     git URL of townhall (default: https://github.com/townhall-fc/townhall)
#   UPLOAD_FIDS     who may upload images and video, as comma-separated fids (default: anyone
#                   signed in to this client with an active key)
#   MEDIA_QUOTA_GB  total space for uploads on this server (default: 20)
set -euo pipefail

say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
REPO="${REPO:-https://github.com/townhall-fc/townhall}"
APP_DIR=/opt/townhall

command -v docker >/dev/null 2>&1 || die "Docker not found. Run step 1 (node.sh) first."
curl -fsS localhost:3381/v1/info >/dev/null 2>&1 || echo "  ! Your node's API is not answering yet. That's fine; the client will show it as syncing."

# 1. Address
IP=$(curl -fsS -4 https://api.ipify.org || hostname -I | awk '{print $1}')
SSLIP="$(echo "$IP" | tr . -).sslip.io"
DOMAIN="${DOMAIN:-$SSLIP}"
SITES="$DOMAIN"; [ "$DOMAIN" = "$SSLIP" ] || SITES="$DOMAIN, $SSLIP"
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
$SITES {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		Content-Security-Policy "default-src 'self'; img-src * data: blob:; media-src 'self' https: blob:; connect-src 'self' https:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
	}
	handle /v1/* {
		reverse_proxy 127.0.0.1:3381
	}
	handle /api/* {
		reverse_proxy 127.0.0.1:3390
	}
	# Images and video you attach to casts, stored on this server (see server/index.mjs).
	handle /media/* {
		root * /
		header Cache-Control "public, max-age=31536000, immutable"
		file_server
	}
	# Shared casts: the optional service (signin.sh) adds link-preview tags.
	handle /c/* {
		reverse_proxy 127.0.0.1:3390
	}
	handle {
		root * /srv
		try_files {path} /index.html
		file_server
	}
	# Without that service, /c/ links still open the client.
	handle_errors 502 {
		@cast path /c/*
		handle @cast {
			root * /srv
			rewrite * /index.html
			file_server {
				status 200
			}
		}
	}
}
EOF

# 4. Small service for link previews of shared casts (/c/<fid>/<hash>), channel lookups and
#    media uploads. It is the same program signin.sh configures for sign-in.
say "Starting the townhall service (link previews, channels, uploads)"
SRV=$APP_DIR/signin-app; DATA=$APP_DIR/signin-data; MEDIA=$APP_DIR/media
$SUDO mkdir -p "$DATA" "$MEDIA" && $SUDO chmod 700 "$DATA" && $SUDO chmod 755 "$MEDIA"
$SUDO rm -rf "$SRV" && $SUDO cp -r "$APP_DIR/src/server" "$SRV"
$SUDO docker run --rm -v "$SRV:/app" -w /app node:22-alpine npm i --omit=dev --no-audit --no-fund >/dev/null </dev/null
DEFAULT_FID=$($SUDO cat "$DATA/default-fid" 2>/dev/null || true)
# Upload settings are kept in $DATA so signin.sh and later runs restart the service with them.
UPLOAD_FIDS="${UPLOAD_FIDS-$($SUDO cat "$DATA/upload-fids" 2>/dev/null || true)}"
MEDIA_QUOTA_GB="${MEDIA_QUOTA_GB:-$($SUDO cat "$DATA/media-quota-gb" 2>/dev/null || echo 20)}"
echo "$UPLOAD_FIDS" | $SUDO tee "$DATA/upload-fids" >/dev/null
echo "$MEDIA_QUOTA_GB" | $SUDO tee "$DATA/media-quota-gb" >/dev/null
$SUDO docker rm -f townhall-signin >/dev/null 2>&1 || true
$SUDO docker run -d --name townhall-signin --restart unless-stopped --network host \
  -e APP_FILE=/data/app.json -e DEFAULT_FID="$DEFAULT_FID" -e WWW_DIR=/www -e MEDIA_DIR=/media \
  -e UPLOAD_FIDS="$UPLOAD_FIDS" -e MEDIA_QUOTA_GB="$MEDIA_QUOTA_GB" \
  -v "$SRV:/app:ro" -v "$DATA:/data" -v "$MEDIA:/media" -v "$APP_DIR/www:/www:ro" -w /app node:22-alpine node index.mjs serve >/dev/null </dev/null

say "Starting the web server"
$SUDO docker rm -f townhall-web >/dev/null 2>&1 || true
$SUDO docker run -d --name townhall-web --restart unless-stopped --network host \
  -v "$APP_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$APP_DIR/www:/srv:ro" -v "$MEDIA:/media:ro" \
  -v townhall-caddy-data:/data caddy:2-alpine >/dev/null

for _ in $(seq 1 30); do curl -fsS "https://$DOMAIN" >/dev/null 2>&1 && break; sleep 3; done

cat <<EOF

✓ Your client is live: https://$DOMAIN

Open it, choose "Just read" with your username, or connect your account to post.
Connecting needs your recovery phrase once, used only in your browser to sign a
gasless KEY_ADD. No ETH, no transaction. Use a test account.

Update later:  re-run this command.
EOF
