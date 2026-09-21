import { EventEmitter } from 'node:events';
import {
  abi, assetByAddress, assetByAToken, assets, client, deployment,
  ORACLE_ABI, POOL_ABI, PROVIDER_ABI, redact,
} from './chain.js';

/// How many blocks behind the head are treated as settled. Anything newer is
/// read again on every poll, so a chain reorganisation corrects itself.
const CONFIRMATIONS = 5;
const POLL_MS = Number(process.env.POLL_MS ?? 3000);
const LOG_CHUNK = 5000n;
/// How long a snapshot may go unrefreshed before the service calls itself unhealthy.
const STALE_MS = Number(process.env.STALE_MS ?? POLL_MS * 5);

const MANAGER = deployment.positionManager;
const MARKET = deployment.marketplace;

export const events = new EventEmitter();

/// Everything the API serves. It is rebuilt from chain logs, never written by hand.
export const state = {
  chainId: deployment.chainId,
  ready: false,
  head: 0n,
  settledBlock: 0n,
  lastIndexedAt: 0,
  lastPricedAt: 0,
  positions: new Map(), // tokenId -> { tokenId, account, owner, burned }
  listings: new Map(),  // tokenId -> listing record
  history: [],          // newest last
  totals: { sales: 0, volumeByAsset: {}, feesByAsset: {} },
  error: null,
};

const settled = {
  positions: new Map(),
  listings: new Map(),
  history: [],
  totals: { sales: 0, volumeByAsset: {}, feesByAsset: {} },
  block: 0n,
  hash: null,
};

// ---------------------------------------------------------------- log reading

function eventAbi(contract, name) {
  return abi[contract].filter((x) => x.type === 'event' && x.name === name);
}

const WATCHED = [
  ...eventAbi('PositionManager', 'PositionCreated'),
  ...eventAbi('PositionManager', 'MigratedIn'),
  ...eventAbi('PositionManager', 'MigratedOut'),
  ...eventAbi('PositionManager', 'PositionAction'),
  ...eventAbi('PositionManager', 'Transfer'),
  ...eventAbi('Marketplace', 'Listed'),
  ...eventAbi('Marketplace', 'ListingUpdated'),
  ...eventAbi('Marketplace', 'ListingCancelled'),
  ...eventAbi('Marketplace', 'ListingClosed'),
  ...eventAbi('Marketplace', 'Sold'),
  ...eventAbi('Marketplace', 'PausedUpdated'),
  ...eventAbi('Marketplace', 'FeeUpdated'),
];

/// Providers cap a log query by block span or by result count, and the cap differs between
/// them. A fixed chunk that is one block too wide would fail on every poll forever, so a
/// failed range is halved and retried until it fits or until a single block still fails.
async function readRange(fromBlock, toBlock) {
  try {
    return await client.getLogs({
      address: [MANAGER, MARKET],
      events: WATCHED,
      fromBlock,
      toBlock,
    });
  } catch (err) {
    if (toBlock <= fromBlock) throw err;
    const mid = fromBlock + (toBlock - fromBlock) / 2n;
    console.warn(`[indexer] log range ${fromBlock}-${toBlock} failed, splitting`);
    const left = await readRange(fromBlock, mid);
    const right = await readRange(mid + 1n, toBlock);
    return [...left, ...right];
  }
}

async function readLogs(fromBlock, toBlock) {
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n > toBlock ? toBlock : start + LOG_CHUNK - 1n;
    out.push(...await readRange(start, end));
  }
  out.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : Number(a.blockNumber - b.blockNumber));
  return out;
}

// ---------------------------------------------------------------- reducer

function blankView() {
  return {
    positions: new Map(),
    listings: new Map(),
    history: [],
    totals: { sales: 0, volumeByAsset: {}, feesByAsset: {} },
    paused: false,
    feeBps: Number(deployment.feeBps ?? 0),
    feeRecipient: deployment.feeRecipient,
  };
}

