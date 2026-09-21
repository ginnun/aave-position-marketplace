import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import type { AppContext } from '../App';
import { useApi, type Listing } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useWallet } from '../lib/wallet';
import { useTx } from '../lib/useTx';
import { ERC20_ABI, MAX_UINT } from '../lib/contracts';
import { RiskBar } from '../components/RiskBar';
import { Card, Empty, Field, Modal, Notice, StatusTag, TxFeedback } from '../components/ui';
import {
  amount, countdown, healthFactor, healthFactorText, money, parseAmount, percent,
  shortAddress, usd,
} from '../lib/format';
import { decimalsFor } from './Market';

export function ListingPage({ tokenId, ctx }: { tokenId: string; ctx: AppContext }) {
  const { t, lang } = useI18n();
  const { data, error, reload } = useApi<Listing>(`/api/listings/${tokenId}`);
  const [buying, setBuying] = useState(false);
  const [bought, setBought] = useState(false);
  const { address } = useWallet();

  // A purchase makes this listing disappear. Keep the last view and report the sale
  // instead of dropping the reader onto an empty page.
  if (error && !data) return <Empty>{error}</Empty>;
  if (!data) return <p className="muted">{t('common.loading')}…</p>;

  const position = data.position;
  const decimals = decimalsFor(data);
  const isSeller = address?.toLowerCase() === data.seller.toLowerCase();
  const notAllowed = data.isPrivate && address && data.allowedBuyer?.toLowerCase() !== address.toLowerCase();

  return (
    <>
      <div className="row">
        <a href="#/market" className="small muted">← {t('common.back')}</a>
      </div>
      {bought && (
        <Notice kind="ok">
          {t('tx.success')} · <a href={`#/position/${tokenId}`}>{t('common.position')} #{tokenId}</a>
        </Notice>
      )}
      <div className="spread">
        <h1>{t('listing.title', { id: tokenId })}</h1>
        <div className="row">
          <StatusTag status={data.status} />
          {data.quickSale && <span className="tag tag--quick">{t('market.quickSale')}</span>}
          {data.isPrivate && <span className="tag tag--private">{t('market.private')}</span>}
        </div>
      </div>

      <div className="grid-2">
        <Card title={t('common.price')}>
          <div className="big">{data.currentPrice ? money(data.currentPrice, decimals, data.paymentSymbol) : '—'}</div>
          <p className="small muted" style={{ marginTop: 6 }}>
            {data.dynamic ? t('listing.dynamic', { r: (data.rateBps / 100).toFixed(1) }) : t('listing.fixed')}
            {data.premiumBps !== null && (
              <> · <span className={data.premiumBps < 0 ? 'pos' : 'neg'}>
                {data.premiumBps < 0 ? t('market.discount') : t('market.premium')} {percent(Math.abs(data.premiumBps))}
              </span></>
            )}
          </p>
          <dl className="preview" style={{ marginTop: 12 }}>
            <dt>{t('common.seller')}</dt><dd>{shortAddress(data.seller)}</dd>
            <dt>{t('common.expires')}</dt><dd>{countdown(data.secondsLeft, lang)}</dd>
            <dt>{t('listing.minHf')}</dt><dd>{healthFactorText(data.minHealthFactor)}</dd>
            <dt>{t('common.fee')}</dt><dd>{percent(ctx.config.feeBps)}</dd>
            {data.isPrivate && <><dt>{t('list.buyer')}</dt><dd>{shortAddress(data.allowedBuyer)}</dd></>}
          </dl>

          <div style={{ marginTop: 14 }}>
            {isSeller && <Notice kind="info">{t('buy.selfPurchase')}</Notice>}
            {notAllowed && <Notice kind="warn">{t('buy.notAllowed')}</Notice>}
            {!isSeller && !notAllowed && (
              <button
                type="button"
                disabled={!address || data.status !== 'active'}
                onClick={() => setBuying(true)}
              >
                {t('listing.buy')}
              </button>
            )}
            {data.status === 'invalid' && (
              <p className="small muted" style={{ marginTop: 8 }}>{t('status.invalid')}: {t('listing.minHf')} {healthFactorText(data.minHealthFactor)}</p>
            )}
          </div>
        </Card>

        <Card title={t('common.position')}>
          {position && <PositionDetail position={position} />}
        </Card>
      </div>

      {buying && position && (
        <BuyDialog
          listing={data}
          ctx={ctx}
          onBought={() => setBought(true)}
          onClose={() => { setBuying(false); reload(); }}
        />
      )}
    </>
  );
}

