import { createPublicClient, http, type Abi, type Address, type PublicClient } from 'viem';
import { loadAbis, type Abis } from './contracts';
import type { Config, HistoryEntry, Listing, Position, ServerAsset } from './api';

/**
 * Reads everything the indexer would serve, straight from the chain.
 *
 * This is what lets the interface run as a plain static site, with no server of its
 * own. It is slower than the indexer and it cannot page through long history, so the
 * indexer stays the first choice when one is reachable.
 */

const DEFAULT_RPC: Record<number, string> = {
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
};

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;

const POOL_ABI = [
  {
    type: 'function', name: 'getUserAccountData', stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ],
  },
  {
    type: 'function', name: 'getUserEMode', stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }], outputs: [{ type: 'uint256' }],
  },
] as const satisfies Abi;

const ORACLE_ABI = [
  {
    type: 'function', name: 'getAssetPrice', stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }], outputs: [{ type: 'uint256' }],
  },
] as const satisfies Abi;

type Deployment = {
  chainId: number;
  deployBlock: number;
  feeBps: number;
  feeRecipient: string;
  positionManager: string;
  marketplace: string;
  pool: string;
  poolAddressesProvider: string;
  oracle: string;
  faucet: string;
};

const ZERO = '0x0000000000000000000000000000000000000000';

let cache: {
  deployment: Deployment;
  assets: ServerAsset[];
  abis: Abis;
  client: PublicClient;
} | null = null;

async function load() {
  if (cache) return cache;

  // A built site targets the public testnet. The development server is the local chain, and
  // silently reading a different chain there would be worse than failing.
  const chainId = Number(
    import.meta.env.VITE_CHAIN_ID ?? (import.meta.env.DEV ? 31337 : 11155111),
  );
  const [deployment, assetsFile, abis] = await Promise.all([
    fetch(`/deploy/${chainId}.json`).then((r) => r.json() as Promise<Deployment>),
    fetch('/assets.json').then((r) => r.json() as Promise<{ assets: ServerAsset[] }>),
    loadAbis(),
  ]);

  const rpcUrl = import.meta.env.VITE_RPC_URL
    ?? DEFAULT_RPC[deployment.chainId]
    ?? 'http://127.0.0.1:8545';

  const client = createPublicClient({
    chain: {
      id: deployment.chainId,
      name: 'chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
      contracts: { multicall3: { address: MULTICALL3 } },
    },
    transport: http(rpcUrl),
  }) as PublicClient;

  cache = { deployment, assets: assetsFile.assets, abis, client };
  return cache;
}

function assetByAddress(assets: ServerAsset[], address: string) {
  return assets.find((a) => a.address.toLowerCase() === address.toLowerCase());
}

function assetByAToken(assets: ServerAsset[], aToken: string) {
  return assets.find((a) => a.aToken.toLowerCase() === aToken.toLowerCase());
}