function cloneView(v) {
  return {
    positions: new Map([...v.positions].map(([k, p]) => [k, { ...p }])),
    listings: new Map([...v.listings].map(([k, l]) => [k, { ...l }])),
    history: v.history.slice(),
    totals: {
      sales: v.totals.sales,
      volumeByAsset: { ...v.totals.volumeByAsset },
      feesByAsset: { ...v.totals.feesByAsset },
    },
    paused: v.paused,
    feeBps: v.feeBps,
    feeRecipient: v.feeRecipient,
  };
}

const ZERO = '0x0000000000000000000000000000000000000000';

function listingFrom(raw, tokenId) {
  return {
    tokenId,
    seller: raw.seller,
    paymentAsset: raw.paymentAsset,
    paymentSymbol: assetByAddress.get(raw.paymentAsset.toLowerCase())?.symbol ?? '?',
    allowedBuyer: raw.allowedBuyer === ZERO ? null : raw.allowedBuyer,
    isPrivate: raw.allowedBuyer !== ZERO,
    fixedPrice: raw.fixedPrice.toString(),
    minPrice: raw.minPrice.toString(),
    rateBps: Number(raw.rateBps),
    dynamic: Number(raw.rateBps) > 0,
    expiry: Number(raw.expiry),
    minHealthFactor: raw.minHealthFactor.toString(),
    quickSale: raw.quickSale,
  };
}

function record(view, log, entry) {
  view.history.push({
    ...entry,
    blockNumber: Number(log.blockNumber),
    txHash: log.transactionHash,
    logIndex: log.logIndex,
  });
}

function apply(view, log) {
  const a = log.args;
  const id = a.tokenId !== undefined ? a.tokenId.toString() : null;

  switch (log.eventName) {
    case 'PositionCreated': {
      view.positions.set(id, {
        tokenId: id, account: a.account, owner: a.owner, burned: false,
        createdBlock: Number(log.blockNumber),
      });
      record(view, log, { type: 'created', tokenId: id, actor: a.owner });
      break;
    }
    case 'Transfer': {
      const p = view.positions.get(id);
      if (!p) break;
      if (a.to === ZERO) p.burned = true;
      else p.owner = a.to;
      break;
    }
    case 'MigratedIn':
      record(view, log, { type: 'migratedIn', tokenId: id, actor: a.from });
      break;
    case 'MigratedOut':
      record(view, log, { type: 'migratedOut', tokenId: id, actor: a.to });
      break;
    case 'PositionAction': {
      const asset = assetByAddress.get((a.asset ?? ZERO).toLowerCase());
      record(view, log, {
        type: 'action',
        tokenId: id,
        // The event carries no caller, so the controller is resolved from the state at this
        // point in the log: the seller while the position sits in escrow, the owner otherwise.
        actor: controllerOf(view, id),
        action: decodeAction(a.action),
        asset: a.asset,
        assetSymbol: asset?.symbol ?? null,
        amount: a.amount.toString(),
        decimals: asset?.decimals ?? 18,
      });
      break;
    }
    case 'Listed':
    case 'ListingUpdated': {
      view.listings.set(id, listingFrom(a.listing, id));
      record(view, log, {
        type: log.eventName === 'Listed' ? 'listed' : 'listingUpdated',
        tokenId: id,
        actor: a.listing.seller,
      });
      break;
    }
    case 'ListingCancelled':
      view.listings.delete(id);
      record(view, log, { type: 'cancelled', tokenId: id, actor: a.seller });
      break;
    case 'ListingClosed':
      view.listings.delete(id);
      record(view, log, { type: 'expired', tokenId: id, actor: a.seller });
      break;
    case 'Sold': {
      view.listings.delete(id);
      const sym = assetByAddress.get(a.paymentAsset.toLowerCase())?.symbol ?? '?';
      view.totals.sales += 1;
      view.totals.volumeByAsset[sym] =
        (BigInt(view.totals.volumeByAsset[sym] ?? 0n) + a.price).toString();
      view.totals.feesByAsset[sym] =
        (BigInt(view.totals.feesByAsset[sym] ?? 0n) + a.fee).toString();
      record(view, log, {
        type: 'sold',
        tokenId: id,
        actor: a.buyer,
        seller: a.seller,
        buyer: a.buyer,
        asset: a.paymentAsset,
        assetSymbol: sym,
        price: a.price.toString(),
        fee: a.fee.toString(),
        netValueBase: a.netValueBase.toString(),
        debtBase: a.debtBase.toString(),
      });
      break;
    }
    case 'PausedUpdated':
      view.paused = a.paused;
      record(view, log, { type: 'paused', paused: a.paused });
      break;
    case 'FeeUpdated':
      view.feeBps = Number(a.feeBps);
      view.feeRecipient = a.feeRecipient;
      record(view, log, {
        type: 'feeUpdated', feeBps: Number(a.feeBps), feeRecipient: a.feeRecipient,
      });
      break;
    default:
      break;
  }
}

