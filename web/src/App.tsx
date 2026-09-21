import { useEffect, useMemo, useState } from 'react';
import { useApi, useChainStream, type Config } from './lib/api';
import { useI18n } from './lib/i18n';
import { useRoute } from './lib/router';
import { WalletProvider, useWallet } from './lib/wallet';
import { WalletButton } from './components/WalletButton';
import { Notice } from './components/ui';
import { loadAbis, type Abis } from './lib/contracts';
import { MarketPage } from './pages/Market';
import { ListingPage } from './pages/Listing';
import { PositionsPage } from './pages/Positions';
import { PositionPage } from './pages/Position';
import { MigratePage } from './pages/Migrate';
import { HistoryPage } from './pages/History';
import { AdminPage } from './pages/Admin';

export type AppContext = { config: Config; abis: Abis };

/** The server does not hand out its own endpoint, so fall back to a public one. */
const PUBLIC_RPC: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  31337: 'http://127.0.0.1:8545',
};

function browserRpc(config: Config): string {
  return config.rpcUrl ?? PUBLIC_RPC[config.chainId] ?? 'http://127.0.0.1:8545';
}

const TABS = [
  { route: 'market', key: 'nav.market' },
  { route: 'positions', key: 'nav.positions' },
  { route: 'migrate', key: 'nav.migrate' },
  { route: 'history', key: 'nav.history' },
  { route: 'admin', key: 'nav.admin' },
] as const;

export function App() {
  const { t } = useI18n();
  const { data: config, error, reload } = useApi<Config>('/api/config');
  const [abis, setAbis] = useState<Abis | null>(null);

  useEffect(() => { loadAbis().then(setAbis); }, []);

  // Shell owns the only thing that asks for a reload, and the error screen replaces Shell, so
  // without this the page stays broken after the server comes back. A 503 while the indexer
  // catches up is the common case.
  useEffect(() => {
    if (config) return undefined;
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [config, reload]);

  // The configuration is re-read on every indexed block. Without this, every effect
  // that depends on the context would restart a few times a minute.
  const ctx = useMemo<AppContext | null>(
    () => (config && abis ? { config, abis } : null),
    [config, abis],
  );

  if (error && !config) {
    return (
      <div className="shell" style={{ paddingTop: 48 }}>
        <h1>{t('error.title')}</h1>
        <p className="muted">{t('error.serverDown')}</p>
        <p className="tiny faint">{error}</p>
        <button type="button" onClick={reload}>{t('common.retry')}</button>
      </div>
    );
  }
  if (!ctx) {
    return <div className="shell" style={{ paddingTop: 48 }}>{t('common.loading')}…</div>;
  }

  return (
    <WalletProvider chainId={ctx.config.chainId} rpcUrl={browserRpc(ctx.config)}>
      <Shell ctx={ctx} />
    </WalletProvider>
  );
}

function Shell({ ctx }: { ctx: AppContext }) {
  const { t, lang, setLang } = useI18n();
  const route = useRoute();
  const { connected } = useChainStream();
  const { address, chainId } = useWallet();
  const wrongNetwork = address !== null && chainId !== null && chainId !== ctx.config.chainId;

  return (
    <>
      <header className="topbar">
        <div className="shell topbar__row">
          <a className="brand" href="#/market">
            <span className="brand__mark" aria-hidden="true"><i /><i /></span>
            {t('app.name')}
          </a>
          <div className="lang" role="group" aria-label="Language">
            <button type="button" aria-pressed={lang === 'tr'} onClick={() => setLang('tr')}>TR</button>
            <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
          </div>
          <WalletButton expectedChainId={ctx.config.chainId} isLocal={ctx.config.isLocal} />
        </div>
        <nav className="shell nav" aria-label="Sections">
          {TABS.map((tab) => (
            <a
              key={tab.route}
              href={`#/${tab.route}`}
              aria-current={route.name === tab.route || (route.name === 'position' && tab.route === 'positions') || (route.name === 'listing' && tab.route === 'market') ? 'page' : undefined}
            >
              {t(tab.key)}
            </a>
          ))}
        </nav>
      </header>

      <main className="shell">
        <div className="stack">
          {ctx.config.paused && <Notice kind="warn">{t('admin.pausedNotice')}</Notice>}
          {wrongNetwork && <Notice kind="warn">{t('wallet.wrongNetwork')} · chain id {chainId}</Notice>}
          {!connected && <Notice kind="warn">{t('error.serverDown')}</Notice>}
          <Page route={route.name} param={route.param} ctx={ctx} />
        </div>
      </main>
    </>
  );
}

function Page({ route, param, ctx }: { route: string; param?: string; ctx: AppContext }) {
  switch (route) {
    case 'listing': return <ListingPage tokenId={param!} ctx={ctx} />;
    case 'positions': return <PositionsPage ctx={ctx} />;
    case 'position': return <PositionPage tokenId={param!} ctx={ctx} />;
    case 'migrate': return <MigratePage ctx={ctx} />;
    case 'history': return <HistoryPage />;
    case 'admin': return <AdminPage ctx={ctx} />;
    default: return <MarketPage ctx={ctx} />;
  }
}
