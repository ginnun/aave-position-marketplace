#!/usr/bin/env bash
# Moves an asset price on the local chain. Example: scripts/price.sh WETH 2500
. "$(dirname "$0")/lib.sh"
need forge
[ $# -eq 2 ] || { echo "usage: $0 <WETH|LINK|WBTC|USDT> <price in whole dollars>"; exit 1; }

cd "$ROOT/contracts"
SYMBOL="$1" PRICE_USD="$2" forge script script/SetPrice.s.sol:SetPrice \
  --rpc-url "$LOCAL_RPC_URL" --broadcast --unlocked --sender "$ACL_ADMIN" \
  > "$RUN_DIR/price.log" 2>&1 || { tail -20 "$RUN_DIR/price.log"; exit 1; }
say "$1 price is now \$$2"
