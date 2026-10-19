#!/usr/bin/env bash
# townhall · step 1 · run a Snapchain read node.
#
# Runs ON THE SERVER (as root or a sudo user). Uses the official Farcaster
# docker-compose file from the latest Snapchain release, unchanged, with its
# data on the biggest disk. The node downloads a snapshot of the network, then keeps
# itself in sync. No API keys, no accounts.
#
#   curl -fsSL https://raw.githubusercontent.com/lexicon179/townhall/main/install/node.sh | bash
#
# Options: DATA_DIR (default: mount point with the most free space)
set -euo pipefail

say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | $SUDO sh >/dev/null
fi
command -v jq >/dev/null 2>&1 || { $SUDO apt-get update -qq && $SUDO apt-get install -y -qq jq >/dev/null; }

# 2. Where the data goes: the mount with the most free space (the 2 TB volume)
DATA_DIR="${DATA_DIR:-$(df -B1G --output=avail,target -x tmpfs -x devtmpfs -x overlay | tail -n +2 | sort -rn | head -1 | awk '{print $2}')}"
FREE_GB=$(df -B1G --output=avail "$DATA_DIR" | tail -1 | tr -d ' ')
say "Data directory: $DATA_DIR ($FREE_GB GB free)"
[ "$FREE_GB" -ge 1500 ] || echo "  ! Snapchain needs about 2 TB. You have $FREE_GB GB free here; the sync may run out of space."

NODE_DIR="$DATA_DIR/snapchain"
$SUDO mkdir -p "$NODE_DIR"
cd "$NODE_DIR"

# 3. Official compose file + validator set from the latest Snapchain release
TAG=$(curl -fsSL https://api.github.com/repos/farcasterxyz/snapchain/releases/latest | jq -r '.tag_name // empty' || true)
TAG="${TAG:-main}"
RAW="https://raw.githubusercontent.com/farcasterxyz/snapchain/$TAG"
say "Fetching Snapchain $TAG config"
$SUDO curl -fsSL "$RAW/docker-compose.mainnet.yml" -o docker-compose.yml
$SUDO curl -fsSL "$RAW/validators.toml" -o validators.toml
grep -q 'read_node = true' docker-compose.yml || die "Unexpected compose file: it is not configured as a read node."

# 4. Start the node and the small metrics sink it reports to. The official config
#    points the node at statsd:8125 and the node exits if that name doesn't resolve.
#    (Grafana stays off; the firewall keeps the statsd ports private.)
say "Starting the node"
$SUDO docker compose up -d snapchain statsd

# 5. Wait until the HTTP API answers
for _ in $(seq 1 60); do
  curl -fsS localhost:3381/v1/info >/dev/null 2>&1 && break
  sleep 5
done

# A small status helper you can run any time: `townhall-status`
$SUDO tee /usr/local/bin/townhall-status >/dev/null <<'EOS'
#!/usr/bin/env bash
if ! curl -fsS localhost:3381/v1/info >/dev/null 2>&1; then
  echo "Node API not up yet. Still downloading/unpacking the snapshot? Logs: docker compose -f NODE_DIR/docker-compose.yml logs --tail 20 snapchain"
  exit 1
fi
curl -fsS localhost:3381/v1/info | jq -r '"node version: \(.version // "?")", (.shardInfos[] | "shard \(.shardId): height \(.maxHeight)  blocks behind: \(.blockDelay)")'
echo "In sync when every 'blocks behind' is in the single digits."
EOS
$SUDO sed -i "s#NODE_DIR#$NODE_DIR#" /usr/local/bin/townhall-status
$SUDO chmod +x /usr/local/bin/townhall-status

cat <<EOF

✓ Snapchain read node is running in $NODE_DIR

It is now downloading a snapshot of the network and will then catch up with the network.
That takes a few hours. You can run step 2 right away; the client shows sync progress.

Check any time:   townhall-status
Node logs:        docker compose -f $NODE_DIR/docker-compose.yml logs -f snapchain

EOF
