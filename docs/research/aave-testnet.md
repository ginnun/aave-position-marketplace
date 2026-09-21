# Aave testnet research

Date: 2026-09-18. Every value below was read from the chain. None of it was written from memory.

## Which testnet

Sepolia is the Ethereum testnet with a live Aave V3 market and an open faucet (a contract that
gives out free test tokens). ethereum.org calls it "the recommended default testnet for
application development". Holesky is the testnet that was deprecated, in September 2025, and
Hoodi replaced it for validator and staking work, not for application work.

A replacement for Sepolia is under discussion, but nothing is settled. The proposal on the
Ethereum Magicians forum puts the replacement launch around Q1 2027 and the Sepolia sunset around
Q2 or Q3 2027, with a grace period where both run side by side. As of 2026-09-18 no name is
chosen, no replacement has launched, and ethereum.org does not mark Sepolia as deprecated. Some
blog posts claim a 30 September 2026 retirement date; that contradicts both ethereum.org and the
proposal thread, and appears to confuse Holesky's deprecation with Sepolia's.

Source: https://ethereum.org/en/developers/docs/networks/ and
https://ethereum-magicians.org/t/sepolia-testnet-replacement-sunsetting/28647

### Moving to another chain later

The chain specific facts live in two generated files. `contracts/src/config/AaveSepolia.sol` holds
the 26 addresses the contracts use, and `shared/assets.json` holds the 9 reserves the server and
the interface use. Both come from the official address book. Everywhere else the chain id appears,
it only separates "the public testnet" from "the local fork". Changing target chain means
regenerating those two files and updating the chain id guards.

Aave V3 has testnet markets on more than one chain. Ethereum Sepolia carries the most reserves:

| Market | Chain id | Reserves |
|---|---|---|
| Ethereum Sepolia | 11155111 | 9 |
| Scroll Sepolia | 534351 | 8 |
| Base Sepolia | 84532 | 6 |
| Avalanche Fuji | 43113 | 4 |
| Arbitrum Sepolia | 421614 | 2 |
| Optimism Sepolia | 11155420 | 2 |
 The addresses come from `@aave-dao/aave-address-book`, which is the current name of the official
registry. Each address was then called on the chain to make sure that it answers.

```bash
npm i @aave-dao/aave-address-book
node -e "console.log(require('@aave-dao/aave-address-book/dist/AaveV3Sepolia.js'))"
```

The work started against `@bgd-labs/aave-address-book` 4.44.22, the older package name. On
2026-09-18 every address was compared against `@aave-dao/aave-address-book` 4.68.1, and all 26
market addresses and all 6 asset addresses were unchanged. Use the `@aave-dao` package.

## Which Aave version

Aave V4 is live, and it runs on mainnet only. The address book lists three V4 markets: Ethereum
(chain 1), Avalanche (43114) and Arc (5042). There is no V4 testnet market. Every Aave testnet
market is still V3.

That settles the choice for this project. Mainnet is out of scope by the product brief, so V4 is
not reachable, and V3 is what a testnet build has to target. Ethereum Sepolia carries the most
reserves of any Aave testnet market.

V4 is still worth knowing about for the design. Its source tree carries position managers and
gateway contracts, which is the same problem this project solves on top of V3. If this ever moves
to mainnet, compare against what V4 already provides before porting the contracts as they are.

### How V4 work is tested, since there is no V4 testnet

Aave's own Foundry template for V4 answers this. Its `.env` asks for
`RPC_URL – RPC endpoint (Tenderly Virtual TestNet or public network)` and a spoke address on
Ethereum mainnet. So the supported path is a fork of mainnet, hosted by Tenderly or run locally
with `anvil --fork-url`, which is the same technique this project uses against Sepolia, one level
up.

There is a second path. `src/deployments` in `aave/aave-v4` is a deployment framework that brings
up a whole instance in order: AccessManager, Configurators, TreasurySpoke, Hubs, Spokes, Gateways
and PositionManagers, through `make deploy-precompile` and then `make deploy-contracts`. That runs
against a local chain and needs no fork, at the price of recreating the market configuration by
hand. ADR-0005 turned this option down for V3 for exactly that reason.

Checked on mainnet on 2026-09-18: `AaveV4Ethereum` lists 4 hubs and 13 active spokes, and the
addresses hold code. One caution, the example spoke in the template README,
`0x89914a22E30CDf88A06e801E407ca82520210a79`, has no code on Ethereum mainnet. Take V4 addresses
from `@aave-dao/aave-address-book` (`AaveV4Ethereum.ALL_HUBS` and `ALL_SPOKES`), not from that
example.

