# Tasks

Each task names the story it serves and how it was proved. Dependencies run top to bottom inside
a group.

## Group A, research

| # | Task | Serves | Proof |
|---|---|---|---|
| A1 | Read the Aave V3 Sepolia addresses from the official address book | all | `contracts/src/config/AaveSepolia.sol` |
| A2 | Check every address and every reserve setting on the chain | all | `docs/research/aave-testnet.md` |
| A3 | Measure flash loan liquidity per reserve | US-03, US-06 | Same document |
| A4 | Read the flash loan debt mode path in the Aave source | US-03, US-06 | ADR-0002 |

## Group B, contracts. Depends on A

| # | Task | Serves | Proof |
|---|---|---|---|
| B1 | `PositionAccount`, a minimal clone that only the manager may drive | US-03 | `PositionAccount.sol` |
| B2 | `PositionManager` as an ERC-721 and position factory | US-03, US-04 | `test_migrateIn_withoutDebt` |
| B3 | `migrateIn` with a debt mode flash loan | US-03 | `test_migrateIn_carriesCollateralAndDebt` |
| B4 | `migrateOut` | US-06 | `test_migrateOut_returnsPositionToOwner`, `test_roundTrip_preservesValue` |
| B5 | Position management, with escrow aware limits | US-05, US-15, US-16 | `test_escrow_blocksWithdrawAndBorrow`, `test_escrow_allowsSupplyAndRepay` |
| B6 | `migrationBlocker`, which refuses unsupported positions before the transaction | US-03 | `test_migrateIn_refusesEmptyPosition` |
| B7 | `Marketplace` escrow and listing | US-08, US-14, US-28 | `test_list_movesTokenIntoEscrow` |
| B8 | Dynamic pricing from the Aave oracle, with a seller floor | US-09 | `test_dynamicPrice_followsNetValue`, `test_dynamicPrice_honoursSellerFloor` |
| B9 | Seller health factor threshold | US-10 | `test_healthFactorThreshold_invalidatesAndRecovers` |
| B10 | Cancel and expiry | US-11, US-13 | `test_cancel_returnsPositionToSeller`, `test_closeExpired_anyoneCanCallAndSellerGetsItBack` |
| B11 | Atomic purchase with buyer guard rails | US-22, US-23, US-26 | `test_buy_transfersOwnershipAndPaysSeller`, `test_buy_rejectedWhenPriceAboveMax`, `test_buy_secondBuyerFindsNothing` |
| B12 | Fee with a fixed cap, and the emergency stop | US-33, US-34 | `test_feeCannotExceedHardCap`, `test_pause_stopsBuyingButNotCancelling` |
| B13 | Invariants over random action sequences | US-17, US-25 | `Invariants.t.sol`, six properties |
| B14 | A liquidation scenario on the fork | section 5.3 item 4 | `test_liquidationWhileListed_buyerProtected` |

## Group C, local environment. Depends on B

| # | Task | Serves | Proof |
|---|---|---|---|
| C1 | Pin a fork block that the public endpoint still serves | US-36 | `scripts/pin.sh` |
| C2 | Deploy script that records addresses per chain | US-36, US-38 | `deploy/31337.json` |
| C3 | Movable price feeds through the Aave oracle | US-37 | `scripts/price.sh` |
| C4 | Clock control | US-37 | `scripts/warp.sh` |
| C5 | Four example positions: healthy, listed, close to liquidation, multi asset | US-36 | `script/Seed.s.sol` |
| C6 | One command up, one command reset | US-36 | `scripts/dev.sh`, `scripts/reset.sh` |

## Group D, server. Depends on C

| # | Task | Serves | Proof |
|---|---|---|---|
| D1 | Index the logs, rebuilding on start and re-reading the recent tail | US-18, US-30 | `server/src/indexer.js` |
| D2 | Read live values in one multicall per pass | US-18, US-21 | Same file |
| D3 | Filtering and sorting | US-19 | `01-market.spec.ts` |
| D4 | History per address and per position | US-30 | `02-buy.spec.ts` |
| D5 | Machine readable routes, a change stream, and an OpenAPI description | US-29 | `docs/API.md`, `01-market.spec.ts` |
| D6 | Metrics | US-35 | `05-admin.spec.ts` |

## Group E, interface. Depends on D

| # | Task | Serves | Proof |
|---|---|---|---|
| E1 | Wallet connection, network check, and a built in test wallet | US-01 | Every browser test |
| E2 | Market list with the risk bar | US-18, US-19 | `01-market.spec.ts` |
| E3 | Listing detail with a liquidation price estimate | US-20 | `01-market.spec.ts` |
| E4 | Purchase preview, a fresh chain read, and self filling guard rails | US-21, US-23, US-24 | `02-buy.spec.ts` |
| E5 | Carry a position in, with the approval steps | US-02, US-03 | `03-migrate.spec.ts` |
| E6 | Position management with a health factor preview | US-05 | `04-guards.spec.ts` |
| E7 | Listing form with a discount preview | US-08, US-09, US-14, US-28 | `04-guards.spec.ts` |
| E8 | Carry a position out, with credit delegation | US-06 | `03-migrate.spec.ts` |
| E9 | Activity | US-30 | `02-buy.spec.ts` |
| E10 | Administration and metrics | US-33, US-34, US-35 | `05-admin.spec.ts` |
| E11 | Risk alert threshold | US-27 | Stored in the browser |
| E12 | Turkish and English, and a phone layout | non functional | `06-mobile.spec.ts` |

## Group F, verification. Depends on E

| # | Task | Serves | Proof |
|---|---|---|---|
| F1 | Browser tests for every must have story | US-39 | `e2e/tests` |
| F2 | One command for all tests | US-39 | `scripts/test.sh` |
| F3 | Documentation a new developer can follow in half an hour | US-40 | `README.md` |
| F4 | Testnet deployment scripts | US-38 | `scripts/deploy-testnet.sh`. Run on Sepolia, addresses in `deploy/11155111.json`. |
