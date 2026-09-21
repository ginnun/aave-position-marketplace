import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAIN_ID, PUBLIC_RPC_URL, RPC_URL, assets, assetByAddress, deployment, redact } from './chain.js';
import { events, isStale, start, state, summary } from './indexer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SERVER_PORT ?? 8787);

// ---------------------------------------------------------------- helpers

function json(res, status, body) {
  const payload = JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function num(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/// A query string the caller got wrong is a 400, not a 500. Thrown here, answered by the
/// route handler, so a bad filter never reads as a server fault.
class BadRequest extends Error {}

/// BigInt() throws a SyntaxError on anything that is not a plain integer, and "1.2" or
/// "1e18" are exactly what a person types by hand. Reject those with a reason.
function bigParam(q, name) {
  const raw = q.get(name);
  if (raw === null || raw === '') return null;
  if (!/^\d+$/.test(raw)) {
    throw new BadRequest(`${name} must be a whole number in base units`);
  }
  return BigInt(raw);
}

/// Converts a payment asset amount into the oracle base currency, which is USD with 8 decimals.
function toBase(amountStr, asset) {
  const price = state.prices?.[asset.symbol];
  if (!price || amountStr == null) return null;
  return (BigInt(amountStr) * BigInt(price)) / 10n ** BigInt(asset.decimals);
}

/// Negative means a discount to net value, positive a premium. Expressed in basis points.
function premiumBps(listing, position) {
  if (!position || !listing.currentPrice) return null;
  const asset = assetByAddress.get(listing.paymentAsset.toLowerCase());
  if (!asset) return null;
  const priceBase = toBase(listing.currentPrice, asset);
  const net = BigInt(position.netValueBase ?? 0);
  if (priceBase == null || net === 0n) return null;
  return Number(((priceBase - net) * 10_000n) / net);
}

function listingView(listing) {
  const position = state.positions.get(listing.tokenId) ?? null;
  return {
    ...listing,
    premiumBps: premiumBps(listing, position),
    // secondsLeft comes from the indexer, measured against the chain clock.
    position,
  };
}

function allListings() {
  return [...state.listings.values()].map(listingView);
}

// ---------------------------------------------------------------- routes

function getListings(url) {
  const q = url.searchParams;
  const status = q.get('status') ?? 'active';
  let rows = allListings();

  if (status !== 'all') rows = rows.filter((l) => l.status === status);
  if (q.get('includePrivate') !== 'true') rows = rows.filter((l) => !l.isPrivate);
  if (q.get('seller')) {
    const s = q.get('seller').toLowerCase();
    rows = rows.filter((l) => l.seller.toLowerCase() === s);
  }
  if (q.get('paymentAsset')) {
    const a = q.get('paymentAsset').toLowerCase();
    rows = rows.filter((l) => l.paymentAsset.toLowerCase() === a);
  }
  if (q.get('asset')) {
    const want = q.get('asset').toUpperCase();
    rows = rows.filter((l) =>
      (l.position?.collateral ?? []).some((c) => c.symbol === want)
      || (l.position?.debt ?? []).some((d) => d.symbol === want));
  }
  if (q.get('quickSale') === 'true') rows = rows.filter((l) => l.quickSale);

  const minHf = bigParam(q, 'minHealthFactor');
  const maxHf = bigParam(q, 'maxHealthFactor');
  if (minHf !== null) rows = rows.filter((l) => l.position && BigInt(l.position.healthFactor) >= minHf);
  if (maxHf !== null) rows = rows.filter((l) => l.position && BigInt(l.position.healthFactor) <= maxHf);

  const maxPremium = q.get('maxPremiumBps');
  if (maxPremium) {
    rows = rows.filter((l) => l.premiumBps !== null && l.premiumBps <= num(maxPremium, 0));
  }
  const minNet = bigParam(q, 'minNetValueBase');
  if (minNet !== null) rows = rows.filter((l) => l.position && BigInt(l.position.netValueBase) >= minNet);

  const sort = q.get('sort') ?? 'expiry';
  const dir = q.get('order') === 'desc' ? -1 : 1;
  // A Map, not an object: `?sort=hasOwnProperty` would otherwise pull a function off
  // Object.prototype, survive the ?? fallback, and throw when called without a receiver.
  const keys = new Map([
    ['expiry', (l) => l.expiry],
    ['premium', (l) => l.premiumBps ?? 1e9],
    ['netValue', (l) => Number(l.position?.netValueBase ?? 0)],
    ['healthFactor', (l) => Number(l.position?.healthFactor ?? 0)],
    ['tokenId', (l) => Number(l.tokenId)],
  ]);
  if (!keys.has(sort)) throw new BadRequest(`unknown sort ${sort}`);
  const key = keys.get(sort);
  rows.sort((a, b) => (key(a) - key(b)) * dir);

  const offset = num(q.get('offset'), 0);
  const limit = Math.min(num(q.get('limit'), 50), 200);
  return {
    total: rows.length,
    offset,
    limit,
    indexedAt: state.lastIndexedAt,
    blockNumber: state.head.toString(),
    items: rows.slice(offset, offset + limit),
  };
}

function getPositions(url) {
  const owner = url.searchParams.get('owner');
  let rows = [...state.positions.values()].filter((p) => !p.burned);
  if (owner) {
    const want = owner.toLowerCase();
    // While a position is listed the marketplace owns the token, so matching on the owner alone
    // would drop it out of the seller's own portfolio along with every way to cancel or repay.
    rows = rows.filter((p) => {
      if (p.owner.toLowerCase() === want) return true;
      const listing = state.listings.get(p.tokenId);
      return Boolean(listing) && listing.seller.toLowerCase() === want;
    });
  }
  return {
    total: rows.length,
    indexedAt: state.lastIndexedAt,
    items: rows.map((p) => ({
      ...p,
      listing: state.listings.get(p.tokenId) ?? null,
    })),
  };
}

function getHistory(url) {
  const address = url.searchParams.get('address')?.toLowerCase();
  const tokenId = url.searchParams.get('tokenId');
  let rows = state.history.slice().reverse();
  if (tokenId) rows = rows.filter((h) => h.tokenId === tokenId);
  if (address) {
    rows = rows.filter((h) =>
      [h.actor, h.seller, h.buyer].filter(Boolean).some((a) => a.toLowerCase() === address));
  }
  const limit = Math.min(num(url.searchParams.get('limit'), 100), 500);
  return { total: rows.length, items: rows.slice(0, limit) };
}

function getConfig() {
  return {
    chainId: CHAIN_ID,
    // Never the endpoint this process reads from. That one may carry a private API key, and
    // this route answers anyone who asks.
    rpcUrl: PUBLIC_RPC_URL,
    isLocal: CHAIN_ID !== 11155111,
    contracts: {
      positionManager: deployment.positionManager,
      marketplace: deployment.marketplace,
      pool: deployment.pool,
      poolAddressesProvider: deployment.poolAddressesProvider,
      oracle: deployment.oracle,
      faucet: deployment.faucet,
    },
    feeBps: state.feeBps ?? deployment.feeBps,
    feeRecipient: state.feeRecipient ?? deployment.feeRecipient,
    paused: state.paused ?? false,
    assets,
    prices: state.prices ?? {},
  };
}

/// Every open stream holds a listener, an interval and a socket for as long as the caller
/// keeps it. Without a ceiling one client can open thousands and take the process down, and
/// Node starts warning past ten listeners on the same emitter.
const MAX_STREAMS = Number(process.env.MAX_STREAMS ?? 200);
let openStreams = 0;
events.setMaxListeners(MAX_STREAMS + 10);

function stream(res) {
  if (openStreams >= MAX_STREAMS) {
    return json(res, 429, { error: 'too many open streams' });
  }
  openStreams += 1;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });
  // A reader that stops draining would otherwise grow the socket buffer without limit.
  // Dropping an update is safe: the next one carries the whole summary again.
  let backedUp = false;
  const write = (chunk) => {
    if (backedUp) return;
    if (!res.write(chunk)) {
      backedUp = true;
      res.once('drain', () => { backedUp = false; });
    }
  };
  const send = (data) => write(`data: ${JSON.stringify(data)}\n\n`);
  send(summary());
  const onUpdate = (s) => send(s);
  events.on('update', onUpdate);
  const ping = setInterval(() => write(': ping\n\n'), 25_000);
  let closed = false;
  res.on('close', () => {
    if (closed) return;
    closed = true;
    openStreams -= 1;
    events.off('update', onUpdate);
    clearInterval(ping);
  });
}

