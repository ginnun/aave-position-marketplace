# ADR-0006: Foundry, a dependency free indexer, and a viem based interface

Status: accepted, 2026-09-18

## Decision

| Layer | Choice | Alternative | Reason |
|---|---|---|---|
| Contracts | Foundry 1.8.3, Solidity 0.8.28 | Hardhat | Fork tests, fuzz tests, and invariant tests are built in, and `anvil` ships with the same toolchain |
| Aave interfaces | `aave-dao/aave-v3-origin` v3.4.0 | hand written interfaces | The official source, with struct layouts and configuration libraries included |
| Addresses | `@aave-dao/aave-address-book` 4.68.1 | copying from documentation | The official registry, versioned. Every address was also checked on the chain |
| Libraries | OpenZeppelin 5.5.0 | solmate | ERC-721, `Ownable2Step`, `Clones`, `SafeERC20`, and `Math.mulDiv` with an explicit rounding mode |
| Server | Node 26, `node:http`, viem | Express, Postgres, The Graph | See below |
| Interface | Vite 8, React 19, viem | wagmi, RainbowKit | See below |
| Browser tests | Playwright | Cypress with Synpress | The built in test wallet removes the need for a browser extension |

## Why the server has no database

The indexer reads logs from the deployment block and builds its state in memory. On every pass it
re-reads the last few blocks.

- It survives a restart, because the state is rebuilt from the chain every time. There is no such
  thing as a missed block.
- It survives a chain reorganization, because only recent blocks can change, and those are
  re-read on every pass.
- Setup cost is zero: no migrations, no database, and one dependency.

The price is a slower start on a long chain history. That is fine at testnet size. Production
scale needs a durable index. See `docs/SUGGESTIONS.md`.

## Why the interface has no wagmi

The indexer already does the reading. What the interface needs from a wallet is narrow: connect,
know the chain id, read a few live values, and send transactions. viem gives all of that
directly. Adding wagmi would bring more API surface and version coupling than it saves.

One side benefit follows. A **built in test wallet** that uses the local chain's ready made
accounts takes about 40 lines. A new developer can try every flow without installing a browser
extension, and the browser tests run fully headless.