async function readEverything() {
  const { deployment, assets, abis, client } = await load();
  const manager = deployment.positionManager as Address;
  const market = deployment.marketplace as Address;

  const [nextId, paused, feeBps, feeRecipient, block] = await Promise.all([
    client.readContract({ address: manager, abi: abis.PositionManager, functionName: 'nextTokenId' }) as Promise<bigint>,
    client.readContract({ address: market, abi: abis.Marketplace, functionName: 'paused' }) as Promise<boolean>,
    client.readContract({ address: market, abi: abis.Marketplace, functionName: 'feeBps' }) as Promise<bigint>,
    client.readContract({ address: market, abi: abis.Marketplace, functionName: 'feeRecipient' }) as Promise<string>,
    client.getBlock(),
  ]);
  // Two different numbers with two different jobs. The timestamp is the clock the contract
  // reads, so expiry is judged by it; the block number is what a reader compares against the
  // indexer's head. Reporting the timestamp as the head made "Block" read as 1.7e9.
  const chainTimestamp = Number(block.timestamp);
  const blockNumber = String(block.number);

  const ids = Array.from({ length: Number(nextId) - 1 }, (_, i) => BigInt(i + 1));

  const prices: Record<string, string | null> = {};
  const priceResults = await client.multicall({
    contracts: assets.map((a) => ({
      address: deployment.oracle as Address, abi: ORACLE_ABI,
      functionName: 'getAssetPrice', args: [a.address as Address],
    })),
    allowFailure: true,
  });
  assets.forEach((a, i) => {
    prices[a.symbol] = priceResults[i].status === 'success' ? String(priceResults[i].result) : null;
  });

  if (ids.length === 0) {
    return { deployment, assets, prices, paused, feeBps: Number(feeBps), feeRecipient, positions: [] as Position[], listings: [] as Listing[], chainTimestamp, blockNumber };
  }

  // One round trip for the ownership and account of every position.
  const base = await client.multicall({
    contracts: ids.flatMap((id) => [
      { address: manager, abi: abis.PositionManager, functionName: 'ownerOf', args: [id] },
      { address: manager, abi: abis.PositionManager, functionName: 'accountOf', args: [id] },
      { address: market, abi: abis.Marketplace, functionName: 'getListing', args: [id] },
    ]),
    allowFailure: true,
  });

  const live = ids
    .map((id, i) => ({
      tokenId: id.toString(),
      owner: base[i * 3].status === 'success' ? String(base[i * 3].result) : null,
      account: base[i * 3 + 1].status === 'success' ? String(base[i * 3 + 1].result) : null,
      rawListing: base[i * 3 + 2].status === 'success' ? (base[i * 3 + 2].result as Record<string, unknown>) : null,
    }))
    // ownerOf reverts once a position has been carried back out and burned.
    .filter((p) => p.owner !== null && p.account !== null);

  const detail = await client.multicall({
    contracts: live.flatMap((p) => [
      { address: deployment.pool as Address, abi: POOL_ABI, functionName: 'getUserAccountData', args: [p.account as Address] },
      { address: manager, abi: abis.PositionManager, functionName: 'scan', args: [p.account as Address] },
      { address: deployment.pool as Address, abi: POOL_ABI, functionName: 'getUserEMode', args: [p.account as Address] },
      { address: market, abi: abis.Marketplace, functionName: 'currentPrice', args: [BigInt(p.tokenId)] },
    ]),
    allowFailure: true,
  });

  const positions: Position[] = [];
  const listings: Listing[] = [];

  live.forEach((p, i) => {
    const account = detail[i * 4];
    const scan = detail[i * 4 + 1];
    const eMode = detail[i * 4 + 2];
    const price = detail[i * 4 + 3];
    if (account.status !== 'success') return;

    const [collateralBase, debtBase, availableBase, liqThreshold, ltv, hf] =
      account.result as readonly bigint[];

    let collateral: Position['collateral'] = [];
    let debt: Position['debt'] = [];
    if (scan.status === 'success') {
      const [aTokens, aBalances, debtAssets, debtAmounts] =
        scan.result as readonly [readonly string[], readonly bigint[], readonly string[], readonly bigint[]];
      collateral = aTokens.map((aToken, k) => {
        const asset = assetByAToken(assets, aToken);
        return {
          symbol: asset?.symbol ?? aToken, address: asset?.address ?? null, aToken,
          decimals: asset?.decimals ?? 18, amount: aBalances[k].toString(),
        };
      });
      debt = debtAssets.map((address, k) => {
        const asset = assetByAddress(assets, address);
        return {
          symbol: asset?.symbol ?? address, address,
          decimals: asset?.decimals ?? 18, amount: debtAmounts[k].toString(),
        };
      });
    }

    const position: Position = {
      tokenId: p.tokenId,
      account: p.account as string,
      owner: p.owner as string,
      burned: false,
      createdBlock: deployment.deployBlock,
      totalCollateralBase: collateralBase.toString(),
      totalDebtBase: debtBase.toString(),
      netValueBase: (collateralBase > debtBase ? collateralBase - debtBase : 0n).toString(),
      availableBorrowsBase: availableBase.toString(),
      liquidationThreshold: Number(liqThreshold),
      ltv: Number(ltv),
      healthFactor: hf.toString(),
      eModeCategory: eMode.status === 'success' ? Number(eMode.result) : 0,
      collateral,
      debt,
    };
    positions.push(position);

    const raw = p.rawListing;
    if (!raw || String(raw.seller) === ZERO) return;

    const paymentAsset = String(raw.paymentAsset);
    const currentPrice = price.status === 'success' ? String(price.result) : null;
    const expiry = Number(raw.expiry);
    const minHealthFactor = String(raw.minHealthFactor);

    listings.push({
      tokenId: p.tokenId,
      seller: String(raw.seller),
      paymentAsset,
      paymentSymbol: assetByAddress(assets, paymentAsset)?.symbol ?? '?',
      allowedBuyer: String(raw.allowedBuyer) === ZERO ? null : String(raw.allowedBuyer),
      isPrivate: String(raw.allowedBuyer) !== ZERO,
      fixedPrice: String(raw.fixedPrice),
      minPrice: String(raw.minPrice),
      rateBps: Number(raw.rateBps),
      dynamic: Number(raw.rateBps) > 0,
      expiry,
      minHealthFactor,
      quickSale: Boolean(raw.quickSale),
      currentPrice,
      status: chainTimestamp > expiry
        ? 'expired'
        : BigInt(hf) < BigInt(minHealthFactor)
          ? 'invalid'
          : currentPrice === null ? 'unknown' : 'active',
      premiumBps: premium(currentPrice, position, paymentAsset, assets, prices),
      secondsLeft: Math.max(0, expiry - chainTimestamp),
      position,
    });
  });

  return {
    deployment, assets, prices, paused, feeBps: Number(feeBps), feeRecipient,
    positions, listings, chainTimestamp, blockNumber,
  };
}

