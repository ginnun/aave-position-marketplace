#!/usr/bin/env bash
# Brings the whole stack up with one command: local chain, indexer, interface.
. "$(dirname "$0")/lib.sh"
need node; need npm

[ -d "$ROOT/node_modules" ] || { say "installing packages"; (cd "$ROOT" && npm install); }

"$ROOT/scripts/chain.sh"
"$ROOT/scripts/abi.sh"

free_port "$SERVER_PORT"
say "starting the indexer on port $SERVER_PORT"
(
  cd "$ROOT"
  CHAIN_ID="$LOCAL_CHAIN_ID" RPC_URL="$LOCAL_RPC_URL" SERVER_PORT="$SERVER_PORT" \
    env -u DEPLOYER_PRIVATE_KEY nohup node server/src/index.js > "$RUN_DIR/server.log" 2>&1 &
  echo $! > "$RUN_DIR/server.pid"
)
# The first pass reads the whole log history of the forked market, which takes longer on a
# slow endpoint than on a fast one. /api/health answers 503 until that pass lands, so a short
# budget here fails a run that was only slow.
ok=0
for _ in $(seq 240); do
  curl -sf "http://127.0.0.1:$SERVER_PORT/api/health" >/dev/null && { ok=1; break; }
  sleep 0.5
done
if [ "$ok" != 1 ]; then
  echo "the indexer never answered on port $SERVER_PORT" >&2
  tail -40 "$RUN_DIR/server.log" >&2 || true
  exit 1
fi

free_port "$WEB_PORT"
say "starting the interface on port $WEB_PORT"
say "press Ctrl+C to stop the interface; run scripts/stop.sh to stop everything"
cd "$ROOT"
WEB_PORT="$WEB_PORT" SERVER_URL="http://127.0.0.1:$SERVER_PORT" env -u DEPLOYER_PRIVATE_KEY npm run -w web dev -- --host 127.0.0.1
