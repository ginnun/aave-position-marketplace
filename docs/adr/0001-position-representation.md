# ADR-0001: A position lives in its own account and is owned by an ERC-721 token

Status: accepted, 2026-09-18

## Context

Aave variable debt tokens cannot be transferred. A transfer reverts with
`OperationNotSupported`. A debt position therefore cannot change hands by sending a token.
Collateral tokens, called aTokens, can be transferred, but Aave rejects any transfer that would
break the sender's health factor.

## Options

1. **One isolated account per position, plus an ownership token.** Each position lives in its own
   contract account. Aave sees that account as the position owner. A transferable ERC-721 token
   represents who owns the account.
2. **One shared pool contract with internal bookkeeping.** All positions sit in one contract, and
   ownership is tracked in that contract's own ledger.
3. **An atomic close and reopen swap between seller and buyer.**

## Decision

Option 1.

## Reasons

- Aave tracks risk per address. An isolated account keeps each position's health factor, e-mode
  setting, and collateral flags separate. In option 2 the risk of every user lands on one address,
  so one liquidation eats another user's collateral.
- With an ERC-721 token, ownership and escrow reduce to one fact: `ownerOf(tokenId)`. Management
  rights follow from the same fact: the owner manages, or the seller while the token is in escrow.
  No separate lock state is needed. See ADR-0003.
- Option 3 closes and reopens the position. That brings back the slippage, the lost interest, and
  the supply cap risk that the product exists to avoid.

## Consequences

- Each position is a minimal proxy clone named `PositionAccount`, so creating one is cheap.
- `PositionAccount` holds two functions, `initialize` and `execute`, and only `PositionManager`
  can call `execute`. All logic lives in the manager. The account is deliberately dumb, so it
  never needs an upgrade.
- The position can also be sold on any other ERC-721 marketplace. That is a risk. See
  `docs/THREAT_MODEL.md`.

## A note on Aave V4

Aave V4 is live on mainnet, and its source tree carries position managers and gateway contracts
that address the same problem. It has no testnet deployment, so it was never an option here:
mainnet is out of scope by the product brief. If this work ever moves to mainnet, read what V4
provides before porting these contracts unchanged.

## Sources

- Aave V3 `VariableDebtToken.transfer` reverts with `OperationNotSupported`.
- `contango-xyz/core-v2` represents positions as tokens.
- `aave/aave-v4`, for the direction the protocol took.