function premium(
  currentPrice: string | null, position: Position, paymentAsset: string,
  assets: ServerAsset[], prices: Record<string, string | null>,
): number | null {
  const asset = assetByAddress(assets, paymentAsset);
  const price = asset ? prices[asset.symbol] : null;
  if (!currentPrice || !asset || !price) return null;
  const base = (BigInt(currentPrice) * BigInt(price)) / 10n ** BigInt(asset.decimals);
  const net = BigInt(position.netValueBase);
  if (net === 0n) return null;
  return Number(((base - net) * 10_000n) / net);
}

/// One page draws three to five of these hooks and the polling loop wakes them together, so
/// without sharing, a single refresh would multicall the whole position set once per hook and
/// the hooks could each land on a different block. They share one read per round instead, and
/// the round ends when the cache is invalidated.
type Snapshot = Awaited<ReturnType<typeof readEverything>>;
let snapshot: Promise<Snapshot> | null = null;
let snapshotAt = 0;

/// Long enough that the hooks woken by one refresh share a read, short enough that it never
/// stands in for the next one. A time window rather than an event, because the hooks and this
/// module listen to the same event and the order they run in is not something to depend on.
const SNAPSHOT_TTL_MS = 1500;

function currentSnapshot(): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshotAt < SNAPSHOT_TTL_MS) return snapshot;
  snapshotAt = Date.now();
  snapshot = readEverything().catch((err) => {
    // A failed read must not be remembered, or every later call would reject with it.
    snapshot = null;
    snapshotAt = 0;
    throw err;
  });
  return snapshot;
}

