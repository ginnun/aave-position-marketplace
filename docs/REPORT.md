# Final report

## What was built

A marketplace where an Aave borrowing position, collateral and debt together, changes hands
without being closed. It runs against the **live Aave V3 market on Sepolia**: locally through a
fork pinned to one block, and on the public testnet through the same contracts.

Three contracts, one indexer, one interface, and two test suites.

| Piece | Lines | What it does |
|---|---|---|
| `PositionAccount` | 29 | One isolated Aave account per position |
| `PositionManager` | 675 | Ownership token, position management, migration in and out |
| `Marketplace` | 311 | Escrow, listing, pricing, purchase, fee, emergency stop |
| `contracts/test/` | 1,527 | Fork tests, fuzz tests and invariants |
| `server/` | 998 | Indexes chain logs into memory, serves reads and a change stream |
| `web/` | 4,192 | Interface, in Turkish and English, for a phone or a desktop |
| `e2e/` | 797 | Browser tests, headless, with wallet interaction |

## Test results

Run them with `npm run test`.

**Contracts: 64 passed, 0 failed.** They run against a pinned fork of the live Aave Sepolia
market, so every result is what the real protocol does. Eight of them are invariants driven by a
handler that lists, cancels, buys, strengthens, weakens, and moves prices at random, over 2,048
calls per run:

- A listed position can only leave escrow to its seller or to a paying buyer.
- The seller's share plus the fee equals what the buyer paid, exactly.
- The platform holds no user balance between transactions.
- A listed position's collateral cannot fall and its debt cannot rise.
- Escrow and the listing record always agree.
- The fee never passes its cap.
- Every attempt to weaken a listed position was refused by the escrow guard.
- A purchase only ever failed for a reason a randomly built purchase can legitimately hit.

**Browser: 25 passed, 0 failed, in 2.2 minutes.** They drive the real interface, with a wallet,
against a chain rebuilt from scratch for each run. No browser extension is involved: the interface
carries a test wallet that uses the local chain's ready made accounts.

## What the tests found

Writing the browser tests was worth it. Six real defects came out of it, none of which the
contract tests could see:

1. **An action offered before the state behind it was known.** The purchase dialog showed
   "Confirm purchase" before the token allowance had been read. A user who clicked fast sent a
   transaction that was certain to revert. The same race existed in three other forms. Every form
   now waits until it knows which action it needs.

2. **A success message that vanished with its own subject.** After a purchase, the listing stops
   existing, so the page that was showing it dropped straight to "not listed" and the confirmation
   never appeared. The same happened after a migration and after a listing. A result now outlives
   the record it came from.

3. **A guard rail that refused its own purchase.** The buyer's lowest health factor was pre-filled
   with the current value rounded to two decimals. Rounding up put the floor above the real value,
   and the contract refused. It now sets a floor one percent below, rounded down.

4. **Effects that never settled.** The interface context was rebuilt on every indexed block, so
   every effect depending on it restarted a few times a minute, and a read could be left hanging
   forever. The context is now stable and every read falls back safely when it fails.

5. **Expiry judged by the wrong clock.** The indexer decided whether a listing had ended by its own
   wall clock, while the contract uses the block timestamp. On a chain whose clock has been moved
   forward, the two disagreed. The indexer now reads the block timestamp. The interface had the
   mirror of the same fault: it built the listing end time and the buyer deadline from the browser
   clock, so on a moved chain a listing was refused outright. Both now read the chain.

6. **A block announced before its data.** The indexer published the new head at the start of a
   pass, so a reader was told a block was indexed while the listings still described the block
   before it. The head is now published with the data it describes.

The invariant runner found one more, in the test rather than in the contract. The sale counter was
keyed by listing round alone, so two different positions listed in the same round shared a bucket
and looked like one listing sold twice. It is keyed by position and round now. Worth recording:
a property test that reports a false failure is as much a defect as one that misses a real one.

Another came out of running the suite twice: an indexer left over from a previous chain kept
serving state that no longer existed. The indexer now notices that the chain got shorter than what
it has read, and rebuilds. That is the same code path a deep chain reorganization takes.

## Decisions

| Decision | Why | Record |
|---|---|---|
| One isolated account per position, owned by an ERC-721 | Aave tracks risk per address, so positions must not share one | [ADR-0001](adr/0001-position-representation.md) |
| Debt mode flash loan for migration | Aave charges no premium and writes the debt to the target, which is exactly what migration needs | [ADR-0002](adr/0002-migration-flash-loan.md) |
| Escrow is the lock | One source of truth cannot drift from itself | [ADR-0003](adr/0003-escrow-is-the-lock.md) |
| Aave oracle for pricing, guard rails in the transaction | Keeps valuation aligned with the protocol's own risk numbers | [ADR-0004](adr/0004-pricing-and-guard-rails.md) |
| Local chain is a pinned Sepolia fork | Free, reproducible, and it brings the real market configuration | [ADR-0005](adr/0005-local-environment.md) |
| No database, no wagmi | Both cost more than they save at this size | [ADR-0006](adr/0006-technology-choices.md) |

## Assumptions

Eighteen judgment calls are recorded in [ASSUMPTIONS.md](ASSUMPTIONS.md) with their basis. The
ones that shaped the product most:

- The platform fee is 0.5%, with a cap of 2% that no administrator can raise.
- Buyer guard rails are filled with one percent of slack, which is the measurable reading of "a
  reasonable tolerance" in US-23.
- Example positions borrow USDT, because USDC flash loan liquidity on Sepolia is only 3,602 units.
- Positions in isolation mode or with siloed borrowing are refused before the transaction, rather
  than failing inside it.

