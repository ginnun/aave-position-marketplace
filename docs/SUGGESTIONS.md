# Suggestions

These fall outside the agreed scope but deserve attention before a real deployment.
None of them was built.

## Security

1. **A pull payment model.** Today the payment is pushed straight from the buyer to the seller. If
   the payment asset keeps an address blocklist, which real USDC and USDT both do, and the seller
   is on it, the sale reverts and the position cannot be sold. Holding the payment in the contract
   for the seller to withdraw removes that risk. The cost is that the rule "no ownerless balance
   builds up on the platform" gets weaker.

2. **The ownership token sold outside the platform.** Because it is an ERC-721, the position can be
   sold on any other marketplace. There the buyer guard rails do not apply, and the token metadata
   shows no live risk data. Two ways out: serve a live health factor and net value from `tokenURI`,
   or restrict transfers to this marketplace. The second one limits US-07, the free transfer.

3. **Stale oracle prices.** The Aave oracle does not check for staleness. The buyer's `maxPrice`
   and the seller's `minPrice` cover the payment asset from both sides, but a frozen price source
   also makes the net value wrong. A freshness window on the feed's `latestTimestamp` would help.

4. **Front running.** `maxPrice` protects the buyer from price manipulation, but a purchase of a
   position close to liquidation can be front run by a liquidation. The buyer's loss is capped by
   `minNetValueBase`. Using a private transaction pool could be documented for users.

5. **A token sent to the marketplace by mistake.** If an ownership token is sent straight to the
   marketplace with `transferFrom`, without calling `list`, it stays there. Adding a rescue
   function would give the administrator the power to move a token, which contradicts US-17.
   Refusing `onERC721Received` only stops `safeTransferFrom` calls.

## Product

6. **Partial sales.** The whole position is sold. Splitting part of the collateral into a separate
   position would help sellers who are close to liquidation.

7. **Bids.** Marked out of scope, but on positions close to liquidation, letting the buyer name a
   price is the natural flow.

8. **Accrued rewards.** Incentives that built up inside a position go to the new owner, because the
   account itself changes hands. This should be documented, or the seller should be offered a way
   to claim rewards before the sale.

## Infrastructure

9. **A durable index.** The in memory index slows the start on a long chain history. Production
   scale needs a database and a block cursor.

10. **An archive RPC.** Pinning the fork block forever needs archive access. As an alternative,
    `anvil --dump-state` can write the chain state to a file that travels with the repository.

11. **Handing over administration.** The `Marketplace` administrator is a single address behind
    `Ownable2Step`. A real deployment should use a multisig wallet or a timelock.
