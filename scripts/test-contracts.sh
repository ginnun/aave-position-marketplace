#!/usr/bin/env bash
# Contract tests against the pinned fork. Loads the project .env first, because the
# tests need SEPOLIA_RPC_URL and FORK_BLOCK.
. "$(dirname "$0")/lib.sh"
need forge

if [ -z "${SEPOLIA_RPC_URL:-}" ]; then
  echo "SEPOLIA_RPC_URL is empty. Copy .env.example to .env first." >&2
  exit 1
fi
if [ -z "${FORK_BLOCK:-}" ]; then
  warn "FORK_BLOCK is empty, so the tests will fork the newest block"
  warn "run scripts/pin.sh to pin one"
fi

cd "$ROOT/contracts"
exec forge test "$@"
