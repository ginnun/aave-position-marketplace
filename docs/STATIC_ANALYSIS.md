# Static analysis

Tool: `forge lint`, which ships with Foundry 1.8.3. Run it with:

```bash
cd contracts && forge lint
```

Result: **no errors**. The warnings below were each reviewed. Some were fixed. The rest are
recorded here with the reason they stand.

Slither was not available in this environment. A production review should add it.

## Fixed

| Warning | Where | Fix |
|---|---|---|
| `missing-events-access-control` | `PositionManager.setEscrow` | Added the `EscrowSet` event |
| `missing-zero-check` | `PositionAccount.initialize` | Added `ZeroManager` |
| `uninitialized-local` | `PositionManager.migrationBlocker` | The flag is now written explicitly |
| `unsafe-typecast` | `uint8(POOL.getUserEMode(...))` | Marked safe, with the reason: Aave stores e-mode category ids as `uint8` |
| `arbitrary-send-erc20` | `PositionManager._pullCollateral` | Marked intentional, with the reason: `from` is the caller of `migrateIn`, and that caller approved these aTokens |
| `environment-read-across-mutation` | Tests | Now read through `vm.getBlockTimestamp()` |

## Reviewed and left as they are

### `reentrancy-events`, 12 findings

Events are emitted after external calls. Three things make this safe:

1. Every state changing external function carries `nonReentrant`.
2. Purchases delete the listing before any transfer, which is the checks, effects, interactions
   order.
3. The ownership token moves with `transferFrom`, not `safeTransferFrom`, so no receiver callback
   runs.

Moving the events earlier would make them report a state that had not happened yet.

### `calls-loop`, 12 findings

External calls inside loops. Every loop runs over either the Aave reserve list, which holds 9
entries on this market, or the assets of one position, which is a subset of that. The bound is
the market's reserve count, and it is read from the chain rather than assumed.

### `unused-return`, 9 findings

Return values of `PositionAccount.execute` and `POOL.repay` are ignored on purpose. The account
call reverts on failure, so its return value carries nothing the caller needs. The repay amount is
not needed because the flash loan amount decides the transfer.

### `block-timestamp`, 5 findings

Listing expiry and the buyer deadline compare against `block.timestamp`. Both are measured in
hours and days, while a validator can move the timestamp by seconds. The comparison is not
sensitive at that scale.

### `reentrancy-no-eth`, 2 findings

Flagged inside `migrateIn` and `_moveCollateral`, where an external call happens before the ERC-721
owner map is written. Both sit inside `nonReentrant` functions, and the external call goes to the
Aave pool or to a `PositionAccount` this contract deployed.

### `unsafe-oz-erc721-mint`, 1 finding

`_mint` is used rather than `_safeMint`, deliberately. `_safeMint` calls `onERC721Received` on a
contract recipient, which would open a reentrancy path in `migrateIn` at the exact moment a
position is being assembled. A recipient that cannot handle ERC-721 tokens is the recipient's
problem, and `migrateIn` mints only to the caller.

### `missing-events-access-control`, 1 finding

`escrowSetter` is cleared inside `setEscrow`, and that same function emits `EscrowSet`. The change
is already visible in the log.

### `missing-zero-check`, 1 finding

`PositionAccount.execute` does not check that `target` is non zero. A call to the zero address
succeeds and does nothing. Only `PositionManager` can reach this function, and it never passes
zero.

## Coverage

```bash
cd contracts && forge coverage --no-match-coverage "(script|test|mocks)"
```

Coverage runs against a pinned fork, so it needs the same `SEPOLIA_RPC_URL` the tests use.
