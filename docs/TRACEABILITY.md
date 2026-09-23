# Traceability

Every story maps to at least one test. "Contract" tests live in `contracts/test` and run against a
pinned fork of the live Aave V3 Sepolia market. "Browser" tests live in `e2e/tests` and drive the
real interface with a wallet, headless.

Run them with:

```bash
npm run test            # both suites
npm run test:contracts  # contracts only
npm run test:e2e        # browser only
```

## Must have stories

| Story | Built in | Test | Kind |
|---|---|---|---|
| US-01 Connect a wallet | `web/src/lib/wallet.tsx`, `components/WalletButton.tsx` | `06-mobile.spec.ts`, and every browser test calls `connect()` | Browser |
| US-02 See my Aave position | `pages/Migrate.tsx`, `PositionManager.scan` | `03-migrate.spec.ts` "a plain Aave position becomes tradable" | Browser |
| US-03 Make a position tradable | `PositionManager.migrateIn` | `test_migrateIn_carriesCollateralAndDebt`, `test_migrateIn_withoutDebt`, `test_migrateIn_refusesEmptyPosition`, `test_migrateIn_refusesDebtAboveTheBorrowingLimit`, `test_migrateIn_refusesAPausedReserve`, `test_migrateIn_refusesAFrozenDebtReserve`, `test_migrateIn_refusesSiloedBorrowing`, `test_migrateIn_refusesIsolationMode`, `test_migrateIn_refusesBorrowingDisabled`, `test_migrateIn_refusesFlashLoanDisabled`, `03-migrate.spec.ts` | Contract, Browser |
| US-05 Manage a tradable position | `PositionManager.supply/withdraw/borrow/repay` | `test_escrow_allowsSupplyAndRepay`, `test_strangerCannotManageListedPosition`, `test_buy_sellerLosesControlImmediately`, `04-guards.spec.ts` "the seller can still strengthen" | Contract, Browser |
| US-06 Carry a position back out | `PositionManager.migrateOut` | `test_migrateOut_returnsPositionToOwner`, `test_migrateOut_refusesEModeMismatch`, `test_roundTrip_preservesValue`, `03-migrate.spec.ts` "carries a position back" | Contract, Browser |
| US-08 List at a fixed price | `Marketplace.list` | `test_list_movesTokenIntoEscrow`, `test_list_rejectsUnknownPaymentAsset`, `04-guards.spec.ts` "lists at a fixed price" | Contract, Browser |
| US-09 Price as a share of net value | `Marketplace._price` | `test_dynamicPrice_followsNetValue`, `test_dynamicPrice_honoursSellerFloor`, `01-market.spec.ts` "the detail page explains the risk" | Contract, Browser |
| US-10 Health factor threshold | `Marketplace.buy`, `ListingInvalid` | `test_healthFactorThreshold_invalidatesAndRecovers`, `04-guards.spec.ts` "a price fall invalidates the listing" | Contract, Browser |
| US-11 Cancel a listing | `Marketplace.cancel` | `test_cancel_returnsPositionToSeller`, `test_cancel_onlySeller`, `04-guards.spec.ts` "the seller cancels" | Contract, Browser |
| US-13 Close an expired listing | `Marketplace.closeExpired` | `test_closeExpired_anyoneCanCallAndSellerGetsItBack`, `test_buy_rejectedAfterExpiry`, `04-guards.spec.ts` "an expired listing stops being buyable" | Contract, Browser |
| US-15 A listed position cannot be weakened | `PositionManager.notEscrowed` | `test_escrow_blocksWithdrawAndBorrow`, `test_escrow_blocksEModeChange`, `test_escrow_blocksMigrateOut`, `invariant_listedPositionIsNotWeakened`, `04-guards.spec.ts` "cannot weaken" | Contract, Invariant, Browser |
| US-16 A listed position can be strengthened | `PositionManager.supply/repay` | `test_escrow_allowsSupplyAndRepay`, `04-guards.spec.ts` "can still strengthen" | Contract, Browser |
| US-17 The position cannot be lost | `Marketplace` has no admin transfer | `test_escrow_directTransferReverts`, `test_escrow_directSafeTransferReverts`, `test_escrow_approvedOperatorCannotTransfer`, `test_adminCannotMovePositionOrFunds`, `invariant_escrowMatchesListing`, `test_pause_stopsBuyingButNotCancelling` | Contract, Invariant |
| US-18 See active listings | `server/src/index.js`, `pages/Market.tsx` | `01-market.spec.ts` "the market shows the seeded listings" | Browser |
| US-20 Listing detail | `pages/Listing.tsx` | `01-market.spec.ts` "the detail page explains the risk" | Browser |
| US-21 How fresh the data is | `pages/Listing.tsx` `refresh()` | `01-market.spec.ts` checks the block line, `02-buy.spec.ts` reads the chain again before buying | Browser |
| US-22 Buy in one transaction | `Marketplace.buy` | `test_buy_transfersOwnershipAndPaysSeller`, `test_buy_sellerCannotBuyOwnListing`, `02-buy.spec.ts` "buy a listed position" | Contract, Browser |
| US-23 Buyer guard rails | `Marketplace.BuyLimits` | `test_buy_rejectedWhenPriceAboveMax`, `test_buy_rejectedWhenDebtAboveMax`, `test_buy_rejectedWhenHealthFactorBelowMin`, `test_buy_rejectedAfterOwnDeadline`, `04-guards.spec.ts` "a guard rail that is crossed" | Contract, Browser |
| US-24 Purchase preview | `pages/Listing.tsx` `BuyDialog` | `02-buy.spec.ts` checks fee, total and the position received | Browser |
| US-25 The seller is paid | `Marketplace.buy` | `test_buy_transfersOwnershipAndPaysSeller`, `invariant_paymentSplitIsExact`, `02-buy.spec.ts` "the sale appears in the history" | Contract, Invariant, Browser |
| US-26 Two buyers, one position | `Marketplace.buy` deletes first | `test_buy_secondBuyerFindsNothing`, `invariant_eachListingSellsOnce`, `02-buy.spec.ts` "cannot be bought again" | Contract, Invariant, Browser |
| US-31 My positions on one screen | `pages/Positions.tsx` | `02-buy.spec.ts` "now managed by the buyer" | Browser |
| US-32 List again after buying | `pages/Position.tsx` | `test_buyerCanRelistAndMigrateOut`, `04-guards.spec.ts` "relists what she just bought" | Contract, Browser |
| US-33 Fee management | `Marketplace.setFee` | `test_feeCannotExceedHardCap`, `test_onlyOwnerChangesFee`, `invariant_feeStaysUnderCap`, `05-admin.spec.ts` | Contract, Invariant, Browser |
| US-36 Local environment | `scripts/chain.sh`, `scripts/dev.sh`, `scripts/reset.sh` | `scripts/e2e.sh` rebuilds the chain before every browser run | Browser |
| US-37 Market simulation | `scripts/price.sh`, `scripts/warp.sh`, `MockAggregator` | `test_healthFactorThreshold_invalidatesAndRecovers`, `04-guards.spec.ts` uses `setPrice` and `warp` | Contract, Browser |
| US-38 Testnet environment | `scripts/deploy-testnet.sh`, `script/Deploy.s.sol` | Deployed and seeded on Sepolia. Addresses in `deploy/11155111.json` | Chain |
| US-39 Automated checks | This table, `scripts/test.sh` | The suites themselves | — |
| US-40 Documentation | `README.md` | Followed by hand from a clean checkout | — |

