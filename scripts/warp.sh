#!/usr/bin/env bash
# Moves the local chain clock forward. Example: scripts/warp.sh 7d
. "$(dirname "$0")/lib.sh"
need cast
[ $# -eq 1 ] || { echo "usage: $0 <seconds|30m|12h|7d>"; exit 1; }

case "$1" in
  *d) secs=$(( ${1%d} * 86400 )) ;;
  *h) secs=$(( ${1%h} * 3600 )) ;;
  *m) secs=$(( ${1%m} * 60 )) ;;
  *)  secs="$1" ;;
esac

cast rpc evm_increaseTime "$secs" --rpc-url "$LOCAL_RPC_URL" >/dev/null
cast rpc evm_mine --rpc-url "$LOCAL_RPC_URL" >/dev/null
ts=$(cast block latest --field timestamp --rpc-url "$LOCAL_RPC_URL")
# GNU date reads an epoch with -d @, the BSD date on macOS with -r.
now=$(date -d @"$ts" '+%F %T' 2>/dev/null || date -r "$ts" '+%F %T')
say "clock moved forward by $secs seconds (now $now)"