/// Who could have driven a position action at this point in the log.
function controllerOf(view, tokenId) {
  const listing = view.listings.get(tokenId);
  if (listing) return listing.seller;
  return view.positions.get(tokenId)?.owner ?? null;
}

function decodeAction(bytes32) {
  const hex = bytes32.slice(2).replace(/(00)+$/, '');
  return Buffer.from(hex, 'hex').toString('utf8');
}

// ---------------------------------------------------------------- live values

/// Aave governance can point the addresses provider at a new oracle or pool, and the
/// contracts resolve both through the provider on every call. Reading the deployment file
/// instead would quietly price listings against an oracle the contract no longer uses, so
/// the live addresses are resolved here and the file is only a fallback.
const AAVE_REFRESH_MS = 60_000;
let aaveAddresses = { oracle: deployment.oracle, pool: deployment.pool, at: 0 };

async function resolveAave() {
  if (Date.now() - aaveAddresses.at < AAVE_REFRESH_MS) return aaveAddresses;
  const provider = deployment.poolAddressesProvider;
  if (!provider) return aaveAddresses;
  const [oracle, pool] = await client.multicall({
    contracts: [
      { address: provider, abi: PROVIDER_ABI, functionName: 'getPriceOracle' },
      { address: provider, abi: PROVIDER_ABI, functionName: 'getPool' },
    ],
    allowFailure: true,
  });
  aaveAddresses = {
    oracle: oracle.status === 'success' ? oracle.result : aaveAddresses.oracle,
    pool: pool.status === 'success' ? pool.result : aaveAddresses.pool,
    at: Date.now(),
  };
  return aaveAddresses;
}

/// Reads the values that change without an event: balances, prices, health factors.
async function enrich(view) {
  const live = [...view.positions.values()].filter((p) => !p.burned);
  if (live.length === 0) return { positions: [], prices: {} };

  const { oracle: oracleAddress, pool: poolAddress } = await resolveAave();
  const accountCalls = live.map((p) => ({
    address: poolAddress, abi: POOL_ABI, functionName: 'getUserAccountData',
    args: [p.account],
  }));
  const scanCalls = live.map((p) => ({
    address: MANAGER, abi: abi.PositionManager, functionName: 'scan', args: [p.account],
  }));
  const eModeCalls = live.map((p) => ({
    address: poolAddress, abi: POOL_ABI, functionName: 'getUserEMode', args: [p.account],
  }));
  const priceCalls = assets.map((asset) => ({
    address: oracleAddress, abi: ORACLE_ABI, functionName: 'getAssetPrice',
    args: [asset.address],
  }));

  const results = await client.multicall({
    contracts: [...accountCalls, ...scanCalls, ...eModeCalls, ...priceCalls],
    allowFailure: true,
  });

  const n = live.length;
  const prices = {};
  assets.forEach((asset, i) => {
    const r = results[3 * n + i];
    prices[asset.symbol] = r.status === 'success' ? r.result.toString() : null;
  });

  const positions = live.map((p, i) => {
    const acc = results[i];
    const scan = results[n + i];
    const eMode = results[2 * n + i];
    // A failed read still has to produce a whole record. Pages map over the asset arrays and
    // convert the totals, so a half built one blanks the interface exactly when a read fails.
    if (acc.status !== 'success') {
      return {
        ...p,
        unavailable: true,
        totalCollateralBase: '0',
        totalDebtBase: '0',
        netValueBase: '0',
        availableBorrowsBase: '0',
        liquidationThreshold: 0,
        ltv: 0,
        healthFactor: '0',
        eModeCategory: 0,
        collateral: [],
        debt: [],
      };
    }

    const [collateralBase, debtBase, availableBase, liqThreshold, ltv, hf] = acc.result;
    const breakdown = scan.status === 'success'
      ? buildBreakdown(scan.result)
      : { collateral: [], debt: [] };

    return {
      ...p,
      totalCollateralBase: collateralBase.toString(),
      totalDebtBase: debtBase.toString(),
      netValueBase: (collateralBase > debtBase ? collateralBase - debtBase : 0n).toString(),
      availableBorrowsBase: availableBase.toString(),
      liquidationThreshold: Number(liqThreshold),
      ltv: Number(ltv),
      healthFactor: hf.toString(),
      eModeCategory: eMode.status === 'success' ? Number(eMode.result) : 0,
      ...breakdown,
    };
  });

  return { positions, prices };
}

