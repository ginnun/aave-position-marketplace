# ADR-0005: The local chain is a Sepolia fork pinned to one block

Status: accepted, 2026-09-18

## Context

US-36 asks for a realistic Aave environment that starts with one command. US-37 asks for movable
prices and a clock that can be moved forward. The order of preference in the brief is: no paid
service first, reproducible second, controllable prices third.

## Options

1. **A Sepolia fork pinned to one block**, using anvil `--fork-block-number`.
2. **A full local Aave V3 deployment**, using the `aave-v3-origin` deployment scripts.
3. **A mainnet fork.**

## Decision

Option 1.

## Reasons

| Criterion | Fork | Local deployment | Mainnet fork |
|---|---|---|---|
| No paid service | yes, public RPC works | yes | usually needs an archive RPC |
| Reproducible | yes, the block is pinned | yes | yes |
| Realistic configuration | yes, it is the real market | must be rebuilt by hand | yes |
| Faucet | yes, and it is open | must be written | none |
| Setup cost | low | high | low |

The fork brings the real market configuration for free: the LTV values, the liquidation
thresholds, the caps, the e-mode categories, and the frozen reserves. A local deployment would
mean rebuilding all of that by hand and keeping it current, and the tests would match the real
environment less closely.

Price control works by impersonating the Aave ACL admin on the fork and calling
`AaveOracle.setAssetSources` to install this project's own `MockAggregator` contracts. This only
runs on the local chain. `LocalSetup` and `SetPrice` both refuse to run when
`block.chainid == 11155111`.

## Consequences

- The local chain uses chain id **31337**, so a wallet does not confuse it with real Sepolia. The
  Aave addresses are the same, because the chain is a fork.
- The fork block is pinned by `FORK_BLOCK` in `.env`.
- **Known limit:** public RPC endpoints keep state for recent blocks only, so a pinned block stops
  working after a few days. `scripts/pin.sh` pins the fork to a fresh block. With an archive
  endpoint the block can stay pinned forever. This is a deliberate trade: the "no paid service"
  rule wins over the "pinned forever" rule.
