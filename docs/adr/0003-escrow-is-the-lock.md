# ADR-0003: Escrow is the lock, and there is no separate lock state

Status: accepted, 2026-09-18

## Context

A listed position must not be weakened by its seller, per US-15, but it must still be open to
strengthening, per US-16. A listed position must also leave escrow through exactly three doors:
a sale, a cancellation, or an expiry. That is US-17.

## Options

1. **Hold the ownership token in escrow and read the lock from token ownership.**
2. **Leave the token with the seller and keep a separate `locked` flag in the contract.**

## Decision

Option 1. `PositionManager.isEscrowed(tokenId)` returns only this:

```solidity
address(escrow) != address(0) && _ownerOf(tokenId) == address(escrow)
```

The first term keeps every position unlocked until the marketplace is linked.

## Reasons

A separate flag is a second source of truth, and every state where the two disagree is a bug. If
the token is in escrow, the position is listed. If it is not, the position is not listed. Those
two sentences always mean the same thing, and an invariant test proves it
(`invariant_escrowMatchesListing`).

Management rights are a second question. While the token sits in escrow, the answer to "who may
manage this position" is the marketplace's `sellerOf(tokenId)`. The seller can therefore add
collateral and repay debt while listed, but cannot withdraw collateral or borrow more.

## Consequences

- `PositionManager` knows the marketplace through the `IEscrow` interface. The deployer sets the
  link once, with `setEscrow`, and nobody can change it after that. The zero address is refused,
  so the single call cannot be wasted.
- Weakening actions are `withdraw`, `borrow`, and `setEMode`. They are refused while listed.
- Strengthening actions are `supply` and `repay`. They are always open.
- The marketplace has no function that sends a position to a third address. `cancel` and
  `closeExpired` return it to the seller only, and both work during an emergency stop.
- A token cannot enter the marketplace outside `list`. `PositionManager` refuses any transfer to
  the marketplace that the marketplace did not start itself, so no token gets stuck without a
  listing record. See `docs/THREAT_MODEL.md` T-12.
