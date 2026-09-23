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
`borrow`, and `setEMode`. The check reads one fact, that the marketplace is the current owner of
the token, so there is no second state that can drift. `supply` and `repay` stay open, because
they only help the buyer.

**Proof.** `test_escrow_blocksWithdrawAndBorrow`, `test_escrow_blocksEModeChange`,
`invariant_listedPositionIsNotWeakened`. The
invariant compares scaled balances, which only change on a real withdraw or borrow, not through
interest.

### T-02 The position changes between the listing and the purchase

**Attack.** The price falls, a liquidation happens, or the seller raises the price, and the buyer
pays for something worse than they chose.

**Answer.** `buy` takes six guard rails and checks each one against chain state inside the
transaction: `maxPrice`, `minNetValueBase`, `maxDebtBase`, `minHealthFactor`, `deadline`, and
`paymentAsset`. A crossed limit reverts with `LimitExceeded(Limit)`, which names the limit. The
interface fills them from values read from the chain moments earlier, with one percent of slack,
and the buyer can change them.

**Proof.** `test_buy_rejectedWhenPriceAboveMax`, `test_buy_rejectedWhenDebtAboveMax`,
`test_buy_rejectedWhenHealthFactorBelowMin`, `test_buy_rejectedAfterOwnDeadline`,
`test_buy_refusesADifferentPaymentAsset`, `test_liquidationWhileListed_buyerProtected`.

### T-03 A liquidation during the listing

**Attack.** The position falls under a health factor of 1 and a liquidator takes part of the
collateral while the listing is open.

**Answer.** This cannot be blocked. Aave allows it, and that is correct. Two things limit the damage.
The seller's `minHealthFactor` makes the listing unbuyable before it gets there, and the buyer's
`minNetValueBase` refuses a purchase after the value fell.

**Proof.** `test_liquidationWhileListed_buyerProtected` runs a real `liquidationCall` on the fork.

### T-04 Two buyers, one position

**Attack.** Two purchases land in the same block and both take the position or both pay.

**Answer.** `buy` deletes the listing record before it touches any asset, which is the checks,
effects, interactions order. The second call finds no listing and reverts with `NotListed`, and no
asset moved.

**Proof.** `test_buy_secondBuyerFindsNothing`, `invariant_eachListingSellsOnce`.

### T-05 Reentrancy

**Attack.** A callback during a token transfer re-enters the marketplace or the manager.

**Answer.** Three layers. Every function that moves a token or a payment carries `nonReentrant`.
The administrator's setters and `setEscrow` do not, because they move nothing. The listing is
deleted before any transfer. The ownership token goes to the buyer with `transferFrom` rather than
`safeTransferFrom`, so no `onERC721Received` callback runs at all.

The flash loan callback is a special case. `executeOperation` checks three facts before it does
anything: the sender is the Aave pool, the initiator is this contract, and a migration is in
progress.

**Proof.** `test_buy_transfersOwnershipAndPaysSeller` asserts that the marketplace holds no
balance afterwards. `invariant_platformHoldsNothing` asserts it after every action sequence.
`test_executeOperation_refusesDirectCall` proves that the callback refuses a wrong sender, a wrong
initiator, and a call outside a migration.

### T-06 The administrator takes assets

**Attack.** The administrator moves a position or diverts a payment.

**Answer.** No such function exists. The administrator can set the fee rate, the fee address, the
emergency stop, and the payment asset list. The administrator can also hand the role to another
address in two steps. `MAX_FEE_BPS` is a `constant`, so the cap cannot be raised by anyone,
including through an upgrade, because the contracts are not upgradeable.
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
delegation it needs is granted by the fresh position account, not by the user. `migrateOut` is
different. The user grants that delegation, and only the user can lower it again, so an allowance
can remain after the migration. The interface asks for the debt plus 0.1 percent rather than an
unlimited amount. The move itself uses up the allowance, so what remains is at most that 0.1
percent. The manager has one path that borrows against a user's delegation, `migrateOut`, and that
path accepts only the caller as the target. A third party cannot use the leftover allowance. A user
who wants it gone calls `approveDelegation(manager, 0)` on the debt token.

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

**Attack.** An owner calls `transferFrom` straight to the marketplace instead of `list`. Without a
guard, the token sits there with no listing record, and nobody can move it out.

**Answer.** `PositionManager._update` refuses every transfer into the marketplace that the
marketplace did not start itself, with `DirectEscrowTransfer`. This covers the owner, an approved
operator, `safeTransferFrom`, and a mint. The only way into escrow is `list`. A rescue function is
deliberately absent, because it gives the administrator power to move a token, and that
contradicts US-17. The guard is inactive until `setEscrow` runs, and no token exists at that point
in the deployment script.

**Proof.** `test_escrow_directTransferReverts`, `test_escrow_directSafeTransferReverts`,
`test_escrow_approvedOperatorCannotTransfer`. `invariant_escrowMatchesListing` proves the
platform's own code never creates a token in escrow without a listing.

### T-13 Migration into an unsupported position

**Attack.** A position in isolation mode, with siloed borrowing, or on a paused reserve is carried
in and ends up stuck or wrongly valued.

**Answer.** `migrationBlocker(user)` checks nine conditions before the transaction and returns the
first reason it finds: no collateral, isolation mode, siloed borrowing, an inactive, frozen, or
paused reserve, debt above the borrowing limit, borrowing disabled, and flash loans disabled.
`migrateIn` refuses with `MigrationBlocked(Blocker)`, and the interface shows the reason as a
sentence.

**Proof.** `test_migrateIn_refusesEmptyPosition`, `test_migrateIn_refusesDebtAboveTheBorrowingLimit`,
`test_migrateIn_refusesAPausedReserve`, `test_migrateIn_refusesAFrozenDebtReserve`,
`test_migrateIn_refusesSiloedBorrowing`, `test_migrateIn_refusesIsolationMode`,
`test_migrateIn_refusesBorrowingDisabled`, `test_migrateIn_refusesFlashLoanDisabled`. Each one
changes the live reserve configuration through the Aave `PoolConfigurator` on the fork.
`ReserveInactive` has no test, because Aave only deactivates a reserve with zero liquidity, and no
reserve on the fork has that. `test_migrateOut_refusesEModeMismatch` covers the one blocker that
applies on the way out.

### T-14 Rounding

**Attack.** Repeated rounding drains value from one side.

**Answer.** The price computation uses `Math.mulDiv` and rounds up, toward the seller, at each
step. The fee floors, and the seller receives the price minus the fee, so the two always add up to
the price exactly. The valuation sums each reserve with a plain division, which loses less than
one base currency unit per reserve. Collateral balances are read at transfer time, so accrued
interest moves with the position instead of being left behind.

**Proof.** `test_roundTrip_preservesValue` with a relative tolerance of 1e-6, and
`invariant_paymentSplitIsExact`.

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
