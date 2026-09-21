import { useCallback, useEffect, useRef, useState } from 'react';

export type AssetAmount = {
  symbol: string;
  address: string | null;
  aToken?: string;
  decimals: number;
  amount: string;
};

export type Position = {
  tokenId: string;
  account: string;
  owner: string;
  burned: boolean;
  createdBlock: number;
  unavailable?: boolean;
  totalCollateralBase: string;
  totalDebtBase: string;
  netValueBase: string;
  availableBorrowsBase: string;
  liquidationThreshold: number;
  ltv: number;
  healthFactor: string;
  eModeCategory: number;
  collateral: AssetAmount[];
  debt: AssetAmount[];
  listing?: Listing | null;
};

export type Listing = {
  tokenId: string;
  seller: string;
  paymentAsset: string;
  paymentSymbol: string;
  allowedBuyer: string | null;
  isPrivate: boolean;
  fixedPrice: string;
  minPrice: string;
  rateBps: number;
  dynamic: boolean;
  expiry: number;
  minHealthFactor: string;
  quickSale: boolean;
  currentPrice: string | null;
  status: 'active' | 'invalid' | 'expired' | 'unknown';
  premiumBps: number | null;
  secondsLeft: number;
  position: Position | null;
};

export type HistoryEntry = {
  type: string;
  tokenId?: string;
  actor?: string;
  seller?: string;
  buyer?: string;
  action?: string;
  asset?: string;
  assetSymbol?: string | null;
  amount?: string;
  decimals?: number;
  price?: string;
  fee?: string;
  paused?: boolean;
  feeBps?: number;
  blockNumber: number;
  txHash: string;
  logIndex: number;
};

export type ServerAsset = {
  symbol: string;
  address: string;
  decimals: number;
  aToken: string;
  variableDebtToken: string;
  faucetMintable: boolean;
  borrowable: boolean;
  /** Basis points, read from the market. */
  ltv: number;
  /** Basis points. Zero means the asset cannot be used as collateral. */
  liquidationThreshold: number;
};

export type Config = {
  chainId: number;
  /** What a browser should use. Null when the operator named none. */
  rpcUrl: string | null;
  isLocal: boolean;
  contracts: {
    positionManager: string;
    marketplace: string;
    pool: string;
    poolAddressesProvider: string;
    oracle: string;
    faucet: string;
  };
  feeBps: number;
  feeRecipient: string;
  paused: boolean;
  assets: ServerAsset[];
  prices: Record<string, string | null>;
};

export type Stats = {
  chainId: number;
  head: string;
  lastIndexedAt: number;
  listings: number;
  positions: number;
  sales: number;
  paused: boolean;
  activeListings: number;
  totals: { sales: number; volumeByAsset: Record<string, string>; feesByAsset: Record<string, string> };
  prices: Record<string, string | null>;
};

const BASE = import.meta.env.VITE_API_URL ?? '';

/** null means not decided yet. Once the indexer is known to be missing, the interface
 *  reads the chain directly and stops asking for it. */
let indexerReachable: boolean | null = null;
let probe: Promise<boolean> | null = null;

export function hasIndexer(): boolean {
  return indexerReachable !== false;
}

/**
 * Works out whether an indexer answers at all.
 *
 * A static host replies 404 to every /api path, which is a real answer: there is no indexer.
 * A dropped connection or a proxy 502 is not an answer, and treating it as one would pin the
 * interface to the chain-reading fallback, on a development machine against the wrong chain.
 * So a transient failure is retried, and never cached for long.
 */
const PROBE_RETRY_MS = 15_000;
let probedAt = 0;

