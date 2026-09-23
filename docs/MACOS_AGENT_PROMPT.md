# Prompt for a coding agent on macOS

Paste the block below into Claude Code, or another coding agent, on a Mac. It sets the project up
from nothing and makes sure that the local stack and both test suites work. Run the agent from the
directory where you want the repository to live, or from inside an existing clone.

```text
Set up and run the aave-position-marketplace project on this Mac. Work in the current directory.
If it is not already a clone of github.com/ginnun/aave-position-marketplace, clone it and cd in.
If it is, run `git pull` first.

The project is an Aave V3 position marketplace: three Solidity contracts (Foundry), a Node
indexer, a React interface, and two test suites. The local chain is an anvil fork of Sepolia
pinned to one block. Everything runs through npm scripts that call bash scripts in `scripts/`.
Read README.md, section "Run it locally", before you start.

Do these steps in order. Show me the output of each command. Stop and report if a step fails
after the fixes listed here.

1. Tools. Make sure that git, Node 22 or newer, and Foundry (forge, cast, anvil) are installed.
   Install what is missing: `brew install node` for Node, and
   `curl -L https://foundry.paradigm.xyz | bash && foundryup` for Foundry. After foundryup,
   the binaries are in ~/.foundry/bin; make sure that directory is on PATH in this shell.
   Do not use sudo.

2. Configuration. If `.env` does not exist, run `cp .env.example .env`. Leave
   DEPLOYER_PRIVATE_KEY and ETHERSCAN_API_KEY empty. Never print the contents of `.env`.

3. Setup. Run `npm run setup`. It installs packages, the contract dependencies, pins a fork
   block, and generates the contract interfaces.

4. Local chain and interface. Run `npm run dev` in the background and wait until
   `curl -sf http://127.0.0.1:8787/api/health` answers and `curl -sf http://127.0.0.1:5173/`
   returns HTML. The first indexer pass can take one or two minutes on the public endpoint.
   Then confirm that `curl -s http://127.0.0.1:8787/api/listings` lists positions.

   If anvil fails with "state at block ... is pruned" (error code -32603), the pinned block
   is older than what the public endpoint keeps. Run `./scripts/pin.sh && npm run reset`.
   The chain script also retries this on its own once. If the endpoint refuses even a fresh
   block, wait a minute and try again, or put another Sepolia RPC URL in SEPOLIA_RPC_URL in
   `.env` and rerun `./scripts/pin.sh && npm run reset`.

5. Contract tests. Run `npm run test:contracts`. Expect 0 failed. The summary line says
   57 tests passed because it counts the eight invariants as one entry; the per-test lines
   show all 64. It runs against the pinned fork, so a slow endpoint makes it take minutes.

6. Browser tests. Run `npx playwright install chromium` once, then `npm run test:e2e`.
   Expect 25 passed. This rebuilds the local chain first and stops it at the end.

7. Bring the stack back with `npm run dev` and tell me the URL to open. In the interface, the
   wallet button offers a "Test wallet" with the accounts Deployer, Alice, Bob and Carol; no
   browser extension is needed.

Rules. Do not change anything under contracts/src. Do not commit or push. Do not deploy to
Sepolia. If a script has a macOS problem (BSD sed, missing setsid or ss, bash 3.2), fix the
script in the smallest way that keeps it working on Linux, show me the diff, and explain it.
Report exact error text, not a summary of it.
```

## Why these steps

`npm run setup` calls `scripts/pin.sh`, which writes a fresh `FORK_BLOCK` into `.env`. The public
Sepolia endpoint keeps only recent state, so the block in `.env.example` is stale on any day but
the one it was written. `scripts/chain.sh` notices the "pruned" error, pins again, and rebuilds,
so a stale block heals itself. The scripts use `nohup` and `lsof` where macOS lacks `setsid` and
`ss`, and `sed -i.bak`, which both GNU sed and BSD sed accept.
