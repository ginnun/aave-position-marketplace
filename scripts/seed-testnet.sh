#!/usr/bin/env bash
# Creates one example position on the public testnet, using the deployer account.
# Prices there never move, so only the flows that do not need a price change work.
. "$(dirname "$0")/lib.sh"
need forge; need cast
[ -n "${DEPLOYER_PRIVATE_KEY:-}" ] || { echo "DEPLOYER_PRIVATE_KEY is empty in .env" >&2; exit 1; }

actual_chain=$(cast chain-id --rpc-url "$SEPOLIA_RPC_URL")
if [ "$actual_chain" != "11155111" ]; then
  echo "SEPOLIA_RPC_URL answers for chain $actual_chain, not Sepolia (11155111)." >&2
  exit 1
fi

cd "$ROOT/contracts"
DEPLOY_PK="$DEPLOYER_PRIVATE_KEY" forge script script/SeedTestnet.s.sol:SeedTestnet \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --broadcast --slow | tee "$RUN_DIR/seed-sepolia.log"