One practical consequence for this project if it ever targets V4: a mainnet fork has real
liquidity but no faucet, so funding test accounts moves from the Aave faucet to writing balances
directly, which anvil supports and the contract tests here already use through `deal`.

## Market state

| Check | Result |
|---|---|
| Number of reserves in `POOL.getReservesList()` | 9 |
| `POOL.FLASHLOAN_PREMIUM_TOTAL()` | 5, which is 0.05% |
| `Faucet.isPermissioned()` | `false`, so anyone can mint |
| `Faucet.MAX_MINT_AMOUNT()` | 10,000 whole units per call |
| Oracle base currency | US dollars with 8 decimals |

## Assets

| Asset | Decimals | LTV | Liquidation threshold | Collateral | Borrowable | Faucet | Pool liquidity |
|---|---|---|---|---|---|---|---|
| WETH | 18 | 80% | 82.5% | yes | **no** | **no**, wrap ether instead | 11,828 WETH |
| LINK | 18 | 70% | 75% | yes | yes | yes | 79.3 M LINK |
| WBTC | 8 | 70% | 75% | yes | yes | yes | 8.27 M WBTC |
| USDT | 6 | 75% | 80% | yes | yes | yes | 610,279 USDT |
| USDC | 6 | 80% | 85% | yes | yes | yes | **3,602 USDC** |
| DAI | 18 | 75% | 80% | yes | yes | yes | 203,224 DAI |

LTV means loan to value, the share of collateral value you may borrow against.

Two results matter for this project:

1. **You cannot borrow WETH on Sepolia.** Its `borrowingEnabled` flag is `false`, and the faucet
   does not mint it. To get WETH, wrap Sepolia ether with `deposit()`.
2. **USDC liquidity is thin, at 3,602 USDC.** A migration takes a flash loan (a loan that opens
   and closes inside one transaction) in the debt asset. If the debt asset were USDC, the loan
   would fail for lack of liquidity. The example positions therefore borrow **USDT**, which has
   610,279 units of liquidity. USDC stays fine as a payment asset, because payment never passes
   through a flash loan.

## Price sources

The Aave oracle reads small mock aggregator contracts, about 160 bytes of code each. They return
a fixed answer:

| Asset | Price |
|---|---|
| WETH | 4,000 USD |
| WBTC | 60,000 USD |
| LINK | 30 USD |
| USDC, USDT, DAI | 1 USD |

**These prices never move on the testnet.** The market simulation in US-37, where a falling price
lowers a health factor, invalidates a listing, or triggers a liquidation, can only be tested on
the local chain. The local chain solves this by calling `AaveOracle.setAssetSources` to point each
reserve at a mock feed this project controls. That call needs pool admin rights, so the local fork
impersonates the Aave ACL admin address.

## Flash loan behavior

Read from `FlashLoanLogic.executeFlashLoan` in `aave-v3-origin` v3.4.0. When
`interestRateModes[i]` is not zero:

- No premium is charged, because `totalPremiums[i]` is set to zero.
- The amount is not pulled back. Instead `BorrowLogic.executeBorrow` runs and writes the debt to
  `onBehalfOf`, with `releaseUnderlying: false`.
- `onBehalfOf` must have given credit delegation to the address that called `flashLoan`. Credit
  delegation is an Aave feature that lets one address open debt for another.
- The health factor check runs against `onBehalfOf`, so the collateral must already be there when
  the callback returns.

This behavior is the base of the migration flow. See `docs/adr/0002-migration-flash-loan.md`.

## Two Aave limits found during the work

1. `Pool.repay(asset, type(uint256).max, mode, onBehalfOf)` reverts with
   **`NO_EXPLICIT_AMOUNT_TO_REPAY_ON_BEHALF`, which is error code 40**, when `msg.sender` is not
   `onBehalfOf`. Repaying for another address needs an explicit amount. The migration flow
   therefore repays exactly the flash loan amount. Both values are read in the same block, so
   they are equal and the debt closes in full.
2. Variable debt tokens refuse `allowance()` and `transfer()` with `OPERATION_NOT_SUPPORTED`. Read
   a delegation amount with `borrowAllowance(delegator, delegatee)` instead.

## Testnet limits, in short

- Prices are fixed, so any scenario that needs a price move runs on the local chain only.
- USDC flash loan liquidity is low, so do not use USDC as a debt asset.
- The faucet gives at most 10,000 whole units per call. Larger amounts need a loop.
- Public Sepolia endpoints keep state for recent blocks only. A pinned fork block stops working
  after a few days. `scripts/pin.sh` pins the fork to a fresh block. An archive endpoint lets you
  pin one block forever.
