#!/usr/bin/env bash
# Deploys the platform to the public Sepolia testnet.
# Needs DEPLOYER_PRIVATE_KEY in .env and some Sepolia ether on that address.
. "$(dirname "$0")/lib.sh"
need forge; need cast

if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ]; then
  echo "DEPLOYER_PRIVATE_KEY is empty in .env" >&2
  echo "Put a funded Sepolia key there, then run this again." >&2
  exit 1
fi

# A misconfigured SEPOLIA_RPC_URL pointing at mainnet would broadcast these transactions with
# real money and still report that 11155111.json was written. Ask the endpoint who it is first.
actual_chain=$(cast chain-id --rpc-url "$SEPOLIA_RPC_URL")
if [ "$actual_chain" != "11155111" ]; then
  echo "SEPOLIA_RPC_URL answers for chain $actual_chain, not Sepolia (11155111)." >&2
  echo "Refusing to broadcast." >&2
  exit 1
fi

deployer=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
balance=$(cast balance "$deployer" --rpc-url "$SEPOLIA_RPC_URL")
say "deployer $deployer holds $(cast to-unit "$balance" ether) ETH"
if [ "$balance" = "0" ]; then
  echo "This address has no Sepolia ether. Get some from a faucet first." >&2
  exit 1
fi

verify=()
if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
  verify=(--verify --etherscan-api-key "$ETHERSCAN_API_KEY")
  say "contract verification is on"
else
  warn "ETHERSCAN_API_KEY is empty, so verification is skipped"
fi

cd "$ROOT/contracts"
# The key goes through the environment, not the command line: anything on the command line is
# readable by every user on this machine through ps and /proc/*/cmdline.
PLATFORM_FEE_BPS="$PLATFORM_FEE_BPS" \
DEPLOY_PK="$DEPLOYER_PRIVATE_KEY" \
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --broadcast --slow "${verify[@]}" \
  | tee "$RUN_DIR/deploy-sepolia.log"

say "addresses written to deploy/11155111.json"
say "run the indexer against the testnet with:"
echo "    CHAIN_ID=11155111 RPC_URL=$SEPOLIA_RPC_URL npm run server"
