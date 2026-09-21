# API

A read only interface over the indexed chain state. It exists so a program can watch listings and
decide when to buy, which is US-29.

The API makes no security decision. A purchase is validated by the marketplace contract at
transaction time. Anything served here is information.

Base address on the local chain: `http://127.0.0.1:8787`. The machine readable description is at
`/api/openapi.json`.

## How numbers are written

| Kind | Format | Example |
|---|---|---|
| Token amounts | A string holding an integer in the smallest unit of that asset | `"5500000000"` is 5,500 USDC, which has 6 decimals |
| Base currency amounts | US dollars with 8 decimals, the Aave oracle base | `"597532839000"` is 5,975.33 USD |
| Health factor | 18 decimals, so `1e18` is exactly 1.0 | `"3259787892220210467"` is 3.26 |
| Basis points | An integer, where 10000 is 100% | `8000` is 80% |
| Times | Unix seconds | `1790941542` |

A health factor of `115792089237316195423570985008687907853269984665640564039457584007913129639935`
means the position has no debt. Aave returns the maximum value in that case.

## Routes

### `GET /api/config`

Chain id, contract addresses, the current fee, whether the platform is stopped, the asset list,
and the latest oracle prices. Start here: a client needs these addresses to build a transaction.

### `GET /api/listings`

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `status` | `active`, `invalid`, `expired`, `all` | `active` | `invalid` means the health factor is under the seller's threshold |
| `asset` | symbol | none | The symbol must appear in the collateral or the debt |
| `paymentAsset` | address | none | |
| `minHealthFactor` | 18 decimals | none | |
| `maxHealthFactor` | 18 decimals | none | |
| `maxPremiumBps` | integer | none | Negative values are discounts to net value |
| `minNetValueBase` | 8 decimals | none | |
| `quickSale` | boolean | none | |
| `includePrivate` | boolean | `false` | Private listings are hidden by default |
| `sort` | `expiry`, `premium`, `netValue`, `healthFactor`, `tokenId` | `expiry` | |
| `order` | `asc`, `desc` | `asc` | |
| `limit` | integer, at most 200 | 50 | |
| `offset` | integer | 0 | |

The response carries `total`, `blockNumber`, `indexedAt`, and `items`. Every item holds the
listing, the live `position`, the `currentPrice` the contract would charge right now, and
`premiumBps`, which is negative for a discount.

### `GET /api/listings/{tokenId}`

One listing. Returns 404 when the position is not listed.

### `GET /api/positions` and `GET /api/positions/{tokenId}`

Tradable positions with their collateral and debt broken down per asset. Pass `owner` to filter.

### `GET /api/history`

Every platform event, newest first. Filter with `address` or `tokenId`. Each row carries a
`txHash` you can look up in an explorer.

### `GET /api/stats`

Counts, volume per payment asset, and fees collected.

### `GET /api/stream`

Server sent events. One message per indexer pass, carrying the block number and the listing count.
Use it to learn when to read the listing routes again, instead of polling on a timer.

The server holds at most 200 streams at once, and answers 429 beyond that. `MAX_STREAMS` changes
the limit. A query parameter that is not a whole number, or a `sort` key that does not exist, is
answered with 400 and a message that names the parameter.

### `GET /api/health`

Returns 200 when the indexer has caught up, and 503 while it is still reading.

## Example: watch for a discount and buy

This program watches the stream, picks the first listing at a discount of 15% or more, and buys it
with guard rails. It uses viem, which the project already depends on.

```js
import { createPublicClient, createWalletClient, http, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const API = 'http://127.0.0.1:8787';
const config = await fetch(`${API}/api/config`).then((r) => r.json());
const abi = await fetch('http://127.0.0.1:5173/abi.json').then((r) => r.json());

const chain = {
  id: config.chainId,
  name: 'local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
};
const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(config.rpcUrl) });

async function tryBuy() {
  const { items } = await fetch(
    `${API}/api/listings?status=active&maxPremiumBps=-1500&sort=premium`,
  ).then((r) => r.json());
  if (items.length === 0) return;

  const listing = items[0];
  const tokenId = BigInt(listing.tokenId);

  // Read the price from the contract, not from the index, then leave one percent of slack.
  const price = await publicClient.readContract({
    address: config.contracts.marketplace,
    abi: abi.Marketplace,
    functionName: 'currentPrice',
    args: [tokenId],
  });

  await wallet.writeContract({
    address: listing.paymentAsset,
    abi: erc20Abi,
    functionName: 'approve',
    args: [config.contracts.marketplace, price],
  });

  const position = listing.position;
  await wallet.writeContract({
    address: config.contracts.marketplace,
    abi: abi.Marketplace,
    functionName: 'buy',
    args: [tokenId, {
      maxPrice: (price * 101n) / 100n,
      minNetValueBase: (BigInt(position.netValueBase) * 99n) / 100n,
      maxDebtBase: (BigInt(position.totalDebtBase) * 101n) / 100n,
      minHealthFactor: (BigInt(position.healthFactor) * 99n) / 100n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    }],
  });
  console.log('bought position', listing.tokenId);
}

const stream = new EventSource(`${API}/api/stream`);
stream.onmessage = () => tryBuy().catch((err) => console.error(err.shortMessage ?? err.message));
```

The guard rails are what make this safe to run unattended. If the position gets worse between the
read and the transaction, the contract refuses and nothing moves.

## Errors

Errors come back as `{"error": "..."}` with the matching HTTP status. 404 means the listing or the
position is unknown. 503 means the indexer is still catching up.
