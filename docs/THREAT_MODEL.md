# Threat model

The rule behind every entry: the chain decides. The interface and the server only inform.

## What the system protects

| Asset | Who must not lose it |
|---|---|
| The position, meaning its collateral and its debt | The seller, until a payment arrives |
| The payment | The buyer, unless the position arrives |
| Management rights over a position | Anyone but the current owner |
| The fee rate ceiling | Every user, against the administrator |

## Threats and what answers them

### T-01 A seller weakens a listed position

**Attack.** After listing, the seller withdraws collateral or borrows more, so the buyer receives
less than they saw.

**Answer.** While the ownership token sits in escrow, `PositionManager` refuses `withdraw`,
`borrow`, and `setEMode`. The check reads one fact, `ownerOf(tokenId) == escrow`, so there is no
second state that could drift. `supply` and `repay` stay open, because they only help the buyer.

**Proof.** `test_escrow_blocksWithdrawAndBorrow`, `invariant_listedPositionIsNotWeakened`. The
invariant compares scaled balances, which only change on a real withdraw or borrow, not through
interest.

### T-02 The position changes between the listing and the purchase

**Attack.** The price falls, a liquidation happens, or the seller raises the price, and the buyer
pays for something worse than they chose.

**Answer.** `buy` takes five guard rails and checks each one against chain state inside the
transaction: `maxPrice`, `minNetValueBase`, `maxDebtBase`, `minHealthFactor`, `deadline`. A
crossed limit reverts with `LimitExceeded(Limit)`, which names the limit. The interface fills them
from values read from the chain moments earlier, with one percent of slack, and the buyer can
change them.

**Proof.** `test_buy_rejectedWhenPriceAboveMax`, `test_buy_rejectedWhenDebtAboveMax`,
`test_buy_rejectedAfterOwnDeadline`, `test_liquidationWhileListed_buyerProtected`.

### T-03 A liquidation during the listing

**Attack.** The position falls under a health factor of 1 and a liquidator takes part of the
collateral while the listing is open.

**Answer.** This cannot be blocked. Aave allows it, and it should. Two things limit the damage.
The seller's `minHealthFactor` makes the listing unbuyable before it gets there, and the buyer's
`minNetValueBase` refuses a purchase after value has been lost.

**Proof.** `test_liquidationWhileListed_buyerProtected` runs a real `liquidationCall` on the fork.

### T-04 Two buyers, one position

**Attack.** Two purchases land in the same block and both take the position or both pay.

**Answer.** `buy` deletes the listing record before it touches any asset, which is the checks,
effects, interactions order. The second call finds no listing and reverts with `NotListed`, and no
asset has moved.

**Proof.** `test_buy_secondBuyerFindsNothing`, `invariant_eachListingSellsOnce`.

### T-05 Reentrancy

**Attack.** A callback during a token transfer re-enters the marketplace or the manager.

**Answer.** Three layers. Every state changing external function carries `nonReentrant`. The
listing is deleted before any transfer. The ownership token goes to the buyer with `transferFrom`
rather than `safeTransferFrom`, so no `onERC721Received` callback runs at all.

The flash loan callback is a special case. `executeOperation` accepts a call only when the sender
is the Aave pool, the initiator is this contract, and a migration is in progress.

**Proof.** `test_buy_transfersOwnershipAndPaysSeller` asserts that the marketplace holds no
balance afterwards. `invariant_platformHoldsNothing` asserts it after every action sequence.

### T-06 The administrator takes assets

**Attack.** The administrator moves a position or diverts a payment.

**Answer.** No such function exists. The administrator can set the fee rate, the fee address, the
emergency stop, and the payment asset list. `MAX_FEE_BPS` is a `constant`, so the cap cannot be
raised by anyone, including through an upgrade, because the contracts are not upgradeable.
`cancel` and `closeExpired` send the position to the seller and nowhere else.

**Proof.** `test_adminCannotMovePositionOrFunds`, `test_feeCannotExceedHardCap`,
`invariant_feeStaysUnderCap`.

### T-07 The emergency stop traps a seller

**Attack.** The administrator stops the platform and the seller cannot get their position back.

**Answer.** The stop only closes `list`, `updateListing`, and `buy`. `cancel`, `closeExpired`,
position management, and `migrateOut` all keep working.

**Proof.** `test_pause_stopsBuyingButNotCancelling`, `test_pause_stillAllowsMigrateOutAfterCancel`.

### T-08 Price manipulation

**Attack.** The price of the payment asset is pushed to make a dynamic price wrong.

**Answer.** The Aave oracle is the only price source, which keeps the valuation aligned with the
protocol's own risk accounting. A price pushed down inflates the asking price, and the buyer's
`maxPrice` stops it. A price pushed up collapses the asking price, and the seller's `minPrice`
floor stops it.

**Remaining risk.** The Aave oracle does not check for staleness. A frozen feed makes the net
value wrong in a way neither guard rail catches. See `docs/SUGGESTIONS.md` item 3.

### T-09 Leftover credit delegation

**Attack.** A migration leaves the manager able to open debt on a user account later.

**Answer.** `migrateIn` resets every delegation it granted to zero in the same transaction. The
delegation it needs is granted by the fresh position account, not by the user.

**Proof.** `test_migrateIn_carriesCollateralAndDebt` asserts that `borrowAllowance` is zero at the
end.

### T-10 A blocked payment recipient

**Attack.** The payment asset blocklists the seller, so the push payment reverts and the position
cannot be sold.

**Answer.** Not handled. The payment asset allowlist limits this to assets the administrator
chose, and the test assets have no blocklist. A pull model is the fix for a real network. See
`docs/SUGGESTIONS.md` item 1.

### T-11 The token sold outside the platform

**Attack.** The owner sells the ERC-721 on another marketplace, where the buyer has no guard rails
and sees no live risk data.

**Answer.** Not handled, and it is a deliberate consequence of ADR-0001. Options are in
`docs/SUGGESTIONS.md` item 2.

### T-12 A token sent to the marketplace by mistake

**Attack.** An owner calls `transferFrom` straight to the marketplace instead of `list`. The token
stays there with no listing record.

**Answer.** Not handled. A rescue function would give the administrator power to move a token,
which contradicts US-17. `invariant_escrowMatchesListing` proves the platform's own code never
creates this state.

### T-13 Migration into an unsupported position

**Attack.** A position in isolation mode, with siloed borrowing, or on a paused reserve is carried
in and ends up stuck or wrongly valued.

**Answer.** `migrationBlocker(user)` checks the case before the transaction and returns a reason.
`migrateIn` refuses with `MigrationBlocked(Blocker)`, and the interface shows the reason as a
sentence.

**Proof.** `test_migrateIn_refusesEmptyPosition`.

### T-14 Rounding

**Attack.** Repeated rounding drains value from one side.

**Answer.** Every division uses `Math.mulDiv` with an explicit rounding mode, and the direction is
always toward the seller. Collateral balances are read at transfer time, so accrued interest moves
with the position instead of being left behind.

**Proof.** `test_roundTrip_preservesValue` with a relative tolerance of 1e-6.

### T-15 The server lies

**Attack.** The indexer is compromised and serves wrong prices or wrong positions.

**Answer.** The server holds no rights. Every number that matters is read from the chain again
inside the buy transaction, and every limit is checked by the contract. The worst a bad server can
do is show a misleading list. A purchase started from it still cannot break the buyer's guard
rails.

## What is out of scope

- Aave itself. If the protocol has a bug, this platform inherits it.
- Wallet security and phishing.
- Denial of service through public RPC endpoints. The interface reports the failure and retries.