async function probeOnce(): Promise<'present' | 'absent' | 'unknown'> {
  try {
    const res = await fetch(`${BASE}/api/health`, { headers: { accept: 'application/json' } });
    // 503 means the indexer is there and still catching up.
    if (res.status >= 500 && res.status !== 503) return 'unknown';
    if (!res.ok && res.status !== 503) return 'absent';
    const body = await res.json().catch(() => null);
    return typeof body?.chainId === 'number' ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

async function ensureIndexer(): Promise<boolean> {
  if (indexerReachable === true) return true;
  if (indexerReachable === false && Date.now() - probedAt < PROBE_RETRY_MS) return false;
  if (probe) return probe;

  probe = (async () => {
    for (const wait of [0, 300, 800]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const answer = await probeOnce();
      if (answer === 'present') return true;
      // An outright absence needs no retry. Only an unclear result does.
      if (answer === 'absent') return false;
    }
    return false;
  })().then((found) => {
    indexerReachable = found;
    probedAt = Date.now();
    probe = null;
    return found;
  });

  return probe;
}

async function fromServer<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== '' && v !== false) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `request failed with ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Reads through the indexer when one is reachable, and straight from the chain when
 * there is none. The second path is what lets this run as a plain static site.
 */
export async function api<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
  if (await ensureIndexer()) return fromServer<T>(path, params);
  const { serveFromChain } = await import('./chainRead');
  return serveFromChain<T>(path, params ?? {});
}

/** Re-reads whenever the indexer reports a new block, and on demand. */
export function useApi<T>(
  path: string | null,
  params?: Record<string, string | number | boolean | undefined>,
): { data: T | null; error: string | null; loading: boolean; reload: () => void; updatedAt: number } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [updatedAt, setUpdatedAt] = useState(0);
  const key = JSON.stringify([path, params]);
  // Counts requests rather than tracking one mounted flag. A flag is shared, so the next
  // effect turns it back on and a reply to an abandoned request can overwrite a newer one,
  // which on a position route means showing the previous position under the new heading.
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const mine = generation.current;
    try {
      const result = await api<T>(path, params);
      if (mine !== generation.current) return;
      setData(result);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      if (mine !== generation.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
    // params is compared through `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const lastKey = useRef(key);

  useEffect(() => {
    generation.current += 1;
    // A different resource must not be drawn with the previous one's data. Pages read this
    // data to decide which position they are acting on, so a stale hold is not cosmetic.
    // A refresh of the same resource keeps what it has, so results stay on screen.
    if (lastKey.current !== key) {
      lastKey.current = key;
      setData(null);
      setError(null);
    }
    // With no path there is nothing to wait for. Turning the flag on anyway would leave every
    // page that passes `address ? '/api/positions' : null` showing a spinner for as long as no
    // wallet is connected, because `load` returns before it can turn the flag back off.
    if (!path) {
      setLoading(false);
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    load();
    // Bumping the counter again on the way out retires anything still in flight.
    return () => { generation.current += 1; };
    // key is the identity of the request that `load` closes over
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, key]);

  useEffect(() => {
    const tick = () => load();
    window.addEventListener('chain:update', tick);
    return () => window.removeEventListener('chain:update', tick);
  }, [load]);

  return { data, error, loading, reload: load, updatedAt };
}

/** One connection for the whole page: the server pushes a note per indexed block. */
export function useChainStream(): { head: string | null; connected: boolean; direct: boolean } {
  const [head, setHead] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [direct, setDirect] = useState(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let lastHead = '';

    /**
     * Refreshes on a timer instead of a stream. Two cases need this: there is no
     * indexer at all, and there is one but server sent events do not reach us. Free
     * tunnels and some proxies drop event streams, and the page must not go quiet
     * because of that.
     */
    const startPolling = (readingChainDirectly: boolean) => {
      if (timer !== null || cancelled) return;
      setDirect(readingChainDirectly);
      setConnected(true);
      timer = setInterval(() => {
        window.dispatchEvent(new CustomEvent('chain:update'));
      }, 12_000);
    };

    ensureIndexer().then((found) => {
      // The probe is asynchronous, so cleanup can run first. Without this the continuation
      // opens a stream or an interval that nothing will ever close, and React's strict mode
      // double mount in development leaves a duplicate of each.
      if (cancelled) return undefined;
      if (!found) return startPolling(true);

      source = new EventSource(`${BASE}/api/stream`);
      source.onopen = () => {
        if (timer === null) setConnected(true);
      };
      source.onerror = () => {
        // The indexer answered its health route, so it is there. Only the stream is
        // not getting through. Keep reading it, just on a timer.
        source?.close();
        source = null;
        startPolling(false);
      };
      source.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        setHead(payload.head);
        if (payload.head !== lastHead) {
          lastHead = payload.head;
          window.dispatchEvent(new CustomEvent('chain:update'));
        }
      };
    });

    return () => {
      cancelled = true;
      source?.close();
      if (timer) clearInterval(timer);
    };
  }, []);

  return { head, connected, direct };
}
