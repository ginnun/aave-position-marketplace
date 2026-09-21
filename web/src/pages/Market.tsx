import { useMemo, useState } from 'react';
import type { AppContext } from '../App';
import { useApi, type Listing } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { RiskBar } from '../components/RiskBar';
import { Card, Empty, Field, Notice, StatusTag } from '../components/ui';
import { countdown, healthFactorText, money, percent, shortAddress, usd } from '../lib/format';

type Rows = { total: number; items: Listing[]; blockNumber: string; indexedAt: number };

export function MarketPage({ ctx }: { ctx: AppContext }) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const [asset, setAsset] = useState('');
  const [minHf, setMinHf] = useState('');
  const [quickOnly, setQuickOnly] = useState(false);
  const [sort, setSort] = useState('expiry');

  const { data, error, loading } = useApi<Rows>('/api/listings', {
    status: showAll ? 'all' : 'active',
    asset: asset || undefined,
    // A half typed decimal such as "." is not a number yet. Leave the filter out until it is,
    // rather than letting BigInt throw while the person is still typing.
    minHealthFactor: Number.isFinite(Number(minHf)) && minHf.trim() !== ''
      ? String(BigInt(Math.round(Number(minHf) * 100)) * 10n ** 16n)
      : undefined,
    quickSale: quickOnly || undefined,
    sort,
    limit: 100,
  });

  const totalNet = useMemo(() => {
    if (!data) return 0n;
    return data.items.reduce((sum, l) => sum + BigInt(l.position?.netValueBase ?? 0), 0n);
  }, [data]);

  return (
    <>
      <div className="spread">
        <div>
          <h1>{t('market.title')}</h1>
          <p className="muted small" style={{ marginTop: 4 }}>
            {data ? t('market.summary', { n: data.total, v: usd(totalNet) }) : `${t('common.loading')}…`}
          </p>
        </div>
        {data && (
          <p className="tiny faint">
            {t('common.blockNumber')} {data.blockNumber} · {t('common.updated')}{' '}
            {new Date(data.indexedAt).toLocaleTimeString()}
          </p>
        )}
      </div>

      <Card title={t('market.filters')}>
        <div className="grid-2">
          <Field label={t('market.assetFilter')} id="f-asset">
            <select id="f-asset" value={asset} onChange={(e) => setAsset(e.target.value)}>
              <option value="">{t('common.none')}</option>
              {ctx.config.assets.map((a) => <option key={a.symbol} value={a.symbol}>{a.symbol}</option>)}
            </select>
          </Field>
          <Field label={t('market.hfRange')} id="f-hf">
            <input id="f-hf" inputMode="decimal" placeholder="1.00" value={minHf} onChange={(e) => setMinHf(e.target.value)} />
          </Field>
          <Field label={t('market.sort')} id="f-sort">
            <select id="f-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="expiry">{t('market.sort.expiry')}</option>
              <option value="premium">{t('market.sort.premium')}</option>
              <option value="netValue">{t('market.sort.netValue')}</option>
              <option value="healthFactor">{t('market.sort.healthFactor')}</option>
            </select>
          </Field>
          <div className="field" style={{ alignSelf: 'end' }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={quickOnly} onChange={(e) => setQuickOnly(e.target.checked)} />
              {t('market.quickOnly')}
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              {t('market.showInvalid')}
            </label>
          </div>
        </div>
      </Card>

      {error && <Notice kind="error">{error}</Notice>}
      {loading && !data && <p className="muted">{t('common.loading')}…</p>}
      {data && data.items.length === 0 && <Empty>{t('market.empty')}</Empty>}

      <div className="stack">
        {data?.items.map((listing) => <ListingCard key={listing.tokenId} listing={listing} />)}
      </div>
    </>
  );
}

export function ListingCard({ listing }: { listing: Listing }) {
  const { t, lang } = useI18n();
  const position = listing.position;
  const discount = listing.premiumBps;

  return (
    <a
      className="card"
      href={`#/listing/${listing.tokenId}`}
      style={{ display: 'block', textDecoration: 'none' }}
    >
      <div className="card__head">
        <h3>#{listing.tokenId}</h3>
        <StatusTag status={listing.status} />
        {listing.quickSale && <span className="tag tag--quick">{t('market.quickSale')}</span>}
        {listing.isPrivate && <span className="tag tag--private">{t('market.private')}</span>}
        <span className="tiny faint" style={{ marginLeft: 'auto' }}>
          {t('common.seller')} {shortAddress(listing.seller)}
        </span>
      </div>
      <div className="card__body">
        <div className="spread" style={{ alignItems: 'flex-end', marginBottom: 12 }}>
          <div>
            <div className="big">
              {listing.currentPrice
                ? money(listing.currentPrice, decimalsFor(listing), listing.paymentSymbol)
                : '—'}
            </div>
            <div className="small muted">
              {listing.dynamic
                ? t('listing.dynamic', { r: (listing.rateBps / 100).toFixed(1) })
                : t('listing.fixed')}
              {discount !== null && (
                <> · <span className={discount < 0 ? 'pos' : 'neg'}>
                  {discount < 0 ? t('market.discount') : t('market.premium')} {percent(Math.abs(discount))}
                </span></>
              )}
            </div>
          </div>
          <div className="right">
            <div className="small muted">{t('common.healthFactor')}</div>
            <div className="big">{position ? healthFactorText(position.healthFactor) : '—'}</div>
          </div>
        </div>

        {position && (
          <RiskBar
            totalCollateralBase={position.totalCollateralBase}
            totalDebtBase={position.totalDebtBase}
            liquidationThreshold={position.liquidationThreshold}
            healthFactor={position.healthFactor}
          />
        )}

        <div className="row small muted" style={{ marginTop: 12, gap: 16 }}>
          <span>
            {position?.collateral.map((c) => c.symbol).join(' + ') || '—'}
            {' → '}
            {position?.debt.map((d) => d.symbol).join(' + ') || t('common.none')}
          </span>
          <span style={{ marginLeft: 'auto' }}>
            {t('common.netValue')} <strong>{usd(position?.netValueBase)}</strong>
          </span>
          <span>{t('common.expires')} {countdown(listing.secondsLeft, lang)}</span>
        </div>
      </div>
    </a>
  );
}

/** Payment asset decimals, taken from the amount the server already formatted against. */
export function decimalsFor(listing: Listing): number {
  const known: Record<string, number> = { USDC: 6, USDT: 6, DAI: 18, EURS: 2, GHO: 18, WETH: 18, LINK: 18, WBTC: 8, AAVE: 18 };
  return known[listing.paymentSymbol] ?? 18;
}