## Open risks

| Risk | State |
|---|---|
| A payment asset that blocklists the seller would make a sale revert | Not handled. A pull payment model is the fix. [SUGGESTIONS.md](SUGGESTIONS.md) item 1 |
| The ownership token can be sold on another marketplace, where no guard rail applies | A deliberate consequence of ADR-0001. Item 2 |
| The Aave oracle does not check for stale prices | Both sides are covered against a wrong payment asset price, but a frozen feed still makes net value wrong. Item 3 |
| A foreign token sent to the marketplace by mistake stays there | The ownership token itself is refused outside `list`. A scoped rescue function is item 5 |
| The pinned fork block ages out of public endpoints | `scripts/pin.sh` re-pins. An archive endpoint removes the problem |

## Verified from a clean checkout

The whole thing was cloned into an empty directory and run from the documentation alone:

```
git clone <repo> && cd aave-position-marketplace
cp .env.example .env
npm run setup            # exit 0
npm run test:contracts    # 35 passed, 0 failed
npm run test:e2e          # 23 passed, 0 failed, 2.2 minutes
```

That is US-40, checked rather than asserted.

## Hosting, at no cost

The interface asks `/api/health` once. When nothing answers, it reads the contracts directly
through a public RPC endpoint instead of through the indexer. A deployment is then a folder of
static files, which Cloudflare Pages, GitHub Pages and Netlify all host for free, with no process
running anywhere.

```bash
VITE_CHAIN_ID=11155111 npm run build   # writes web/dist
```

This was checked against the live Sepolia deployment: the built site was served by a plain file
server with no API behind it, and a headless browser read the real listing, its price of 10.80
USDC and its health factor of 3.30 straight from the chain.

The activity page is the one thing that needs the indexer, because reading the whole log history
from a browser is not reasonable. For that, `docker compose up --build` runs the interface and the
indexer together on one port.

## Commands

```bash
npm run setup      # install, pin a fork block, generate the contract interfaces
npm run dev        # local chain, indexer, interface
npm run reset      # throw the chain away and build it again
npm run stop       # stop everything

npm run price WETH 2500   # move a price on the local chain
npm run warp 7d           # move the local clock forward

npm run test              # both suites
npm run test:contracts    # contracts only, against the pinned fork
npm run test:e2e          # browser only, headless, on a fresh chain

npm run deploy:testnet    # public Sepolia. Needs a funded key
npm run build:static      # static site that reads the chain by itself, no server
docker compose up --build # interface and API in one container
```

## Live on the public testnet

US-38 is done. The platform is deployed on Ethereum Sepolia, block 11763998, and it holds a real
listed position.

| What | Address |
|---|---|
| PositionManager | `0xa1cDe4d2D2615C82d57e585Ca72c7680184528D3` |
| Marketplace | `0x2b8c3987bCd425cEF9245580c7eBFb2797256426` |
| Administrator and fee recipient | `0x60a9055D2A06736749f7165576eD8464B7B76630` |
| Position 1 account | `0xf6F75C8B164Fe8726B396f69353af9Edad39bfFC` |

Transaction proofs, all on `sepolia.etherscan.io`:

| Step | Hash |
|---|---|
| Deploy PositionManager | `0x36a583afbb31c10efb5722998852976a90b33b59b0e319ded19c203d374ae7d4` |
| Deploy Marketplace | `0x10c17fa6c0bdfd20f0776a16b06f24eafe0c71b2f8e8ce72c477fab7504b11d6` |
| Wire the escrow | `0x56ff490ddc58ab51ac5dd267c595762db472df27807c21b553e88dc0d2e046e8` |
| Allow USDC, DAI, USDT as payment | `0xddf61223…`, `0x57501908…`, `0xdd114a1a…` |
| Create and supply position 1 | `0x6b4a6522…`, `0x37b517d3…` |
| Borrow against it | `0xd13d078a0cdcc59c78ce2bdf46f3f4f38cf0ec4a878fe37eb4df50651ddc08e5` |
| List it | `0xd23bd944fa1295fcff8f7dd7f54e6cd756232b65c2b860ad321beaa40074b0e6` |

Deployment cost 7,418,421 gas. Seeding the example position cost 1,058,072 more.

The seeded position is real: 0.004 WETH of collateral against 4 USDT of debt, read back from the
Aave pool as 16.00 USD against 4.00 USD, health factor 3.30. It is listed at 90% of net value,
which prices at 10.80 USDC. Both the indexer and the static build read it back correctly.

The position is small on purpose. Sepolia ether comes from faucets that hand out a little at a
time, and the point is a working example rather than a large one. `SEED_COLLATERAL_WEI` sets the
size, and the seed script now refuses to start when the account cannot cover it, instead of
failing inside the wrapped ether contract with no readable reason.

`PositionManager`, `Marketplace` and the `PositionAccount` clone template are verified on the
explorer. A deployment of your own verifies them too when `ETHERSCAN_API_KEY` is set in `.env`.

## Not done

**US-07, transfer to another address.** Priority "could have". The standard ERC-721 `transferFrom`
already covers it, and a listed position sits in escrow so it cannot be transferred.

**Slither.** Not available in this environment. `forge lint` runs with no errors, and every warning
is reviewed in [STATIC_ANALYSIS.md](STATIC_ANALYSIS.md).

**The container image build.** `Dockerfile` and `docker-compose.yml` are written, and the serving
code they run was tested directly: the interface was built and `node deploy-stack/serve.js` served
both the static site and the API on one port, against the local chain, with the pages checked in a
headless browser. The image build itself was not run, because no Docker daemon was running on this
machine.
