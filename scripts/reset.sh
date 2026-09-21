#!/usr/bin/env bash
# Throws away the local chain and builds it again from scratch.
. "$(dirname "$0")/lib.sh"
"$ROOT/scripts/stop.sh"
rm -f "$ROOT/deploy/$LOCAL_CHAIN_ID.json" "$ROOT/deploy/$LOCAL_CHAIN_ID.feeds.json"
# Only the local chain's run records. The Sepolia ones hold the transaction hashes a later
# verification needs, and a test run has no business deleting the testnet deploy history.
rm -rf "$ROOT"/contracts/broadcast/*/"$LOCAL_CHAIN_ID"
rm -f "$RUN_DIR"/anvil.log "$RUN_DIR"/deploy.log "$RUN_DIR"/seed.log "$RUN_DIR"/localsetup.log
say "local state cleared"
"$ROOT/scripts/chain.sh"
