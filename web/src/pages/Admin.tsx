import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import type { AppContext } from '../App';
import { useApi, type Stats } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useWallet } from '../lib/wallet';
import { useTx } from '../lib/useTx';
import { Card, Field, Notice, TxFeedback } from '../components/ui';
import { percent } from '../lib/format';

export function AdminPage({ ctx }: { ctx: AppContext }) {
  const { t } = useI18n();
  const { address, publicClient } = useWallet();
  const tx = useTx();
  const { data: stats } = useApi<Stats>('/api/stats');
  const market = ctx.config.contracts.marketplace as Address;

  const [owner, setOwner] = useState<string | null>(null);
  const [cap, setCap] = useState<bigint | null>(null);
  const [fee, setFee] = useState(String(ctx.config.feeBps));
  const [recipient, setRecipient] = useState(ctx.config.feeRecipient);

  useEffect(() => {
    Promise.all([
      publicClient.readContract({ address: market, abi: ctx.abis.Marketplace, functionName: 'owner' }),
      publicClient.readContract({ address: market, abi: ctx.abis.Marketplace, functionName: 'MAX_FEE_BPS' }),
    ]).then(([o, c]) => { setOwner(String(o)); setCap(c as bigint); });
  }, [ctx, market, publicClient]);

  const isOwner = Boolean(address && owner && address.toLowerCase() === owner.toLowerCase());

  return (
    <>
      <h1>{t('admin.title')}</h1>
      {!isOwner && <Notice kind="info">{t('admin.notOwner')}</Notice>}
      {ctx.config.paused && <Notice kind="warn">{t('admin.pausedNotice')}</Notice>}

      <div className="grid-2">
        <Card title={t('admin.fee')}>
          <Field
            label={t('admin.fee')}
            id="a-fee"
            hint={cap !== null ? t('admin.feeCap', { v: percent(Number(cap)) }) : undefined}
          >
            <input id="a-fee" inputMode="numeric" value={fee} disabled={!isOwner}
              onChange={(e) => setFee(e.target.value)} />
          </Field>
          <Field label={t('admin.feeRecipient')} id="a-rec">
            <input id="a-rec" value={recipient} disabled={!isOwner}
              onChange={(e) => setRecipient(e.target.value)} />
          </Field>
          <TxFeedback status={tx.status} error={tx.error} hash={tx.hash} />
          <div className="row">
            <button
              type="button"
              disabled={!isOwner || tx.busy}
              onClick={() => tx.send({
                address: market, abi: ctx.abis.Marketplace, functionName: 'setFee',
                args: [BigInt(fee || 0), recipient as Address],
              })}
            >
              {t('admin.save')}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!isOwner || tx.busy}
              onClick={() => tx.send({
                address: market, abi: ctx.abis.Marketplace, functionName: 'setPaused',
                args: [!ctx.config.paused],
              })}
            >
              {ctx.config.paused ? t('admin.resume') : t('admin.pause')}
            </button>
          </div>
        </Card>

        <Card title={t('admin.metrics')}>
          <dl className="preview">
            <dt>{t('admin.activeListings')}</dt><dd>{stats?.activeListings ?? '—'}</dd>
            <dt>{t('admin.sales')}</dt><dd>{stats?.totals.sales ?? 0}</dd>
            <dt>{t('admin.volume')}</dt>
            <dd>{formatTotals(stats?.totals.volumeByAsset)}</dd>
            <dt>{t('admin.fees')}</dt>
            <dd>{formatTotals(stats?.totals.feesByAsset)}</dd>
          </dl>
        </Card>
      </div>
    </>
  );
}

function formatTotals(totals?: Record<string, string>): string {
  if (!totals || Object.keys(totals).length === 0) return '—';
  const decimals: Record<string, number> = { USDC: 6, USDT: 6, DAI: 18, GHO: 18, EURS: 2 };
  return Object.entries(totals)
    .map(([symbol, value]) => {
      const d = decimals[symbol] ?? 18;
      return `${(Number(BigInt(value)) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${symbol}`;
    })
    .join(' · ');
}
