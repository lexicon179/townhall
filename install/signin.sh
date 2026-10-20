#!/usr/bin/env bash
# townhall · optional · "Sign in with Farcaster" for a townhall other people use.
#
# Runs ON THE SERVER, after client.sh. Lets visitors connect their account by approving
# townhall in the Farcaster app instead of typing a recovery phrase. It needs an app
# account: a separate FID whose key lives on this server and only signs key requests.
#
#   curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/signin.sh | bash
#
# Two ways to get the app account:
#   - new: the first run makes a key and prints its address. Send a little ETH on Optimism
#     to it, run again, and it registers a new FID.
#   - existing: IMPORT=1 asks for the recovery phrase of an account you already have (a
#     spare one, not your main account). Only the derived key is kept, in a file only root
#     can read. Run it with ssh -t so the prompt can read your keyboard:
#       ssh -t root@YOUR_IP 'curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/signin.sh | IMPORT=1 bash'
#
# The name people see when they approve townhall is the app account's username.
#
# Options:
#   DEFAULT_FID   whose follows make the feed people see before signing in (default: 3)
#   IMPORT=1      use an existing account as the app account (see above)
set -euo pipefail
say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
APP_DIR=/opt/townhall
DATA=$APP_DIR/signin-data
APP=$APP_DIR/signin-app
DEFAULT_FID="${DEFAULT_FID:-3}"

[ -d "$APP_DIR/src/server" ] || die "Run client.sh first."
$SUDO mkdir -p "$DATA" && $SUDO chmod 700 "$DATA"
$SUDO rm -rf "$APP" && $SUDO cp -r "$APP_DIR/src/server" "$APP"

say "Installing the sign-in service"
$SUDO docker run --rm -v "$APP:/app" -w /app node:22-alpine npm i --omit=dev --no-audit --no-fund >/dev/null </dev/null
# stdin is this script when it runs as curl | bash, so containers get /dev/null unless they need input.
run() { $SUDO docker run --rm -v "$APP:/app" -v "$DATA:/data" -w /app node:22-alpine node index.mjs "$@" </dev/null; }
run_stdin() { $SUDO docker run --rm -i -v "$APP:/app" -v "$DATA:/data" -w /app node:22-alpine node index.mjs "$@"; }

if [ "${IMPORT:-}" = "1" ]; then
  [ -r /dev/tty ] || die "IMPORT=1 needs a keyboard: run it with ssh -t."
  printf 'Recovery phrase of the app account (input hidden): ' >/dev/tty
  read -rs PHRASE </dev/tty; echo >/dev/tty
  printf '%s' "$PHRASE" | run_stdin import || die "Import failed (see above). Nothing was saved."
  unset PHRASE
fi
field() { sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\).*/\1/p"; }

INFO=$(run init | tail -1)
ADDR=$(echo "$INFO" | field address); FID=$(echo "$INFO" | field fid)
if [ "$FID" = "null" ] || [ -z "$FID" ]; then
  PRICE=$(echo "$INFO" | field registerPriceEth); BAL=$(echo "$INFO" | field balanceEth)
  if ! run register >/tmp/townhall-register.log 2>&1; then
    cat <<MSG

  The app account needs an FID. Send a little ETH on Optimism to:

      $ADDR

  Registering costs $PRICE ETH plus a small fee; it has $BAL ETH now.
  Then run this command again.
MSG
    exit 0
  fi
  cat /tmp/townhall-register.log
  FID=$(run init | tail -1 | field fid)
fi
say "App account: fid $FID ($ADDR)"

say "Starting the service"
$SUDO docker rm -f townhall-signin >/dev/null 2>&1 || true
$SUDO docker run -d --name townhall-signin --restart unless-stopped --network host \
  -e APP_FILE=/data/app.json -e DEFAULT_FID="$DEFAULT_FID" -e WWW_DIR=/www \
  -v "$APP:/app:ro" -v "$DATA:/data" -v "$APP_DIR/www:/www:ro" -w /app node:22-alpine node index.mjs serve >/dev/null
for _ in $(seq 1 20); do curl -fsS localhost:3390/api/config 2>/dev/null | grep -q '"signin":true' && break; sleep 1; done
curl -fsS localhost:3390/api/config | grep -q '"signin":true' || die "Service did not start: docker logs townhall-signin"

cat <<EOF2

✓ Sign in with Farcaster is on. Open your client: visitors see the feed right away
  and sign in by approving townhall in the Farcaster app.

  If the client was built before this step, re-run client.sh once (it adds /api to the web server).
EOF2