/** Answers the same routes the indexer serves, for the subset a static site needs. */
export async function serveFromChain<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  const data = await currentSnapshot();

  if (path === '/api/config') {
    const config: Config = {
      chainId: data.deployment.chainId,
      rpcUrl: import.meta.env.VITE_RPC_URL
        ?? DEFAULT_RPC[data.deployment.chainId]
        ?? 'http://127.0.0.1:8545',
      isLocal: data.deployment.chainId !== 11155111,
      contracts: {
        positionManager: data.deployment.positionManager,
        marketplace: data.deployment.marketplace,
        pool: data.deployment.pool,
        poolAddressesProvider: data.deployment.poolAddressesProvider,
        oracle: data.deployment.oracle,
        faucet: data.deployment.faucet,
      },
      feeBps: data.feeBps,
      feeRecipient: data.feeRecipient,
      paused: data.paused,
      assets: data.assets,
      prices: data.prices,
    };
    return config as T;
  }

  if (path === '/api/listings') {
    let rows = data.listings;
    const status = String(params.status ?? 'active');
    if (status !== 'all') rows = rows.filter((l) => l.status === status);
    if (params.includePrivate !== true) rows = rows.filter((l) => !l.isPrivate);
    if (params.asset) {
      const want = String(params.asset).toUpperCase();
      rows = rows.filter((l) =>
        (l.position?.collateral ?? []).some((c) => c.symbol === want)
        || (l.position?.debt ?? []).some((d) => d.symbol === want));
    }
    if (params.quickSale) rows = rows.filter((l) => l.quickSale);
    if (params.minHealthFactor) {
      // BigInt() throws on "1.2", and that throw would take the whole market page down rather
      // than the one filter. An unreadable value means no filter.
      const raw = String(params.minHealthFactor);
      if (/^\d+$/.test(raw)) {
        const floor = BigInt(raw);
        rows = rows.filter((l) => l.position && BigInt(l.position.healthFactor) >= floor);
      }
    }
    const sort = String(params.sort ?? 'expiry');
    const key: Record<string, (l: Listing) => number> = {
      expiry: (l) => l.expiry,
      premium: (l) => l.premiumBps ?? 1e9,
      netValue: (l) => Number(l.position?.netValueBase ?? 0),
      healthFactor: (l) => Number(l.position?.healthFactor ?? 0),
      tokenId: (l) => Number(l.tokenId),
    };
    rows = [...rows].sort((a, b) => (key[sort] ?? key.expiry)(a) - (key[sort] ?? key.expiry)(b));
    return {
      total: rows.length, offset: 0, limit: rows.length,
      indexedAt: Date.now(), blockNumber: data.blockNumber, items: rows,
    } as T;
  }

  if (path.startsWith('/api/listings/')) {
    const id = path.split('/')[3];
    const found = data.listings.find((l) => l.tokenId === id);
    if (!found) throw new Error('not listed');
    return found as T;
  }

  if (path === '/api/positions') {
    let rows = data.positions;
    if (params.owner) {
      const owner = String(params.owner).toLowerCase();
      // A listed position is owned by the marketplace, so the seller has to be matched too or
      // it disappears from their own portfolio while it is on sale.
      rows = rows.filter((p) => {
        if (p.owner.toLowerCase() === owner) return true;
        const listing = data.listings.find((l) => l.tokenId === p.tokenId);
        return listing !== undefined && listing.seller.toLowerCase() === owner;
      });
    }
    return {
      total: rows.length, indexedAt: Date.now(),
      items: rows.map((p) => ({
        ...p, listing: data.listings.find((l) => l.tokenId === p.tokenId) ?? null,
      })),
    } as T;
  }

  if (path.startsWith('/api/positions/')) {
    const id = path.split('/')[3];
    const found = data.positions.find((p) => p.tokenId === id);
    if (!found) throw new Error('unknown position');
    return {
      ...found, listing: data.listings.find((l) => l.tokenId === id) ?? null,
    } as T;
  }

  if (path === '/api/history') {
    // Activity needs a log index. Without a server this stays empty rather than
    // asking a public endpoint for the whole chain history.
    return { total: 0, items: [] as HistoryEntry[] } as T;
  }

  if (path === '/api/stats') {
    return {
      chainId: data.deployment.chainId,
      head: data.blockNumber,
      lastIndexedAt: Date.now(),
      listings: data.listings.length,
      positions: data.positions.length,
      sales: 0,
      paused: data.paused,
      activeListings: data.listings.filter((l) => l.status === 'active').length,
      totals: { sales: 0, volumeByAsset: {}, feesByAsset: {} },
      prices: data.prices,
    } as T;
  }

  throw new Error(`no server, and this route is not available from the chain: ${path}`);
}

/** Drops the cached snapshot so the next read goes back to the chain. */
export function invalidateChainCache() {
  snapshot = null;
  snapshotAt = 0;
}