function buildBreakdown([aTokens, aBalances, debtAssets, debtAmounts]) {
  const collateral = aTokens.map((aToken, i) => {
    const asset = assetByAToken.get(aToken.toLowerCase());
    return {
      symbol: asset?.symbol ?? aToken,
      address: asset?.address ?? null,
      aToken,
      decimals: asset?.decimals ?? 18,
      amount: aBalances[i].toString(),
    };
  });
  const debt = debtAssets.map((address, i) => {
    const asset = assetByAddress.get(address.toLowerCase());
    return {
      symbol: asset?.symbol ?? address,
      address,
      decimals: asset?.decimals ?? 18,
      amount: debtAmounts[i].toString(),
    };
  });
  return { collateral, debt };
}

/// Current asking price straight from the marketplace, so the interface and the
/// contract always agree on what a purchase would cost.
async function priceListings(view) {
  const ids = [...view.listings.keys()];
  if (ids.length === 0) return {};
  const results = await client.multicall({
    contracts: ids.map((id) => ({
      address: MARKET, abi: abi.Marketplace, functionName: 'currentPrice', args: [BigInt(id)],
    })),
    allowFailure: true,
  });
  const out = {};
  ids.forEach((id, i) => {
    out[id] = results[i].status === 'success' ? results[i].result.toString() : null;
  });
  return out;
}

// ---------------------------------------------------------------- loop

let view = blankView();
let cursor = BigInt(deployment.deployBlock);