## Should have stories

| Story | Built in | Test |
|---|---|---|
| US-04 Open a position from scratch | `PositionManager.createPosition` plus supply and borrow | `script/Seed.s.sol` `_multiAsset`, `test_buyerCanRelistAndMigrateOut` |
| US-12 Update a listing | `Marketplace.updateListing` | Covered by contract checks in `_validate`. No dedicated browser test. |
| US-14 Private listing | `Marketplace.buy` `allowedBuyer` | `test_privateListing_onlyNamedBuyer` |
| US-19 Filter and sort | `server/src/index.js` `getListings` | `01-market.spec.ts` "filtering by asset and by health factor" |
| US-27 Risk alert | `pages/Positions.tsx` | No dedicated test. The threshold is stored in the browser. |
| US-28 Quick sale | `Marketplace.Listing.quickSale` | `01-market.spec.ts` checks the tag, `/api/listings?quickSale=true` |
| US-29 Watch and buy from a program | `server/src/openapi.json`, `/api/stream` | `01-market.spec.ts` "available to a program" |
| US-30 Activity | `/api/history`, `pages/History.tsx` | `02-buy.spec.ts` "the sale appears in the history" |
| US-34 Emergency stop | `Marketplace.setPaused` | `test_pause_stopsBuyingButNotCancelling`, `test_pause_stopsNewListings`, `test_pause_stillAllowsMigrateOutAfterCancel`, `05-admin.spec.ts` |

## Could have stories

| Story | State |
|---|---|
| US-07 Transfer to another address | Not built. The standard ERC-721 `transferFrom` covers it, and a listed position is in escrow, so it cannot be transferred. See A-13. |
| US-35 Platform metrics | Built. `/api/stats` and the administration page. `05-admin.spec.ts` "metrics count the sales". |

## Required scenarios from the brief, section 5.3

| # | Scenario | Test |
|---|---|---|
| 1 | Carry in, list, buy, manage, carry back | `test_buyerCanRelistAndMigrateOut`, `03-migrate.spec.ts` |
| 2 | Dynamic price, price move, then a `maxPrice` refusal | `test_dynamicPrice_followsNetValue`, `test_buy_rejectedWhenPriceAboveMax`, `04-guards.spec.ts` |
| 3 | Health factor falls, listing invalid, seller tops up, sale completes | `test_healthFactorThreshold_invalidatesAndRecovers`, `04-guards.spec.ts` "a price fall invalidates the listing" |
| 4 | Liquidation while listed, purchase refused | `test_liquidationWhileListed_buyerProtected` |
| 5 | Cancel, and recovery after expiry | `test_cancel_returnsPositionToSeller`, `test_closeExpired_anyoneCanCallAndSellerGetsItBack` |
| 6 | Blocked and allowed actions while listed | `test_escrow_blocksWithdrawAndBorrow`, `test_escrow_allowsSupplyAndRepay` |
| 7 | Two purchases of the same listing | `test_buy_secondBuyerFindsNothing` |
| 8 | A private listing refuses the wrong buyer | `test_privateListing_onlyNamedBuyer` |
| 9 | Cancel and carry out during an emergency stop | `test_pause_stopsBuyingButNotCancelling`, `test_pause_stillAllowsMigrateOutAfterCancel` |

## Note on US-38

The platform is deployed on Ethereum Sepolia and holds a seeded listing. The addresses are in
`deploy/11155111.json` and in the README. To deploy your own, set `DEPLOYER_PRIVATE_KEY` in `.env`
and run `npm run deploy:testnet`. The script refuses to start without that key, and it checks the
balance before it spends anything.
