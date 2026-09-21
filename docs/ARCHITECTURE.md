# Architecture

## Overview

The system has four layers. Every security decision happens in the bottom layer, on the chain.

```
┌──────────────────────────────────────────────────────────────┐
│ Interface (web/)   Vite + React + viem                       │
│ Connects a wallet, shows a preview, sends transactions.      │
│ Nothing it displays is the basis of a decision.              │
└───────────┬───────────────────────────────┬──────────────────┘
            │ reads (HTTP)                  │ writes (JSON-RPC)
            ▼                               │
┌──────────────────────────────────────┐    │
│ Server (server/)   Node + viem       │    │
│ Indexes chain logs into memory.      │    │
│ Serves listings, filters, history.   │    │
│ Holds no rights of any kind.         │    │
└───────────┬──────────────────────────┘    │
            │ reads (JSON-RPC)              │
            ▼                               ▼
┌──────────────────────────────────────────────────────────────┐
│ Platform contracts (contracts/src/)                          │
│   PositionManager   ERC-721, position management, migration  │
│   Marketplace       escrow, listing, purchase, fee           │
│   PositionAccount   one isolated account per position        │
└───────────┬──────────────────────────────────────────────────┘
            │ supply / borrow / repay / withdraw / flashLoan
            ▼
┌──────────────────────────────────────────────────────────────┐
│ Aave V3 (the Sepolia market, forked locally)                 │
│   Pool · AaveOracle · aToken · VariableDebtToken · Faucet    │
└──────────────────────────────────────────────────────────────┘
```

## Components

### PositionAccount

A minimal proxy clone. It does one thing, which is to forward calls from the manager:

```solidity
function execute(address target, bytes calldata data) external returns (bytes memory)
```

Only `manager` may call it. To Aave, this address is the position owner, so the collateral flags,
the health factor, and the e-mode setting all belong to it. The account holds no logic, so it
never needs an upgrade.

### PositionManager

It is three things at once: the ownership token (ERC-721), the position factory, and the only
place that talks to Aave.

| Function | Who may call it | While listed |
|---|---|---|
| `createPosition` | anyone | not applicable |
| `supply`, `repay` | the controller | allowed |
| `withdraw`, `borrow`, `setEMode` | the controller | **refused** |
| `migrateIn` | anyone, for their own position | not applicable |
| `migrateOut` | the token owner | **refused** |
| `scan`, `accountData`, `migrationBlocker` | anyone, read only | not applicable |

The **controller** is defined in one line:

```solidity
owner == address(escrow) ? escrow.sellerOf(tokenId) : owner
```

If the token sits in escrow, the controller is the seller who opened the listing. Otherwise it is
the token owner. The moment a position changes hands, management rights move with it. No extra
step is needed.

### Marketplace

It holds the ownership token in escrow. A listing record carries the seller, the payment asset,
the price (fixed or a share of net value), the end time, the seller's health factor threshold, a
price floor, an optional named buyer, and a quick sale marker.

`buy` follows the checks, effects, interactions order:

1. Cheap checks: does the listing exist, has it ended, is this the seller, is the named buyer
   right, has the buyer's own validity window passed.
2. **Delete the listing record.** A second buyer in the same block finds nothing.
3. Read the position's current state from Aave.
4. Check the seller threshold and the buyer guard rails.
5. Compute the price and compare it against `maxPrice`.
6. Move the payment **straight** from the buyer to the seller and the fee address. The
   marketplace never holds a balance.
7. Move the ownership token to the buyer. It uses `transferFrom` rather than `safeTransferFrom`,
   so no receiver callback opens a reentrancy path.

### Server

It reads logs from the deployment block and builds its state in memory. It re-reads the last five
blocks on every pass, so a chain reorganization corrects itself. On a restart the state is rebuilt
from scratch, so there is no such thing as a missed block.

Everything that changes without an event (balances, prices, health factors, dynamic prices) is
read from the chain on every pass in a single `multicall`.

The server holds no rights and is the basis of no security decision. While it is down, nothing on
the chain is affected, and the interface keeps working: it asks `/api/health` once, and when
nothing answers it reads the contracts directly through a public RPC endpoint instead
(`web/src/lib/chainRead.ts`). The activity page is the only thing that needs the indexer, because
reading the whole log history from a browser is not reasonable.

That fallback is what lets the interface be hosted as plain static files, with no server at all.

### Interface

It takes its addresses from the server's `/api/config` response, so it points at whichever chain
the platform was deployed to. If the wallet is on a different chain, it says so and offers to
switch.

There are two ways to connect: a browser extension, and a **built in test wallet**. The second one
uses the local chain's ready made accounts and only appears on the local chain.

## Data flow: one purchase

```
Buyer                Interface           Server           Marketplace        Aave
  │  open listing      │                   │                  │               │
  │───────────────────>│  GET /listings/2  │                  │               │
  │                    │──────────────────>│                  │               │
  │                    │<──────────────────│  (information)   │               │
  │  press Buy         │                   │                  │               │
  │───────────────────>│  currentPrice + accountData, read again from chain   │
  │                    │─────────────────────────────────────>│──────────────>│
  │   preview, guard rails filled from those fresh values     │               │
  │<───────────────────│                   │                  │               │
  │  confirm           │  simulate first, so a revert becomes a sentence      │
  │───────────────────>│─────────────────────────────────────>│               │
  │                    │  buy(tokenId, limits)                │               │
  │                    │─────────────────────────────────────>│  read state   │
  │                    │                                      │──────────────>│
  │                    │                          guard rails are checked     │
  │                    │                          payment: buyer → seller, fee│
  │                    │                          token: escrow → buyer       │
```

Step 5 is the important one. Right before buying, the interface **reads the price and the position
from the chain again** and warns if anything moved (US-21). The guard rails are filled from those
fresh values with one percent of slack, but the contract makes the final check.

## Trust boundaries

| Boundary | What crosses | What does not |
|---|---|---|
| Interface → Server | read requests | any right |
| Server → Contract | reads only | the server cannot sign |
| User → Contract | signed transactions | the contract re-checks every argument |
| Administrator → Contract | fee rate, fee address, emergency stop, payment asset list | user assets and positions, **under no condition** |
| Contract → Aave | actions for the position account | Aave's own rules still apply |

The limit on administrator power is fixed in code. `MAX_FEE_BPS` is a `constant`, and the
marketplace has no function that sends a position to a third address. The emergency stop closes
new listings and purchases only. Cancelling, closing an expired listing, managing a position, and
carrying one back out all stay open.

## Directory layout

```
contracts/     Foundry project: contracts, tests, deployment and seed scripts
server/        Indexer and read API
web/           Interface
e2e/           Playwright browser tests
scripts/       Local environment and deployment commands
shared/        Contract interfaces and the asset list (generated)
deploy/        Deployment addresses per chain (generated)
docs/          These documents
```