async function tick() {
  // The head is published at the end of this pass, together with the data read for it.
  // Announcing it earlier would tell a reader that a block is indexed while the
  // listings and positions still describe the block before it.
  const head = await client.getBlockNumber({ cacheTime: 0 });
  // A development chain can be moved forward in time. Expiry has to be judged by the
  // clock the contract reads, which is the block timestamp, not by this machine's clock.
  const chainTime = Number((await client.getBlock({ blockNumber: head })).timestamp);

  // The chain got shorter than what has already been read. That happens after a deep
  // reorganisation, and on a development chain that was rebuilt. Start over from the
  // deployment block rather than serve state that no longer exists.
  const rebuild = (why) => {
    console.warn(`[indexer] ${why}, rebuilding`);
    settled.view = blankView();
    settled.block = 0n;
    settled.hash = null;
    cursor = BigInt(deployment.deployBlock);
  };

  if (head + 1n < cursor) {
    rebuild(`chain head ${head} is behind cursor ${cursor}`);
  } else if (settled.block > 0n && settled.hash) {
    // A reorganisation that keeps the chain the same length or makes it longer leaves the
    // head ahead of the cursor, so the check above cannot see it. Five blocks is not
    // finality on a proof-of-stake testnet, so confirm the settled block is still the one
    // that was read. A hash that no longer matches means the snapshot describes a chain
    // that no longer exists.
    const still = await client.getBlock({ blockNumber: settled.block }).catch(() => null);
    if (!still || still.hash !== settled.hash) {
      rebuild(`settled block ${settled.block} changed under us`);
    }
  }

  const settledTarget = head > BigInt(CONFIRMATIONS) ? head - BigInt(CONFIRMATIONS) : 0n;

  // Advance the settled snapshot, then always replay the unsettled tail on top of
  // it. A reorganisation can only touch the tail, so it is corrected on the next poll.
  if (settledTarget >= cursor) {
    const logs = await readLogs(cursor, settledTarget);
    // Build the next snapshot beside the live one. Applying in place would leave half the
    // logs applied with the cursor unmoved if a single log threw, and the next poll would
    // replay them on top of themselves: duplicate history rows and double-counted sales.
    const next = cloneView(settled.view ?? blankView());
    for (const log of logs) apply(next, log);
    const target = await client.getBlock({ blockNumber: settledTarget });
    settled.view = next;
    settled.hash = target.hash;
    cursor = settledTarget + 1n;
    settled.block = settledTarget;
  }
  if (!settled.view) settled.view = blankView();

  view = cloneView(settled.view);
  if (head >= cursor) {
    const tail = await readLogs(cursor, head);
    for (const log of tail) apply(view, log);
  }

  const [{ positions, prices }, listingPrices] = await Promise.all([
    enrich(view), priceListings(view),
  ]);

  state.positions = new Map(positions.map((p) => [p.tokenId, p]));
  state.listings = new Map(
    [...view.listings].map(([id, l]) => [id, {
      ...l,
      currentPrice: listingPrices[id] ?? null,
      status: listingStatus(l, state.positions.get(id), listingPrices[id], chainTime),
      secondsLeft: Math.max(0, l.expiry - chainTime),
    }]),
  );
  state.history = view.history;
  state.totals = view.totals;
  state.paused = view.paused;
  state.feeBps = view.feeBps;
  state.feeRecipient = view.feeRecipient;
  state.prices = prices;
  state.settledBlock = settled.block;
  state.head = head;
  state.chainTime = chainTime;
  state.lastIndexedAt = Date.now();
  state.ready = true;
  state.error = null;
  events.emit('update', summary());
}

function listingStatus(listing, position, price, chainTime) {
  if (chainTime > listing.expiry) return 'expired';
  if (!position || position.unavailable) return 'unknown';
  if (BigInt(position.healthFactor) < BigInt(listing.minHealthFactor)) return 'invalid';
  if (price === null || price === undefined) return 'unknown';
  return 'active';
}

export function summary() {
  return {
    chainId: state.chainId,
    head: state.head.toString(),
    settledBlock: state.settledBlock.toString(),
    lastIndexedAt: state.lastIndexedAt,
    chainTime: state.chainTime ?? 0,
    listings: state.listings.size,
    positions: state.positions.size,
    sales: state.totals.sales,
    paused: state.paused ?? false,
    stale: isStale(),
  };
}

/// A snapshot that stopped being refreshed still answers every question, and it answers
/// them with prices and health factors that may be hours old. Callers need to be able to
/// tell that apart from a healthy service.
export function isStale() {
  if (!state.ready) return false;
  return Date.now() - state.lastIndexedAt > STALE_MS;
}

export async function start() {
  // Retrying a failing call at the normal poll rate makes a rate-limited provider worse and
  // never gives a recovering one room to come back. Each consecutive failure doubles the
  // wait, up to a minute; one success puts it back to the normal rate.
  const MAX_BACKOFF_MS = 60_000;
  let failures = 0;
  const run = async () => {
    try {
      await tick();
      failures = 0;
    } catch (err) {
      failures += 1;
      state.error = redact(err);
      console.error('[indexer]', state.error);
    }
    const wait = failures === 0
      ? POLL_MS
      : Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS);
    setTimeout(run, wait);
  };
  await run();
}
