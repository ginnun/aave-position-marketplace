# Architecture decisions

One file per decision. Each records the context, the options weighed, the choice, the reasons, and
what follows from it.

| # | Decision |
|---|---|
| [0001](0001-position-representation.md) | A position lives in its own account and is owned by an ERC-721 token |
| [0002](0002-migration-flash-loan.md) | Migration uses a debt mode flash loan |
| [0003](0003-escrow-is-the-lock.md) | Escrow is the lock, and there is no separate lock state |
| [0004](0004-pricing-and-guard-rails.md) | Dynamic price from the Aave oracle, guard rails at transaction time |
| [0005](0005-local-environment.md) | The local chain is a Sepolia fork pinned to one block |
| [0006](0006-technology-choices.md) | Foundry, a dependency free indexer, and a viem based interface |