// ---------------------------------------------------------------- server

const openapi = JSON.parse(readFileSync(join(HERE, 'openapi.json'), 'utf8'));

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,OPTIONS',
    });
    return res.end();
  }
  // A malformed Host header or path makes URL parsing throw. Outside the try that ends the
  // process, and any unauthenticated caller could repeat it. Same guard as deploy-stack/serve.js.
  let url;
  let path;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
    path = url.pathname.replace(/\/$/, '') || '/';
  } catch {
    return json(res, 400, { error: 'malformed request' });
  }

  try {
    if (path === '/api/health') {
      const healthy = state.ready && !isStale();
      return json(res, healthy ? 200 : 503, { ...summary(), error: state.error });
    }
    if (!state.ready) return json(res, 503, { error: 'indexer is still catching up' });

    if (path === '/api/config') return json(res, 200, getConfig());
    if (path === '/api/listings') return json(res, 200, getListings(url));
    if (path.startsWith('/api/listings/')) {
      const id = path.split('/')[3];
      const l = state.listings.get(id);
      return l ? json(res, 200, listingView(l)) : json(res, 404, { error: 'not listed' });
    }
    if (path === '/api/positions') return json(res, 200, getPositions(url));
    if (path.startsWith('/api/positions/')) {
      const id = path.split('/')[3];
      const p = state.positions.get(id);
      if (!p) return json(res, 404, { error: 'unknown position' });
      return json(res, 200, { ...p, listing: state.listings.get(id) ?? null });
    }
    if (path === '/api/history') return json(res, 200, getHistory(url));
    if (path === '/api/stats') {
      return json(res, 200, {
        ...summary(),
        totals: state.totals,
        activeListings: allListings().filter((l) => l.status === 'active').length,
        prices: state.prices,
      });
    }
    if (path === '/api/stream') return stream(res);
    if (path === '/api/openapi.json') return json(res, 200, openapi);
    if (path === '/') {
      return json(res, 200, {
        name: 'Aave position marketplace API',
        docs: '/api/openapi.json',
        routes: ['/api/config', '/api/listings', '/api/positions', '/api/history',
          '/api/stats', '/api/stream', '/api/health'],
      });
    }
    return json(res, 404, { error: 'unknown route' });
  } catch (err) {
    if (err instanceof BadRequest) return json(res, 400, { error: err.message });
    console.error('[api]', redact(err));
    return json(res, 500, { error: 'internal error' });
  }
});

await start();
server.listen(PORT, () => {
  // Host only. The full url can carry an API key, and logs get shared.
  const upstream = (() => {
    try { return new URL(RPC_URL).host; } catch { return 'unknown'; }
  })();
  console.log(`[server] chain ${CHAIN_ID} via ${upstream}`);
  console.log(`[server] listening on http://127.0.0.1:${PORT}`);
});