export function PositionDetail({ position }: { position: NonNullable<Listing['position']> }) {
  const { t } = useI18n();
  if (position.unavailable) return <Notice kind="warn">{t('common.unavailable')}</Notice>;
  const hf = healthFactor(position.healthFactor);
  const singleCollateral = position.collateral.length === 1 ? position.collateral[0] : null;

  return (
    <>
      <RiskBar
        totalCollateralBase={position.totalCollateralBase}
        totalDebtBase={position.totalDebtBase}
        liquidationThreshold={position.liquidationThreshold}
        healthFactor={position.healthFactor}
      />
      <div className="spread" style={{ marginTop: 14 }}>
        <div>
          <div className="small muted">{t('common.netValue')}</div>
          <div className="big">{usd(position.netValueBase)}</div>
        </div>
        <div className="right">
          <div className="small muted">{t('common.healthFactor')}</div>
          <div className="big">{healthFactorText(position.healthFactor)}</div>
        </div>
      </div>

      <div className="scroll-x" style={{ marginTop: 14 }}>
        <table className="table">
          <thead>
            <tr><th>{t('common.collateral')}</th><th className="right">{t('common.amount')}</th></tr>
          </thead>
          <tbody>
            {position.collateral.map((c) => (
              <tr key={c.aToken ?? c.symbol}>
                <td>{c.symbol}</td>
                <td className="right num">{amount(c.amount, c.decimals)}</td>
              </tr>
            ))}
            {position.debt.length > 0 && (
              <tr><th>{t('common.debt')}</th><th className="right">{t('common.amount')}</th></tr>
            )}
            {position.debt.map((d) => (
              <tr key={d.address ?? d.symbol}>
                <td style={{ color: 'var(--debt)' }}>{d.symbol}</td>
                <td className="right num" style={{ color: 'var(--debt)' }}>{amount(d.amount, d.decimals)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="preview" style={{ marginTop: 12 }}>
        <dt>{t('common.ltv')}</dt><dd>{percent(position.ltv)}</dd>
        <dt>{t('common.threshold')}</dt><dd>{percent(position.liquidationThreshold)}</dd>
        <dt>{t('common.emode')}</dt><dd>{position.eModeCategory === 0 ? t('common.none') : position.eModeCategory}</dd>
        {singleCollateral && hf !== null && hf < 100 && (
          <>
            <dt>{t('listing.liquidationPrice')} ({singleCollateral.symbol})</dt>
            <dd>{estimateLiquidationPrice(position, singleCollateral)}</dd>
          </>
        )}
      </dl>
    </>
  );
}

/**
 * The price at which this position reaches a health factor of 1, for a position whose collateral
 * is a single asset.
 *
 * Solving `collateral * price * threshold = debt` is only that simple when the debt does not move
 * with the same price. If the position also owes the collateral asset, both sides move together:
 *
 *   price * (units * threshold - owedInSameAsset) = debtInOtherAssets
 *
 * When the left bracket is zero or negative the position never reaches a health factor of 1 from
 * this price alone, and any number shown would be a fiction.
 */
function estimateLiquidationPrice(
  position: NonNullable<Listing['position']>,
  collateral: { symbol: string; amount: string; decimals: number },
): string {
  const units = Number(BigInt(collateral.amount)) / 10 ** collateral.decimals;
  if (units === 0) return '—';

  const priceNow = Number(BigInt(position.totalCollateralBase)) / 1e8 / units;
  if (!Number.isFinite(priceNow) || priceNow <= 0) return '—';

  const threshold = position.liquidationThreshold / 10_000;
  const sameAsset = position.debt.find((d) => d.symbol === collateral.symbol);
  const owedSame = sameAsset
    ? Number(BigInt(sameAsset.amount)) / 10 ** sameAsset.decimals
    : 0;

  const totalDebt = Number(BigInt(position.totalDebtBase)) / 1e8;
  const debtOther = totalDebt - owedSame * priceNow;

  const slope = units * threshold - owedSame;
  if (slope <= 0 || debtOther <= 0) return '—';

  const liquidationPrice = debtOther / slope;
  return `$${liquidationPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------- buy dialog

function BuyDialog(
  { listing, ctx, onBought, onClose }:
  { listing: Listing; ctx: AppContext; onBought: () => void; onClose: () => void },
) {
  const { t } = useI18n();
  const { address, publicClient } = useWallet();
  const tx = useTx();
  const decimals = decimalsFor(listing);

  const [fresh, setFresh] = useState<{ price: bigint; net: bigint; debt: bigint; hf: bigint } | null>(null);
  const [changed, setChanged] = useState(false);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [bought, setBought] = useState(false);
  const [limits, setLimits] = useState({ maxPrice: '', minNetValue: '', maxDebt: '', minHf: '', minutes: '20' });
  const [reading, setReading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);

  const marketAddress = ctx.config.contracts.marketplace as Address;
  const managerAddress = ctx.config.contracts.positionManager as Address;
  const { tokenId, paymentAsset, currentPrice: listedPrice } = listing;

  /** US-21: read the chain again right before buying, and say so when it moved. */
  const refresh = useCallback(async () => {
    setReading(true);
    setReadError(null);
    try {
      const [price, accountData] = await Promise.all([
        publicClient.readContract({
          address: marketAddress,
          abi: ctx.abis.Marketplace,
          functionName: 'currentPrice',
          args: [BigInt(tokenId)],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: managerAddress,
          abi: ctx.abis.PositionManager,
          functionName: 'accountData',
          args: [BigInt(tokenId)],
        }) as Promise<readonly bigint[]>,
      ]);
      const [collateral, debt, , , , hf] = accountData;
      const net = collateral > debt ? collateral - debt : 0n;
      const before = BigInt(listedPrice ?? 0);
      setChanged(before !== 0n && price !== before);
      setFresh({ price, net, debt, hf });
      setLimits((current) => current.maxPrice === '' ? {
        ...current,
        // One percent of slack, so ordinary drift does not cancel the purchase.
        maxPrice: formatUnitsPlain((price * 101n) / 100n, decimals),
        minNetValue: formatUnitsPlain((net * 99n) / 100n, 8),
        maxDebt: formatUnitsPlain((debt * 101n) / 100n, 8),
        minHf: healthFactorFloor(hf),
      } : current);
    } catch (err) {
      // Without this the rejection went nowhere, `fresh` stayed null, the limits stayed empty
      // (so maxPrice read as zero) and the confirm button still went live against the price the
      // server last reported. Buying on a price nobody re-read is the whole thing US-21 exists
      // to prevent.
      setFresh(null);
      setReadError(err instanceof Error ? err.message : String(err));
    } finally {
      setReading(false);
    }
    // ctx.abis never changes after the first load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketAddress, managerAddress, tokenId, listedPrice, publicClient, decimals]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!address) return;
    let live = true;
    publicClient.readContract({
      address: paymentAsset as Address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [address, marketAddress],
    })
      // A failed read must not leave the dialog waiting. Falling back to "approval
      // needed" costs one transaction at worst.
      .then((v) => { if (live) setAllowance(v as bigint); })
      .catch(() => { if (live) setAllowance(0n); });
    return () => { live = false; };
  }, [address, paymentAsset, marketAddress, publicClient, tx.status]);

  const price = fresh?.price ?? BigInt(listing.currentPrice ?? 0);
  const fee = (price * BigInt(ctx.config.feeBps)) / 10_000n;
  // Until the allowance is read, neither button is correct, so neither is offered.
  const allowanceKnown = allowance !== null;
  const needsApproval = allowanceKnown && allowance < price;

  /** The contract compares the deadline against the block timestamp, which a
   *  development chain can move, so it is read rather than taken from this browser. */
  async function buyArgs() {
    const now = (await publicClient.getBlock()).timestamp;
    return [
      BigInt(tokenId),
      {
        // Names the asset the buyer agreed to pay in, so a listing switched to another token
        // the buyer happens to have approved cannot be settled against these limits.
        paymentAsset: paymentAsset as Address,
        maxPrice: parseAmount(limits.maxPrice || '0', decimals),
        minNetValueBase: parseAmount(limits.minNetValue || '0', 8),
        maxDebtBase: parseAmount(limits.maxDebt || '0', 8),
        minHealthFactor: parseAmount(limits.minHf || '0', 18),
        deadline: now + BigInt(Number(limits.minutes || 20) * 60),
      },
    ] as const;
  }

  return (
    <Modal title={t('buy.title')} onClose={onClose}>
      <div className="stack">
        {changed && <Notice kind="warn">{t('listing.staleWarning')}</Notice>}

        <div className="preview">
          <dl>
            <dt>{t('common.price')}</dt><dd>{money(price, decimals, listing.paymentSymbol)}</dd>
            <dt>{t('common.fee')} ({percent(ctx.config.feeBps)})</dt>
            <dd>{money(fee, decimals, listing.paymentSymbol)}</dd>
            <dt><strong>{t('common.total')}</strong></dt>
            <dd><strong>{money(price, decimals, listing.paymentSymbol)}</strong></dd>
          </dl>
          <p className="tiny faint" style={{ margin: '8px 0 0' }}>
            {t('buy.toSeller')}: {money(price - fee, decimals, listing.paymentSymbol)}
          </p>
        </div>

        {listing.position && (
          <fieldset>
            <legend>{t('buy.receives')}</legend>
            <dl className="preview" style={{ border: 0, background: 'transparent', padding: 0 }}>
              <dt>{t('common.collateral')}</dt>
              <dd>{listing.position.collateral.map((c) => `${amount(c.amount, c.decimals)} ${c.symbol}`).join(', ')}</dd>
              <dt>{t('common.debt')}</dt>
              <dd>{listing.position.debt.map((d) => `${amount(d.amount, d.decimals)} ${d.symbol}`).join(', ') || t('common.none')}</dd>
              <dt>{t('common.netValue')}</dt><dd>{usd(fresh?.net ?? listing.position.netValueBase)}</dd>
              <dt>{t('common.healthFactor')}</dt><dd>{healthFactorText(fresh?.hf ?? listing.position.healthFactor)}</dd>
            </dl>
          </fieldset>
        )}

        <fieldset>
          <legend>{t('buy.limits')}</legend>
          <p className="tiny faint" style={{ marginTop: 0 }}>{t('buy.limitsHint')}</p>
          <div className="grid-2">
            <Field label={`${t('buy.maxPrice')} (${listing.paymentSymbol})`} id="l-price">
              <input id="l-price" inputMode="decimal" value={limits.maxPrice}
                onChange={(e) => setLimits({ ...limits, maxPrice: e.target.value })} />
            </Field>
            <Field label={`${t('buy.minNetValue')} (USD)`} id="l-net">
              <input id="l-net" inputMode="decimal" value={limits.minNetValue}
                onChange={(e) => setLimits({ ...limits, minNetValue: e.target.value })} />
            </Field>
            <Field label={`${t('buy.maxDebt')} (USD)`} id="l-debt">
              <input id="l-debt" inputMode="decimal" value={limits.maxDebt}
                onChange={(e) => setLimits({ ...limits, maxDebt: e.target.value })} />
            </Field>
            <Field label={t('buy.minHf')} id="l-hf">
              <input id="l-hf" inputMode="decimal" value={limits.minHf}
                onChange={(e) => setLimits({ ...limits, minHf: e.target.value })} />
            </Field>
            <Field label={t('buy.deadline')} id="l-min">
              <input id="l-min" inputMode="numeric" value={limits.minutes}
                onChange={(e) => setLimits({ ...limits, minutes: e.target.value })} />
            </Field>
          </div>
        </fieldset>

        {readError && (
          <Notice kind="error">
            {t('buy.readFailed')}
            <div className="tiny faint">{readError}</div>
          </Notice>
        )}

        <TxFeedback status={tx.status} error={tx.error} hash={tx.hash} />

        {tx.status === 'success' && bought ? (
          <a className="button" href={`#/position/${listing.tokenId}`}>
            {t('common.position')} #{listing.tokenId}
          </a>
        ) : (
        <div className="row">
          {!allowanceKnown ? (
            <button type="button" disabled>{t('common.loading')}…</button>
          ) : needsApproval ? (
            <button
              type="button"
              disabled={tx.busy}
              onClick={() => tx.send({
                address: paymentAsset as Address,
                abi: ERC20_ABI,
                functionName: 'approve',
                args: [marketAddress, MAX_UINT],
              })}
            >
              {t('common.approve')} {listing.paymentSymbol}
            </button>
          ) : (
            <button
              type="button"
              disabled={tx.busy || reading || fresh === null}
              onClick={async () => {
                const ok = await tx.send({
                  address: marketAddress,
                  abi: ctx.abis.Marketplace,
                  functionName: 'buy',
                  args: await buyArgs(),
                });
                if (ok) { setBought(true); onBought(); }
              }}
            >
              {t('buy.confirm')}
            </button>
          )}
          <button type="button" className="ghost" onClick={refresh} disabled={reading}>
            {t('common.retry')}
          </button>
        </div>
        )}
      </div>
    </Modal>
  );
}

/** A floor one percent under the current health factor, rounded down. Rounding the
 *  current value to two decimals can round it up, which would refuse the purchase. */
function healthFactorFloor(hf: bigint): string {
  const value = healthFactor(hf);
  if (value === null) return '0'; // no debt, so Aave reports the maximum value
  return (Math.floor(value * 0.99 * 100) / 100).toFixed(2);
}

function formatUnitsPlain(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const whole = v / 10n ** BigInt(decimals);
  const frac = (v % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
