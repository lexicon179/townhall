#!/usr/bin/env bash
# townhall · cleanup · delete the Hetzner server and volume that provision.sh created.
#
# Runs on YOUR computer. Hetzner bills by the hour until both are gone, so run this
# when you are done testing:
#
#   curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/destroy.sh | HCLOUD_TOKEN=your_token bash
#
# It asks you to type the server name before deleting anything. Your Farcaster account
# is not touched; to also revoke the app key, use Settings → Revoke in the client first.
#
# Options: NAME (default: townhall), YES=1 to skip the prompt (for scripts).
set -euo pipefail

API="${HCLOUD_API:-https://api.hetzner.cloud/v1}"
NAME="${NAME:-townhall}"
say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
# Missing a tool? Say exactly how to install it on this system.
need() {
  command -v "$1" >/dev/null 2>&1 && return
  local apt="$1" dnf="$1"
  case "$1" in ssh|ssh-keygen) apt=openssh-client; dnf=openssh-clients ;; esac
  if command -v brew >/dev/null 2>&1; then die "Please install '$1' first:  brew install $1"
  elif command -v apt-get >/dev/null 2>&1; then die "Please install '$1' first:  sudo apt update && sudo apt install -y $apt"
  elif command -v dnf >/dev/null 2>&1; then die "Please install '$1' first:  sudo dnf install -y $dnf"
  else die "Please install '$1' first."; fi
}
need curl; need jq
[ -n "${HCLOUD_TOKEN:-}" ] || die "Set HCLOUD_TOKEN (the same Read & Write token you used for provision.sh)."

hc() {
  local out code
  out=$(curl -sS -X "$1" "$API$2" -H "Authorization: Bearer $HCLOUD_TOKEN" -w '\n%{http_code}')
  code=$(tail -n1 <<<"$out"); out=$(sed '$d' <<<"$out")
  [ "$code" -lt 400 ] || die "Hetzner API $1 $2 → $code: $(jq -r '.error.message // .' <<<"$out")"
  printf '%s' "$out"
}

SERVER=$(hc GET "/servers?name=$NAME" | jq -r '.servers[0] // empty')
VOLUME=$(hc GET "/volumes?name=$NAME-data" | jq -r '.volumes[0] // empty')
[ -n "$SERVER$VOLUME" ] || { echo "Nothing named '$NAME' or '$NAME-data' in this project. Nothing to delete."; exit 0; }

echo "This will permanently delete, in this Hetzner project:"
[ -n "$SERVER" ] && echo "  server  $NAME  ($(jq -r '.public_net.ipv4.ip' <<<"$SERVER"))"
[ -n "$VOLUME" ] && echo "  volume  $NAME-data  ($(jq -r '.size' <<<"$VOLUME") GB, with the node's data)"
if [ "${YES:-}" != "1" ]; then
  printf 'Type the server name (%s) to confirm: ' "$NAME"
  read -r answer </dev/tty
  [ "$answer" = "$NAME" ] || die "Not confirmed. Nothing deleted."
fi

if [ -n "$SERVER" ]; then
  say "Deleting server $NAME"
  hc DELETE "/servers/$(jq -r .id <<<"$SERVER")" >/dev/null
fi
if [ -n "$VOLUME" ]; then
  VID=$(jq -r .id <<<"$VOLUME")
  say "Waiting for the volume to detach"
  for _ in $(seq 1 60); do
    [ "$(hc GET "/volumes/$VID" | jq -r '.volume.server // empty')" = "" ] && break
    sleep 3
  done
  say "Deleting volume $NAME-data"
  hc DELETE "/volumes/$VID" >/dev/null
fi

echo
echo "✓ Done. Hetzner stops billing for both from now. Check the console (Servers, Volumes) if you want to be sure."
