#!/usr/bin/env bash
# Stops every background process this project started.
. "$(dirname "$0")/lib.sh"
# Free the ports first, so a process started outside these scripts is stopped too.
free_port "$SERVER_PORT"
free_port "$WEB_PORT"

for name in anvil server web; do
  f="$RUN_DIR/$name.pid"
  if [ -f "$f" ]; then
    pid=$(cat "$f")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      # give it a moment, then insist
      sleep 0.3
      kill -9 "$pid" 2>/dev/null || true
      say "stopped $name (pid $pid)"
    fi
    rm -f "$f"
  fi
done
