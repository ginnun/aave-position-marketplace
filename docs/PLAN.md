# Plan

The plan below is the one that was followed. Each phase ended with a full test run before the next
one started.

## Phases

| Phase | Work | State |
|---|---|---|
| 0 | Read the stories. Check every Aave claim against the chain. Write `docs/research/aave-testnet.md`. | Done |
| 1 | Decide the architecture. Write the ADRs, the threat model, and this plan. | Done |
| 2 | Repository layout. One command for the local chain, with example positions. Price and clock controls. | Done |
| 3 | Contracts, with fork, fuzz and invariant tests. | Done |
| 4 | Indexer and read API, including the machine readable route set for US-29. | Done |
| 5 | Interface for epics 1 to 8. | Done |
| 6 | Browser tests for every must have story, headless, with wallet interaction. | Done |
| 7 | Public testnet deployment. | Done. Contracts are live on Ethereum Sepolia with a seeded listing. |
| 8 | Documentation and the final report. | Done |

## Milestones, in the order they were reached

1. **Migration works against the live market.** The riskiest piece, so it was built first. A
   debt mode flash loan carries a real position in and back out on a pinned Sepolia fork.
2. **Escrow and purchase.** Listing, guard rails, the atomic purchase, and the administrator
   limits, all under contract tests.
3. **The rules hold under random action sequences.** Six invariants, driven by a handler that
   lists, cancels, buys, strengthens, weakens and moves prices.
4. **One command brings the stack up.** A pinned fork, the platform deployed, four example
   positions, the indexer, and the interface.
5. **The whole flow runs in a headless browser.** A built in test wallet removes the need for a
   browser extension.

## Risks and what was done about them

| Risk | What was done | Result |
|---|---|---|
| Aave might refuse to carry debt across | Checked `FlashLoanLogic` in the source, then proved it on a fork before building anything else | Works. Two Aave limits found and worked around. See the research document. |
| Thin testnet liquidity could break flash loans | Measured the liquidity of every reserve | USDC has only 3,602 units. The example positions borrow USDT instead. |
| Testnet prices never move, so risk scenarios cannot be tested | Local chain installs its own price feeds through the Aave oracle | Price scenarios run locally. The limit is documented for the testnet. |
| A pinned fork block ages out of public RPC endpoints | `scripts/pin.sh` re-pins to a fresh block | Works, with the trade recorded in ADR-0005. |
| An interface race could let a user send a transaction that is bound to fail | Browser tests caught exactly this: a purchase offered before the token allowance was known | Fixed in three forms. The action is not offered until the state behind it is known. |
| A success message can vanish with the data it described | Browser tests caught this too, after a purchase and after a migration | The result now outlives the record it came from. |

## What is left

- **Static analysis.** `forge lint` runs clean of errors. Its warnings are reviewed in
  `docs/STATIC_ANALYSIS.md`.
