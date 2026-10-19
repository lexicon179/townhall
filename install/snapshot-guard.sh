#!/usr/bin/env bash
# townhall · snapshot guard
#
# On first start Snapchain downloads the network snapshot shard by shard:
# compressed chunks -> one uncompressed .tar per shard -> unpacked into the DB.
# It deletes the downloaded files only after the LAST shard, so at the peak the
# disk holds every shard's chunks, tars and database at once. That is why the
# docs ask for 2 TB.
#
# This guard frees files the node has already finished with, so the first sync
# fits on a smaller disk:
#   - a chunk, once the node has moved on to the next chunk while unzipping
#   - all chunks of a shard, once that shard's .tar is being unpacked
#   - a shard's .tar, once the node has started downloading the next shard
# It only ever deletes inside .rocks.snapshot and exits when that folder is gone.
#
#   bash snapshot-guard.sh /path/to/snapchain        (the folder with docker-compose.yml)
set -uo pipefail

NODE_DIR="${1:?usage: snapshot-guard.sh /path/to/snapchain}"
SNAP="$NODE_DIR/.rocks.snapshot"
CONTAINER="${CONTAINER:-$(docker ps --format '{{.Names}}' | grep -m1 snapchain-1 || true)}"
[ -n "$CONTAINER" ] || { echo "snapchain container not found"; exit 1; }
log() { echo "$(date -u +%FT%TZ) $*"; }
gb() { du -sb "$1" 2>/dev/null | awk '{printf "%.1f GB", $1/1e9}'; }

log "guarding $SNAP (container $CONTAINER)"
while [ -d "$SNAP" ]; do
  RECENT=$(docker logs --since 3m "$CONTAINER" 2>&1 | grep -E 'Unzipping snapshot chunk|Unpacking snapshot file|Downloading zipped snapshot chunk' | tail -n 1)

  # 1. Unzipping chunk N of shard S: every earlier chunk of S is already in the tar.
  if [[ "$RECENT" =~ Unzipping\ snapshot\ chunk\ ([^ ]+)\ for\ shard\ ([0-9]+) ]]; then
    CUR=$(basename "${BASH_REMATCH[1]}"); S="${BASH_REMATCH[2]}"
    for f in "$SNAP/shard-$S"/chunk_*.bin; do
      [ -e "$f" ] || continue
      [[ "$(basename "$f")" < "$CUR" ]] && rm -f "$f" && FREED=1
    done
    [ -n "${FREED:-}" ] && log "shard $S: freed chunks before $CUR" && unset FREED
  fi

  # 2. Unpacking shard S: its tar is complete, so none of its chunks are needed.
  if [[ "$RECENT" =~ Unpacking\ snapshot\ file\ .*\ for\ shard\ ([0-9]+) ]]; then
    S="${BASH_REMATCH[1]}"
    if compgen -G "$SNAP/shard-$S/chunk_*.bin" >/dev/null; then
      rm -f "$SNAP/shard-$S"/chunk_*.bin && log "shard $S: tar complete, freed all its chunks"
    fi
  fi

  # 3. Downloading shard T: every earlier shard is unpacked into the DB; drop its tar.
  if [[ "$RECENT" =~ Downloading\ zipped\ snapshot\ chunk\ .*\ for\ shard\ ([0-9]+) ]]; then
    T="${BASH_REMATCH[1]}"
    for tar in "$SNAP"/shard_*_snapshot.tar; do
      [ -e "$tar" ] || continue
      S=$(basename "$tar" | sed -E 's/shard_([0-9]+)_snapshot.tar/\1/')
      if [ "$S" -lt "$T" ]; then
        rm -f "$tar"; rm -rf "$SNAP/shard-$S"; log "shard $S: unpacked, freed its tar"
      fi
    done
  fi

  sleep 20
done
log "snapshot folder gone: first sync finished, guard exiting"
