# ADR-0004: Dynamic price from the Aave oracle, guard rails at transaction time

Status: accepted, 2026-09-18

## Context

A seller may set a fixed price or a share of net value, per US-08 and US-09. A buyer must not lose
out if the position changes between the listing and the transaction, per US-23. Anything the
interface displays is information only. The decision belongs on the chain.

Net value means total collateral value minus total debt value.

## Decision

- Dynamic price is `net value * rate / payment asset price`. Both the net value and the payment
  asset price come from the Aave oracle. Rounding goes **up**, which favors the seller.
- Seller guard rails are `minHealthFactor`, below which the listing is invalid and cannot be
  bought, and `minPrice`, an absolute floor for dynamic listings.
- Buyer guard rails are arguments to `buy`: `maxPrice`, `minNetValueBase`, `maxDebtBase`,
  `minHealthFactor`, and `deadline`. Each one is checked against chain state inside the
  transaction. A crossed limit reverts with `LimitExceeded(Limit)`, which names the limit.
- Payment assets are allowlisted by the administrator.

## Reasons

- Using the Aave oracle keeps the valuation consistent with the protocol's own risk accounting. A
  different price source would let the price and the health factor drift apart.
- The Aave oracle does not check for stale prices. That cuts both ways. If the payment asset looks
  cheap, the price inflates, and the buyer's `maxPrice` stops it. If it looks expensive, the price
  collapses, and the seller's `minPrice` stops it. Both sides are covered without an extra
  administrator setting.
- The payment asset allowlist keeps out tokens that take a fee on transfer. Such a token would
  break the rule that the seller's share plus the fee equals what the buyer paid.

## Consequences

- `MAX_RATE_BPS` is 15000, which is 150%. It allows a premium sale and blocks absurd values.
- `MAX_FEE_BPS` is 200, which is 2%. It is a `constant`, so no administrator can ever raise it.
- Payment is pushed: straight from the buyer to the seller and to the fee address. If a payment
  asset can blocklist addresses, a sale to a blocked seller reverts. The test assets have no such
  feature. A production deployment should consider a pull model. See `docs/SUGGESTIONS.md`.
