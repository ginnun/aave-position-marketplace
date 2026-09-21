# ADR-0007: What migrating to Aave V4 actually costs

Status: proposed, needs a decision · 2026-09-18

## Context

The brief asks for the newest Aave. Aave V4 is the newest: the official address book lists V1
through V4 and nothing later, and V4 holds three live markets, all on mainnet.

Everything below was read from `aave/aave-v4` at `main` and checked against Ethereum mainnet on a
fork pinned at block 26005234.

## What is live

| Market | Chain id | State |
|---|---|---|
| AaveV4Ethereum | 1 | 4 hubs, 13 active spokes, all holding code |
| AaveV4Avalanche | 43114 | live |
| AaveV4Arc | 5042 | live |

There is **no V4 testnet market**. Every Aave testnet market is still V3.

The Core spoke on Ethereum, `0x973a023A77420ba610f06b3858aD991Df6d85A08`, carries 12 reserves:
WETH (id 0), WBTC (1), cbBTC (2), wstETH (3), USDC (4 and 7), USDT (5 and 10), GHO (6),
frxUSD (8), EURC (9), USDG (11).

## The finding that matters

**Aave V4 has no flash loans.** The word does not appear in `IHub.sol`, `Hub.sol` or
`ISpoke.sol`. This project's whole migration design rests on V3's debt mode flash loan, which
carries collateral and debt across in one transaction at no premium. See ADR-0002. That primitive
is gone.

V4 offers something different in its place. Every action takes `onBehalfOf`:

```solidity
function supply(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
function borrow(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
function repay(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
```

and a user authorises a contract to use them with `setUserPositionManager(positionManager, approve)`,
or with a signature. Aave ships two reference managers: `GiverPositionManager` for supply and repay,
and `TakerPositionManager` for withdraw and borrow, the second gated by per reserve allowances.

That does not remove the need for flash liquidity. `Spoke.withdraw` calls
`_refreshAndValidateUserAccountData(onBehalfOf)` and that requires
`healthFactor >= HEALTH_FACTOR_LIQUIDATION_THRESHOLD` on every call. So the health factor is
checked per action, not at the end of a multicall. Pulling a user's collateral before their debt
is repaid still fails, and repaying their debt first still needs capital from somewhere.

## What carries over and what does not

Carries over unchanged, because it never depended on Aave:

- One isolated account per position, owned by an ERC-721. A sale moves the token, not the Aave
  position, so no protocol call happens during a purchase at all.
- Escrow is the lock.
- The marketplace: listing, fixed and dynamic pricing, guard rails, fee cap, emergency stop.

Has to be rewritten:

- Every call into Aave. V4 addresses a reserve by `(spoke, reserveId)`, not by asset address.
- Reading a position. `getUserAccountData` returns a different struct, with `totalDebtValueRay`,
  `riskPremium` and `avgCollateralFactor`.
- `migrateIn` and `migrateOut`, which need a new source of flash liquidity.
- The whole local environment. No V4 testnet means forking Ethereum mainnet, and mainnet has no
  faucet, so seeding changes from the Aave faucet to writing balances directly.

## Options

1. **V4 with an external flash loan.** Take flash liquidity from Balancer, Morpho or Uniswap
   instead of Aave. Keeps the one transaction promise. Cost: a new external dependency in the most
   security sensitive path, and it only works where that provider has liquidity, which is mainnet.
2. **V4 without migration.** Drop US-03 and US-06, and only open positions natively on the
   platform (US-04). Removes the product's main reason to exist.
3. **Stay on V3.** V3 is still live and maintained, carries 67 reserves on mainnet, and is the
   only version with a public testnet. Keeps the project deployable without real money.

## The conflict to settle first

The agreed scope puts mainnet, and therefore real money, out of reach. V4 exists only on
mainnet. So a V4 build can never run on a public testnet. It can run on a fork, locally or on a
hosted one, but a shared public demo would either use real money or need a fork exposed to the
internet.

Newest protocol and no real money are not both reachable today. That trade belongs to the product
owner, not to this document.
