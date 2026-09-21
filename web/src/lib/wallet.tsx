import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import {
  createPublicClient, createWalletClient, custom, http, type Address, type Chain,
  type PublicClient, type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/// The chain the test accounts below are allowed on. Anvil's id, and nothing else.
const LOCAL_CHAIN_ID = 31337;

/// The ten accounts anvil creates from the standard development mnemonic. These
/// keys are public knowledge and only ever used against a local chain.
const TEST_KEYS = [
  { label: 'Deployer', key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' },
  { label: 'Alice', key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' },
  { label: 'Bob', key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' },
  { label: 'Carol', key: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' },
] as const;

export type WalletKind = 'injected' | 'test';

type WalletState = {
  address: Address | null;
  kind: WalletKind | null;
  chainId: number | null;
  /// The chain this build talks to, as opposed to the one the wallet happens to be on.
  expectedChainId: number;
  label: string | null;
  connect: (kind: WalletKind, index?: number) => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
  walletClient: WalletClient | null;
  publicClient: PublicClient;
  testAccounts: typeof TEST_KEYS;
  hasInjected: boolean;
  chain: Chain;
  error: string | null;
};

const WalletContext = createContext<WalletState | null>(null);

function buildChain(chainId: number, rpcUrl: string): Chain {
  return {
    id: chainId,
    name: chainId === 11155111 ? 'Sepolia' : 'Local Aave fork',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: chainId === 11155111
      ? { default: { name: 'Etherscan', url: 'https://sepolia.etherscan.io' } }
      : undefined,
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  } as Chain;
}

export function WalletProvider(
  { chainId, rpcUrl, children }: { chainId: number; rpcUrl: string; children: ReactNode },
) {
  const chain = useMemo(() => buildChain(chainId, rpcUrl), [chainId, rpcUrl]);
  const publicClient = useMemo(
    () => createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient,
    [chain, rpcUrl],
  );

  const [address, setAddress] = useState<Address | null>(null);
  const [kind, setKind] = useState<WalletKind | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [walletClient, setWalletClient] = useState<WalletClient | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasInjected = typeof window !== 'undefined' && Boolean((window as any).ethereum);

  const connect = useCallback(async (which: WalletKind, index = 1) => {
    setError(null);
    try {
      if (which === 'test') {
        // These keys are printed in anvil's own startup banner, so anyone can spend from them.
        // On a public chain that makes every transfer into them a gift to the first watcher.
        if (chainId !== LOCAL_CHAIN_ID) {
          throw new Error('the test accounts only work on the local chain');
        }
        const entry = TEST_KEYS[index] ?? TEST_KEYS[1];
        const account = privateKeyToAccount(entry.key as `0x${string}`);
        const client = createWalletClient({ account, chain, transport: http(rpcUrl) });
        setWalletClient(client);
        setAddress(account.address);
        setWalletChainId(chainId);
        setKind('test');
        setLabel(entry.label);
        localStorage.setItem('wallet', JSON.stringify({ kind: 'test', index }));
        return;
      }

      const provider = (window as any).ethereum;
      if (!provider) throw new Error('no injected wallet');
      const accounts: Address[] = await provider.request({ method: 'eth_requestAccounts' });
      const hex: string = await provider.request({ method: 'eth_chainId' });
      const client = createWalletClient({ account: accounts[0], chain, transport: custom(provider) });
      setWalletClient(client);
      setAddress(accounts[0]);
      setWalletChainId(Number.parseInt(hex, 16));
      setKind('injected');
      setLabel(null);
      localStorage.setItem('wallet', JSON.stringify({ kind: 'injected' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [chain, chainId, rpcUrl]);

  const disconnect = useCallback(() => {
    setAddress(null);
    setKind(null);
    setLabel(null);
    setWalletClient(null);
    setWalletChainId(null);
    localStorage.removeItem('wallet');
  }, []);

  const switchChain = useCallback(async () => {
    const provider = (window as any).ethereum;
    if (!provider) return;
    const hexId = `0x${chainId.toString(16)}`;
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
    } catch (err: any) {
      // 4902 means the wallet does not know this chain yet.
      if (err?.code === 4902) {
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: hexId,
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: [rpcUrl],
          }],
        });
      } else {
        setError(err?.message ?? String(err));
      }
    }
  }, [chain, chainId, rpcUrl]);

  // Reconnect the way the person last chose.
  useEffect(() => {
    const saved = localStorage.getItem('wallet');
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved);
      if (parsed.kind === 'test') {
        // A build pointed at a public chain must not revive a test wallet saved by a local one.
        if (chainId !== LOCAL_CHAIN_ID) localStorage.removeItem('wallet');
        else connect('test', parsed.index ?? 1);
      }
      else if (parsed.kind === 'injected' && hasInjected) {
        (window as any).ethereum
          .request({ method: 'eth_accounts' })
          .then((accounts: Address[]) => { if (accounts.length > 0) connect('injected'); });
      }
    } catch { /* stored value is unusable, start disconnected */ }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (kind !== 'injected' || !hasInjected) return;
    const provider = (window as any).ethereum;
    const onAccounts = (accounts: Address[]) => {
      if (accounts.length === 0) disconnect();
      else setAddress(accounts[0]);
    };
    const onChain = (hex: string) => setWalletChainId(Number.parseInt(hex, 16));
    provider.on?.('accountsChanged', onAccounts);
    provider.on?.('chainChanged', onChain);
    return () => {
      provider.removeListener?.('accountsChanged', onAccounts);
      provider.removeListener?.('chainChanged', onChain);
    };
  }, [kind, hasInjected, disconnect]);

  const value = useMemo<WalletState>(() => ({
    address, kind, label, chainId: walletChainId, expectedChainId: chainId,
    connect, disconnect, switchChain,
    walletClient, publicClient, testAccounts: TEST_KEYS, hasInjected, chain, error,
  }), [address, kind, label, walletChainId, chainId, connect, disconnect, switchChain,
    walletClient, publicClient, hasInjected, chain, error]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet needs WalletProvider');
  return ctx;
}
