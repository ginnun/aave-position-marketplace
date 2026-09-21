#!/usr/bin/env bash
# Starts the local chain: a pinned fork of Sepolia with the real Aave V3 market,
# then deploys the platform and creates the example positions.
. "$(dirname "$0")/lib.sh"
need anvil; need forge; need cast

PID_FILE="$RUN_DIR/anvil.pid"
LOG="$RUN_DIR/anvil.log"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  say "local chain already running (pid $(cat "$PID_FILE"))"
else
  say "starting a fork of Sepolia at block ${FORK_BLOCK:-latest}"
  fork_args=(--fork-url "$SEPOLIA_RPC_URL")
  [ -n "${FORK_BLOCK:-}" ] && fork_args+=(--fork-block-number "$FORK_BLOCK")
  nohup anvil "${fork_args[@]}" \
    --chain-id "$LOCAL_CHAIN_ID" \
    --port "$ANVIL_PORT" --host 127.0.0.1 \
    --auto-impersonate \
    --silent > "$LOG" 2>&1 &
  echo $! > "$PID_FILE"
  wait_for_rpc "$LOCAL_RPC_URL" || { cat "$LOG"; exit 1; }
  say "local chain is up on $LOCAL_RPC_URL (chain id $LOCAL_CHAIN_ID)"
fi

cd "$ROOT/contracts"

# The Aave admin on the fork has no ether of its own, so give it some to send transactions with.
cast rpc anvil_setBalance "$ACL_ADMIN" 0x56BC75E2D63100000 --rpc-url "$LOCAL_RPC_URL" >/dev/null

say "installing movable price feeds"
forge script script/LocalSetup.s.sol:LocalSetup \
  --rpc-url "$LOCAL_RPC_URL" --broadcast --unlocked --sender "$ACL_ADMIN" \
  > "$RUN_DIR/localsetup.log" 2>&1 || { tail -30 "$RUN_DIR/localsetup.log"; exit 1; }

say "deploying the platform"
PLATFORM_FEE_BPS="$PLATFORM_FEE_BPS" forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$LOCAL_RPC_URL" --broadcast --private-key "$DEPLOYER_LOCAL_PK" \
  > "$RUN_DIR/deploy.log" 2>&1 || { tail -40 "$RUN_DIR/deploy.log"; exit 1; }

say "creating example positions"
forge script script/Seed.s.sol:Seed \
  --rpc-url "$LOCAL_RPC_URL" --broadcast --private-key "$DEPLOYER_LOCAL_PK" \
  > "$RUN_DIR/seed.log" 2>&1 || { tail -40 "$RUN_DIR/seed.log"; exit 1; }

grep -E "^  (PositionManager|Marketplace|alice|bob|carol)" "$RUN_DIR/deploy.log" "$RUN_DIR/seed.log" || true
say "local chain ready. Addresses are in deploy/$LOCAL_CHAIN_ID.json"
