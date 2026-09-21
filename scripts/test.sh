#!/usr/bin/env bash
# Runs every test: the contracts against a pinned fork, then the browser flows.
. "$(dirname "$0")/lib.sh"
need forge

say "contract tests"
"$ROOT/scripts/test-contracts.sh"

if [ ! -d "$ROOT/node_modules/@playwright" ] && [ ! -d "$ROOT/node_modules/playwright-core" ]; then
  warn "browser tests skipped: run 'npm install' and 'npx playwright install chromium' first"
  exit 0
fi

# e2e.sh builds a fresh chain, starts the indexer and the interface, and stops them again.
say "browser tests"
"$ROOT/scripts/e2e.sh"
