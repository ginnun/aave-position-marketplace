#!/usr/bin/env bash
# Copies the contract interfaces out of the build output so the server and the
# interface can read them without depending on Foundry.
. "$(dirname "$0")/lib.sh"
need forge
cd "$ROOT/contracts"
forge build >/dev/null
mkdir -p "$ROOT/shared"
node -e '
const fs = require("fs");
const root = process.argv[1];
const names = ["PositionManager", "Marketplace", "PositionAccount"];
const out = {};
for (const n of names) {
  const p = `${root}/contracts/out/${n}.sol/${n}.json`;
  out[n] = JSON.parse(fs.readFileSync(p, "utf8")).abi;
}
fs.writeFileSync(`${root}/shared/abi.json`, JSON.stringify(out, null, 2));
// The interface reads this file over HTTP at runtime, so it needs its own copy. Copying it
// here rather than by hand: the two drifted apart once already, and a stale copy means the
// interface cannot decode an error the contract now returns.
fs.mkdirSync(`${root}/web/public`, { recursive: true });
fs.copyFileSync(`${root}/shared/abi.json`, `${root}/web/public/abi.json`);
console.log("shared/abi.json and web/public/abi.json written");
' "$ROOT"
