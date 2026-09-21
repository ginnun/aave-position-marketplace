#!/usr/bin/env bash
# Picks a fork block that the public RPC still serves state for, and stores it in .env.
# Public endpoints keep only recent state, so an old pin stops working after some days.
. "$(dirname "$0")/lib.sh"
need cast

head=$(cast block-number --rpc-url "$SEPOLIA_RPC_URL")
target=$(( head - 64 ))

if ! cast balance "$ACL_ADMIN" --block "$target" --rpc-url "$SEPOLIA_RPC_URL" >/dev/null 2>&1; then
  warn "the public endpoint does not serve state at block $target"
  warn "use an archive endpoint, then set SEPOLIA_RPC_URL and FORK_BLOCK by hand"
  exit 1
fi

if grep -q '^FORK_BLOCK=' "$ROOT/.env"; then
  sed -i "s/^FORK_BLOCK=.*/FORK_BLOCK=$target/" "$ROOT/.env"
else
  echo "FORK_BLOCK=$target" >> "$ROOT/.env"
fi
say "fork pinned to block $target (head is $head)"
