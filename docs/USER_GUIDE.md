# User guide

This guide walks through the flows in the order a new user meets them. It assumes the local
environment is running. See `README.md` to start it.

## Words used here

- **Position.** Collateral you supplied to Aave plus debt you borrowed against it.
- **Tradable position.** A position that lives in its own account on this platform, so it can
  change hands. Ownership is an ERC-721 token.
- **Net value.** Total collateral value minus total debt value.
- **Health factor.** Aave's safety number. Below 1.0 a position can be liquidated.
- **Listing.** An offer to sell a tradable position, at a fixed price or at a share of net value.
- **Invalid listing.** A listing whose health factor has fallen under the threshold the seller
  set. It stays visible but cannot be bought until the position recovers.

## Connect

Every screen shows the connected address and the network. Two ways to connect:

- **Browser wallet.** Any extension that injects `window.ethereum`.
- **Test wallet.** Only offered on the local chain. It uses the chain's ready made accounts, named
  Deployer, Alice, Bob and Carol. No extension is needed, and there is no real money.

If your wallet is on the wrong network, the interface says so and offers to switch.

## Get test money

On the local chain, open **Carry a position in**. The bottom card gives out test tokens.

- WETH comes from wrapping ether, because the Aave testnet faucet does not mint it.
- Every other asset comes from the Aave faucet, which gives at most 10,000 units per call.

## Carry an existing Aave position in

Open **Carry a position in**. The page reads your Aave position and shows the collateral, the
debt, and the health factor before anything is signed.

1. Approve each collateral token. The button names the asset.
2. Press **Carry the position in**.

The migration is one transaction. A flash loan repays your debt, your collateral moves to the new
account, and the debt is reopened there. Nothing is closed and reopened, so you keep your entry
price.

If the position cannot be carried, the page says why before you sign. Isolation mode, siloed
borrowing, and a paused reserve are all refused up front.

## Manage a tradable position

Open **My positions** and pick one. Four actions are available: add collateral, repay, withdraw
collateral, and borrow. Each one previews the health factor you would end up with.

Set a **health factor alert threshold** at the top of the page. Any position under it is flagged.

## List a position for sale

On the position page, choose a price type.

- **Fixed price.** One number in the payment asset.
- **Share of net value.** The price follows the market. If the position gains value, so does the
  asking price. Set a floor so a falling market cannot sell it for nothing.

Then set the duration, and the **lowest health factor**. Under that number your listing stops
being buyable, which protects you from selling a position at the wrong price while it is in
trouble.

Optional: name a single buyer to make the listing private, or mark it as a quick sale so buyers
looking for a discount find it.

The discount or premium against net value is shown before you sign.

### While listed

- You can add collateral and repay debt. These help the buyer, so they stay open.
- You cannot withdraw collateral, borrow more, or change the e-mode setting. The interface
  explains this rather than failing later.
- You can cancel at any time and get the position back with full control.

## Buy a position

Open **Market**. Each card shows the price, the discount, the health factor, and a bar: the full
width is the collateral, the filled part is the debt, and the notch is where liquidation starts.

Open a listing to see the per asset breakdown, the estimated liquidation price, and the seller's
threshold.

Press **Buy**. Before the dialog appears, the interface reads the price and the position from the
chain again and warns you if anything moved.

The dialog shows:

- The price, the platform fee, and the total.
- The collateral, the debt, and the health factor you would take on.
- **Your guard rails**, filled from those fresh values with one percent of slack.

The guard rails are the important part. They are checked by the contract inside the transaction:

| Guard rail | Stops |
|---|---|
| Highest price | A price that climbed after you decided |
| Lowest net value | A position that lost value, for example through a liquidation |
| Highest debt | Debt that grew |
| Lowest health factor | A position that got riskier |
| Valid for | A transaction that sat in the queue too long |

If one is crossed, the purchase is refused, the interface names the guard rail, and nothing moves.

Approve the payment asset once, then confirm. Payment and ownership move in the same transaction,
or neither does.

## Carry a position back out

On a position you own and have not listed, open **Carry back to my account**.

1. Delegate credit for each debt asset. This lets the flash loan debt land on your account.
2. Press **Carry back to my account**.

Your Aave account receives the collateral and the debt. The tradable position is burned.

## Simulate the market on the local chain

Prices on the public testnet never move. On the local chain you can move them:

```bash
npm run price WETH 2500   # a fall, which lowers health factors
npm run price WETH 4000   # back again
npm run warp 7d           # move the clock forward, past a listing's end time
```

Use these to see a listing go invalid, watch a seller rescue it with more collateral, or let a
listing expire.

## When something fails

Every refusal comes back as a sentence, not a hex string. The transaction is simulated before you
are asked to sign, so most problems are caught before you pay any gas.

Common ones:

| Message | What to do |
|---|---|
| The position is listed | Cancel the listing first |
| The health factor is under the seller threshold | Wait for recovery, or ask the seller to add collateral |
| The price is above your highest price | Raise your ceiling, or wait |
| The platform is stopped | Cancelling and carrying out still work |
| This position cannot be carried | The reason is named. Isolation mode and siloed borrowing are not supported |
