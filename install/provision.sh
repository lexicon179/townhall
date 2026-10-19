#!/usr/bin/env bash
# townhall · step 0 · provision a server for a Snapchain read node.
#
# Runs on YOUR computer. Creates a Hetzner Cloud server plus a 2 TB volume,
# installs your SSH key, and prints the two commands for steps 1 and 2.
#
#   HCLOUD_TOKEN=xxxx bash provision.sh
#
# Options (env vars):
#   HCLOUD_TOKEN        required. Hetzner Cloud → your project → Security → API tokens (Read & Write)
#   SERVER_TYPE         default: cheapest type with >= 4 vCPU and >= 16 GB RAM
#   LOCATION            default: fsn1 (Falkenstein). Others: nbg1, hel1, ash, hil
#   VOLUME_GB           default: 2000 (Snapchain needs ~2 TB free)
#   SSH_PUBKEY_FILE     default: ~/.ssh/id_ed25519.pub (created if missing)
#   NAME                default: townhall
#
# Already have a server (any provider, Ubuntu 22.04/24.04, 4 vCPU, 16 GB RAM, 2 TB disk,
# ports 22/80/443 TCP and 3382 UDP open)? Skip this step and go to step 1.
set -euo pipefail

API="${HCLOUD_API:-https://api.hetzner.cloud/v1}"
NAME="${NAME:-townhall}"
LOCATION="${LOCATION:-fsn1}"
VOLUME_GB="${VOLUME_GB:-2000}"
SSH_PUBKEY_FILE="${SSH_PUBKEY_FILE:-$HOME/.ssh/id_ed25519.pub}"
REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/lexicon179/townhall/main}"

say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Please install '$1' first."; }

need curl; need jq; need ssh; need ssh-keygen
[ -n "${HCLOUD_TOKEN:-}" ] || die "Set HCLOUD_TOKEN (Hetzner Cloud → project → Security → API tokens, Read & Write)."

hc() { # method path [json]
  local out code
  out=$(curl -sS -X "$1" "$API$2" -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' ${3:+--data "$3"} -w '\n%{http_code}')
  code=$(tail -n1 <<<"$out"); out=$(sed '$d' <<<"$out")
  if [ "$code" -ge 400 ]; then die "Hetzner API $1 $2 → $code: $(jq -r '.error.message // .' <<<"$out")"; fi
  printf '%s' "$out"
}

# 1. SSH key
if [ ! -f "$SSH_PUBKEY_FILE" ]; then
  say "No SSH key at $SSH_PUBKEY_FILE, creating one"
  ssh-keygen -t ed25519 -N '' -f "${SSH_PUBKEY_FILE%.pub}" >/dev/null
fi
PUB=$(cat "$SSH_PUBKEY_FILE")
FP=$(ssh-keygen -E md5 -lf "$SSH_PUBKEY_FILE" | awk '{print $2}' | sed 's/^MD5://')
KEY_ID=$(hc GET "/ssh_keys?fingerprint=$FP" | jq -r '.ssh_keys[0].id // empty')
if [ -z "$KEY_ID" ]; then
  say "Uploading your SSH key to Hetzner"
  KEY_ID=$(hc POST /ssh_keys "$(jq -n --arg n "$NAME-$(date +%s)" --arg k "$PUB" '{name:$n, public_key:$k}')" | jq -r .ssh_key.id)
fi

# 2. Server type: cheapest x86 type available here with >= 4 cores and >= 16 GB RAM
if [ -z "${SERVER_TYPE:-}" ]; then
  SERVER_TYPE=$(hc GET "/server_types?per_page=50" | jq -r --arg loc "$LOCATION" '
    [.server_types[]
      | select((.deprecation == null) and (.deprecated != true) and .architecture == "x86" and .cores >= 4 and .memory >= 16)
      | . as $t | ($t.prices[] | select(.location == $loc)) as $p
      | {name: $t.name, price: ($p.price_monthly.gross | tonumber)}]
    | sort_by(.price) | .[0].name // empty')
  [ -n "$SERVER_TYPE" ] || die "No server type with 4 vCPU / 16 GB found in $LOCATION. Try LOCATION=nbg1 or hel1."
fi

# 3. Firewall: SSH, HTTP(S) for the client, UDP 3382 for Snapchain gossip
FW_ID=$(hc GET "/firewalls?name=$NAME" | jq -r '.firewalls[0].id // empty')
if [ -z "$FW_ID" ]; then
  FW_ID=$(hc POST /firewalls "$(jq -n --arg n "$NAME" '{name:$n, rules:[
    {direction:"in",protocol:"tcp",port:"22",source_ips:["0.0.0.0/0","::/0"],description:"ssh"},
    {direction:"in",protocol:"tcp",port:"80",source_ips:["0.0.0.0/0","::/0"],description:"http (certificate)"},
    {direction:"in",protocol:"tcp",port:"443",source_ips:["0.0.0.0/0","::/0"],description:"https (client)"},
    {direction:"in",protocol:"udp",port:"3382",source_ips:["0.0.0.0/0","::/0"],description:"snapchain gossip"}]}')" | jq -r .firewall.id)
fi

say "Creating server '$NAME' ($SERVER_TYPE, $LOCATION, Ubuntu 24.04) with a ${VOLUME_GB} GB volume"
echo "  This is billed by Hetzner while it exists. Delete it in the Hetzner console when you are done."
SERVER=$(hc POST /servers "$(jq -n --arg n "$NAME" --arg t "$SERVER_TYPE" --arg l "$LOCATION" --argjson k "$KEY_ID" --argjson f "$FW_ID" \
  '{name:$n, server_type:$t, location:$l, image:"ubuntu-24.04", ssh_keys:[$k], firewalls:[{firewall:$f}], start_after_create:true}')")
SERVER_ID=$(jq -r .server.id <<<"$SERVER")
IP=$(jq -r .server.public_net.ipv4.ip <<<"$SERVER")

hc POST /volumes "$(jq -n --arg n "$NAME-data" --argjson s "$VOLUME_GB" --argjson id "$SERVER_ID" \
  '{name:$n, size:$s, server:$id, automount:true, format:"ext4"}')" >/dev/null

say "Waiting for the server to boot"
for _ in $(seq 1 60); do
  ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes "root@$IP" true 2>/dev/null && break
  sleep 5
done

cat <<EOF

✓ Server ready: $IP

Next, two commands (each takes a few minutes; the node then syncs on its own for a few hours):

  ssh root@$IP 'curl -fsSL $REPO_RAW/install/node.sh | bash'
  ssh root@$IP 'curl -fsSL $REPO_RAW/install/client.sh | bash'

EOF
