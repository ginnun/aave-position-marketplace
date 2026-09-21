#!/usr/bin/env bash
# Shared setup for every script in this directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
RUN_DIR="$ROOT/.run"
mkdir -p "$RUN_DIR" "$ROOT/deploy"

# Foundry installs under either of these two locations.
for d in "$HOME/.foundry/bin" "$HOME/.config/.foundry/bin"; do
  [ -d "$d" ] && PATH="$PATH:$d"
done
export PATH

if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi

: "${SEPOLIA_RPC_URL:=https://ethereum-sepolia-rpc.publicnode.com}"
: "${LOCAL_RPC_URL:=http://127.0.0.1:8545}"
: "${LOCAL_CHAIN_ID:=31337}"
: "${ANVIL_PORT:=8545}"
: "${SERVER_PORT:=8787}"
: "${WEB_PORT:=5173}"
: "${PLATFORM_FEE_BPS:=50}"

# Account 0 of the standard development mnemonic. Local chain only, never a real key.
DEPLOYER_LOCAL_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ACL_ADMIN=0xfA0e305E0f46AB04f00ae6b5f4560d61a2183E00

need() { command -v "$1" >/dev/null || { echo "missing tool: $1" >&2; exit 1; }; }

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

# Stops whatever is listening on a port, including a process this shell did not start.
free_port() {
  local port=$1
  local pids
  # Without ss this whole function was a silent no-op, and the port stayed occupied until
  # something else failed for a reason that looked unrelated. Say so instead.
  if ! command -v ss >/dev/null 2>&1; then
    warn "ss is not installed, so port $port cannot be cleared automatically"
    return 0
  fi
  pids=$(ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $NF}' \
    | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u) || true
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
  if [ -n "$pids" ]; then
    sleep 0.5
  fi
  return 0
}

wait_for_rpc() {
  local url=$1 tries=${2:-60}
  for _ in $(seq "$tries"); do
    if cast block-number --rpc-url "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "rpc never came up: $url" >&2
  return 1
}
