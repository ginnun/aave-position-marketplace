#!/usr/bin/env bash
# Runs the browser tests headless against a fresh local chain.
. "$(dirname "$0")/lib.sh"
need node; need npm; need anvil

STARTED_HERE=0

cleanup() {
  if [ "$STARTED_HERE" = "1" ]; then
    "$ROOT/scripts/stop.sh" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ "${E2E_REUSE:-0}" != "1" ]; then
  say "rebuilding the local chain"
  "$ROOT/scripts/reset.sh"
  "$ROOT/scripts/abi.sh"
  STARTED_HERE=1

  free_port "$SERVER_PORT"
  say "starting the indexer"
  (
    cd "$ROOT"
    CHAIN_ID="$LOCAL_CHAIN_ID" RPC_URL="$LOCAL_RPC_URL" SERVER_PORT="$SERVER_PORT" \
      env -u DEPLOYER_PRIVATE_KEY setsid node server/src/index.js > "$RUN_DIR/server.log" 2>&1 < /dev/null &
    echo $! > "$RUN_DIR/server.pid"
  )
  ok=0
  for _ in $(seq 60); do
    curl -sf "http://127.0.0.1:$SERVER_PORT/api/health" >/dev/null && { ok=1; break; }
    sleep 0.5
  done
  # Carrying on here would start the tests against a service that never came up, and the
  # failure would surface much later as something that reads like a different problem.
  if [ "$ok" != 1 ]; then
    echo "the indexer never answered on port $SERVER_PORT" >&2
    tail -40 "$RUN_DIR/server.log" >&2 || true
    exit 1
  fi

  free_port "$WEB_PORT"
  say "starting the interface"
  (
    cd "$ROOT"
    WEB_PORT="$WEB_PORT" SERVER_URL="http://127.0.0.1:$SERVER_PORT" \
      env -u DEPLOYER_PRIVATE_KEY setsid npm run -w web dev -- --host 127.0.0.1 > "$RUN_DIR/web.log" 2>&1 < /dev/null &
    echo $! > "$RUN_DIR/web.pid"
  )
  ok=0
  for _ in $(seq 60); do
    curl -sf "http://127.0.0.1:$WEB_PORT/" >/dev/null && { ok=1; break; }
    sleep 0.5
  done
  if [ "$ok" != 1 ]; then
    echo "the interface never answered on port $WEB_PORT" >&2
    tail -40 "$RUN_DIR/web.log" >&2 || true
    exit 1
  fi
fi

say "running the browser tests"
cd "$ROOT"
WEB_URL="http://127.0.0.1:$WEB_PORT" SERVER_URL="http://127.0.0.1:$SERVER_PORT" \
  LOCAL_RPC_URL="$LOCAL_RPC_URL" npm run -w e2e test -- "$@"
