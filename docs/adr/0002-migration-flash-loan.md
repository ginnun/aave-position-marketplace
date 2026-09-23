# ADR-0002: Migration uses a debt mode flash loan

Status: accepted, 2026-09-18

## Context

An existing Aave position, meaning its collateral and its debt together, must move from the
user's own address into an isolated position account in one transaction, with no half finished
state in between. This covers US-03 and US-06.

## Options

1. **Debt mode flash loan**, with `interestRateModes = [2]`. The borrowed amount is not paid back.
   Aave writes it as debt on the target address instead.
2. **Plain flash loan plus repayment by the user.** The user has to bring cash.
3. **Unwind and rebuild step by step.** The position is unbalanced in between.

## Decision

Option 1.

## Reasons

Aave's `FlashLoanLogic` charges no premium when the mode is not zero, and writes the amount as
debt on `onBehalfOf`. This is the path Aave built for migration.

**Carrying a position in, `migrateIn`:**

1. Create the position account. Copy the user's e-mode setting if there is one.
2. The account gives credit delegation to the manager for each debt asset.
3. Take a debt mode flash loan with `onBehalfOf` set to the account.
4. Inside the callback, repay the user's debt in full.
5. Pull the user's aTokens into the account. Balances are read at transfer time, so interest that
   accrued in the meantime moves too.
6. Do not repay the flash loan. Aave writes the debt to the account. The health factor check runs
   against the account, and it passes because the collateral is already there.
7. Reset the delegation to zero.

**Carrying a position out, `migrateOut`,** is the same flow in reverse. This time the target
address gives the delegation.

Because no premium is charged, migration is free. Option 2 asks the user for cash and costs
5 basis points.

## Consequences

- Before carrying a position in, the user must approve their aTokens to the manager. Before
  carrying one out, the target address must give credit delegation. The interface shows both as
  separate steps.
- `Pool.repay` refuses `type(uint256).max` when repaying for another address, with
  `NoExplicitAmountToRepayOnBehalf`. The flow therefore repays exactly the flash loan amount. Both
  numbers are read in the same block, so they are equal.
- `migrateIn` resets the delegation it granted at the end of the transaction, so no leftover
  borrowing right remains on the position account. The delegation a user grants for `migrateOut`
  stays until the user lowers it. See `docs/THREAT_MODEL.md` T-09.

## Sources

- `aave-v3-origin` v3.4.0, `FlashLoanLogic.executeFlashLoan`
- `bgd-labs/V2-V3-migration-helpers`, `aave/aave-debt-swap`
