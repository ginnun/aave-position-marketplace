# Assumptions

Where a requirement left room, the most reasonable reading was chosen and written down here.
None of these is a decision taken without telling you. Each one rests on a default named in the
project brief, or on chain data that was checked.

## Environment and network

| # | Assumption | Basis |
|---|---|---|
| A-01 | The target testnet is Sepolia. | Its Aave V3 market is live, its faucet is open, and it is the most common Ethereum testnet. |
| A-02 | The local chain uses chain id 31337. | So a wallet does not confuse it with the real Sepolia network entry. The Aave addresses are the same, because the chain is a fork. |
| A-03 | The fork block is pinned in `.env` and refreshed with `scripts/pin.sh` when needed. | Public RPC endpoints do not keep old state. See ADR-0005. |
| A-04 | No testnet deployment happens until a private key is supplied. | The brief leaves steps that need a secret until last. |

## Product rules

| # | Assumption | Basis |
|---|---|---|
| A-05 | The platform fee is 0.5%, with a fixed cap of 2%. | The default in the project brief. |
| A-06 | USDC, USDT and DAI are allowlisted as payment assets, with USDC as the default. | They are the US dollar stablecoins on the testnet. |
| A-07 | The example positions borrow USDT. | USDC flash loan liquidity is only 3,602 USDC. See `docs/research/aave-testnet.md`. |
| A-08 | The cap on a dynamic price rate is 150%. | A reading of "a reasonable upper bound" in US-09. It allows a premium sale and blocks absurd values. |
| A-09 | A listing lasts at most 90 days. | To limit how long a stale listing can sit in the market. |
| A-10 | A listing's `minHealthFactor` is at least 1.0. | A threshold under 1.0 has no meaning, because the position is already open to liquidation. |
| A-11 | Buyer guard rails are filled from current values with **one percent** of slack. | A measurable reading of "a reasonable tolerance" in US-23. |
| A-12 | Rounding always favors the seller. | The project brief. |

## Scope readings

| # | Assumption | Basis |
|---|---|---|
| A-13 | US-07, a free transfer to another address, was not built. | Its priority is "could have". The standard ERC-721 `transferFrom` already does the job, and a listed position sits in escrow, so it cannot be transferred. |
| A-14 | The US-27 risk alert is an interface threshold stored in the browser. | "Another notification channel may be preferred" is not a requirement. |
| A-15 | US-28, the quick sale, is a flag on the listing and a separate tag in the market. | The comparison against a liquidation loss is shown through the discount percentage. |
| A-16 | US-35 metrics are read on the administration page. | Its priority is "could have". |
| A-17 | The aToken approval and the credit delegation are separate transactions. | "In one transaction" in US-03 covers the migration itself. Approvals are preparation, and the interface presents them that way. |
| A-18 | Positions in isolation mode or with siloed borrowing are refused before the transaction. | The last acceptance criterion of US-03: unsupported kinds are refused in a way the user understands. |

## Technical readings

| # | Assumption | Basis |
|---|---|---|
| A-19 | The server is the basis of no security decision. While it is down, chain transactions are unaffected. | The project brief. |
| A-20 | The indexer keeps state in memory and rebuilds it from the chain on every start. | See ADR-0006. |
| A-21 | Payment is pushed rather than pulled. | The test assets have no blocklist. A pull model for a real network is in `docs/SUGGESTIONS.md`. |
| A-22 | Rounding differences of one to three wei are accepted. | A natural result of Aave's scaled balance accounting. Tests use `assertApproxEqRel` with a relative tolerance of 1e-6. |
