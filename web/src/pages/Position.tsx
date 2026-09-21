import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import type { AppContext } from '../App';
import { useApi, type Position, type ServerAsset } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useWallet } from '../lib/wallet';
import { useTx } from '../lib/useTx';
import { DEBT_TOKEN_ABI, ERC20_ABI, MAX_UINT, ZERO_ADDRESS } from '../lib/contracts';
import { Card, Empty, Field, Notice, TxFeedback } from '../components/ui';
import {
  amount, countdown, healthFactorText, money, parseAmount, percent, usd,
} from '../lib/format';
import { PositionDetail } from './Listing';

type Action = 'supply' | 'withdraw' | 'borrow' | 'repay';

export function PositionPage({ tokenId, ctx }: { tokenId: string; ctx: AppContext }) {
  const { t, lang } = useI18n();
  const { address } = useWallet();
  const { data, error, reload } = useApi<Position>(`/api/positions/${tokenId}`);
  // An action can remove the form that ran it, so the result is reported here instead.
  const [done, setDone] = useState(false);
  const finished = () => { setDone(true); reload(); };

  // Carrying a position out removes it. Keep the last view so the result stays readable.
  if (error && !data) return <Empty>{error}</Empty>;
  if (!data) return <p className="muted">{t('common.loading')}…</p>;

  const listing = data.listing ?? null;
  const listed = listing !== null;
  // While listed the marketplace owns the token and the seller keeps control.
  const controller = listed ? listing.seller : data.owner;
  const isController = address?.toLowerCase() === controller.toLowerCase();

  return (
    <>
      <div className="row"><a href="#/positions" className="small muted">← {t('common.back')}</a></div>
      {done && <Notice kind="ok">{t('tx.success')}</Notice>}
      <div className="spread">
        <h1>{t('manage.title', { id: tokenId })}</h1>
        {listed && <span className="tag tag--active">{t('positions.listed')}</span>}
      </div>

      <div className="grid-2">
        <Card title={t('common.position')}>
          <PositionDetail position={data as never} />
        </Card>

        <div>
          {listed && listing && (
            <Card title={t('list.title')} aside={<span className="tag">{listing.status}</span>}>
              <dl className="preview">
                <dt>{t('common.price')}</dt>
                <dd>{listing.currentPrice ? money(listing.currentPrice, paymentDecimals(ctx, listing.paymentAsset), listing.paymentSymbol) : '—'}</dd>
                <dt>{t('common.expires')}</dt><dd>{countdown(listing.secondsLeft, lang)}</dd>
                <dt>{t('listing.minHf')}</dt><dd>{healthFactorText(listing.minHealthFactor)}</dd>
              </dl>
              {isController && <CancelListing tokenId={tokenId} ctx={ctx} onDone={finished} />}
              <p className="small muted" style={{ marginTop: 10 }}>{t('positions.listedNote')}</p>
            </Card>
          )}

          {!listed && isController && (
            <ListForm position={data} ctx={ctx} onDone={finished} />
          )}

          {isController && <ManageForm position={data} ctx={ctx} listed={listed} onDone={finished} />}
          {!listed && isController && <MigrateOut position={data} ctx={ctx} onDone={finished} />}
          {!isController && <Notice kind="info">{t('manage.blockedWhileListed')}</Notice>}
        </div>
      </div>
    </>
  );
}

function paymentDecimals(ctx: AppContext, address: string): number {
  return ctx.config.assets.find((a) => a.address.toLowerCase() === address.toLowerCase())?.decimals ?? 18;
}

// ---------------------------------------------------------------- manage

function ManageForm({
  position, ctx, listed, onDone,
}: { position: Position; ctx: AppContext; listed: boolean; onDone: () => void }) {
  const { t } = useI18n();
  const { address, publicClient } = useWallet();
  const tx = useTx();
  const [action, setAction] = useState<Action>('supply');
  const [symbol, setSymbol] = useState(ctx.config.assets[0].symbol);
  const [value, setValue] = useState('');
  const [allowance, setAllowance] = useState<bigint | null>(null);

  const choices = ctx.config.assets.filter((a) => action !== 'borrow' || a.borrowable);

  // Switching action can remove the selected asset from the list. The dropdown then shows
  // something else while the state still points at the old one, and the transaction goes to
  // a reserve the person never picked.
  useEffect(() => {
    if (!choices.some((a) => a.symbol === symbol)) setSymbol(choices[0].symbol);
    // choices is derived from action, which is the thing that changes here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action]);

  const asset = choices.find((a) => a.symbol === symbol) ?? choices[0];
  const parsed = parseAmount(value, asset.decimals);
  const needsAllowance = action === 'supply' || action === 'repay';
  const blocked = listed && (action === 'withdraw' || action === 'borrow');

  const managerAddress = ctx.config.contracts.positionManager as Address;

  useEffect(() => {
    if (!address || !needsAllowance) { setAllowance(null); return; }
    let live = true;
    publicClient.readContract({
      address: asset.address as Address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [address, managerAddress],
    })
      // A failed read must not leave the form waiting. Asking for an approval that
      // turns out to be unnecessary costs one transaction and nothing else.
      .then((v) => { if (live) setAllowance(v as bigint); })
      .catch(() => { if (live) setAllowance(0n); });
    return () => { live = false; };
  }, [address, asset.address, managerAddress, publicClient, needsAllowance, tx.status]);

  const after = previewHealthFactor(position, ctx, asset, action, parsed);
  const allowanceKnown = !needsAllowance || allowance !== null;
  const mustApprove = needsAllowance && allowance !== null && allowance < parsed && parsed > 0n;

  return (
    <Card title={t('positions.manage')}>
      <div className="row" style={{ marginBottom: 12 }}>
        {(['supply', 'repay', 'withdraw', 'borrow'] as Action[]).map((a) => (
          <button
            key={a}
            type="button"
            className={action === a ? 'small' : 'ghost small'}
            onClick={() => { setAction(a); tx.reset(); }}
          >
            {t(`manage.${a}` as never)}
          </button>
        ))}
      </div>

      {blocked && <Notice kind="warn">{t('manage.blockedWhileListed')}</Notice>}

      <div className="grid-2">
        <Field label={t('common.asset')} id="m-asset">
          <select id="m-asset" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {choices.map((a) => <option key={a.symbol} value={a.symbol}>{a.symbol}</option>)}
          </select>
        </Field>
        <Field label={t('common.amount')} id="m-amount">
          <input id="m-amount" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0.0" />
        </Field>
      </div>

      {parsed > 0n && after !== null && (
        <div className="preview">
          <dl>
            <dt>{t('manage.afterHf')}</dt>
            <dd className={after < 1 ? 'neg' : ''}>{after > 100 ? '∞' : after.toFixed(2)}</dd>
          </dl>
        </div>
      )}

      <TxFeedback status={tx.status} error={tx.error} hash={tx.hash} />

      <div className="row" style={{ marginTop: 12 }}>
        {mustApprove ? (
          <button
            type="button"
            disabled={tx.busy}
            onClick={() => tx.send({
              address: asset.address as Address,
              abi: ERC20_ABI,
              functionName: 'approve',
              args: [managerAddress, MAX_UINT],
            })}
          >
            {t('common.approve')} {asset.symbol}
          </button>
        ) : (
          <button
            type="button"
            disabled={tx.busy || blocked || parsed === 0n || !allowanceKnown}
            onClick={async () => {
              const args = action === 'withdraw' || action === 'borrow'
                ? [BigInt(position.tokenId), asset.address as Address, parsed, address as Address]
                : [BigInt(position.tokenId), asset.address as Address, parsed];
              const ok = await tx.send({
                address: managerAddress,
                abi: ctx.abis.PositionManager,
                functionName: action,
                args,
              });
              if (ok) { setValue(''); onDone(); }
            }}
          >
            {t(`manage.${action}` as never)}
          </button>
        )}
      </div>
    </Card>
  );
}

/**
 * Health factor the position would have after this action, from current oracle prices.
 *
 * Aave weights each reserve by its own liquidation threshold, so the position's blended figure
 * does not apply to an asset being added or removed. Adding LINK to a WETH position with the
 * blended number would promise a healthier result than Aave will give.
 */
function previewHealthFactor(
  position: Position,
  ctx: AppContext,
  asset: ServerAsset,
  action: Action,
  units: bigint,
): number | null {
  const price = ctx.config.prices[asset.symbol];
  if (!price) return null;
  const deltaBase = (units * BigInt(price)) / 10n ** BigInt(asset.decimals);

  // Work in liquidation weighted collateral, which is what the health factor divides by debt.
  let weighted = (BigInt(position.totalCollateralBase) * BigInt(position.liquidationThreshold))
    / 10_000n;
  let debt = BigInt(position.totalDebtBase);
  const assetWeight = (deltaBase * BigInt(asset.liquidationThreshold)) / 10_000n;

  if (action === 'supply') weighted += assetWeight;
  if (action === 'withdraw') weighted = weighted > assetWeight ? weighted - assetWeight : 0n;
  if (action === 'borrow') debt += deltaBase;
  if (action === 'repay') debt = debt > deltaBase ? debt - deltaBase : 0n;

  if (debt === 0n) return Number.POSITIVE_INFINITY;
  return Number(weighted) / Number(debt);
}

// ---------------------------------------------------------------- listing

function ListForm({ position, ctx, onDone }: { position: Position; ctx: AppContext; onDone: () => void }) {
  const { t } = useI18n();
  const { address, publicClient } = useWallet();
  const tx = useTx();
  const payable = ctx.config.assets.filter((a) => ['USDC', 'USDT', 'DAI'].includes(a.symbol));

  const [dynamic, setDynamic] = useState(false);
  const [price, setPrice] = useState('');
  const [rate, setRate] = useState('95');
  const [minPrice, setMinPrice] = useState('');
  const [payment, setPayment] = useState(payable[0]?.symbol ?? 'USDC');
  const [days, setDays] = useState('7');
  const [minHf, setMinHf] = useState('1.10');
  const [privateBuyer, setPrivateBuyer] = useState('');
  const [quick, setQuick] = useState(false);
  const [approved, setApproved] = useState<boolean | null>(null);

  const asset = payable.find((a) => a.symbol === payment)!;
  const market = ctx.config.contracts.marketplace as Address;

  const managerAddress = ctx.config.contracts.positionManager as Address;

  useEffect(() => {
    if (!address) return;
    let live = true;
    publicClient.readContract({
      address: managerAddress,
      abi: ctx.abis.PositionManager,
      functionName: 'isApprovedForAll',
      args: [address, market],
    })
      .then((v) => { if (live) setApproved(Boolean(v)); })
      .catch(() => { if (live) setApproved(false); });
    return () => { live = false; };
    // ctx.abis never changes after the first load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, managerAddress, market, publicClient, tx.status]);

  const netUsd = Number(BigInt(position.netValueBase)) / 1e8;
  const askUsd = dynamic
    ? netUsd * (Number(rate) / 100)
    : Number(price || 0) * (Number(ctx.config.prices[payment] ?? 1e8) / 1e8);
  const discountBps = netUsd > 0 ? ((askUsd - netUsd) / netUsd) * 10_000 : null;

  return (
    <Card title={t('list.title')}>
      <div className="row" style={{ marginBottom: 12 }}>
        <button type="button" className={dynamic ? 'ghost small' : 'small'} onClick={() => setDynamic(false)}>
          {t('list.fixed')}
        </button>
        <button type="button" className={dynamic ? 'small' : 'ghost small'} onClick={() => setDynamic(true)}>
          {t('list.dynamic')}
        </button>
      </div>

      <div className="grid-2">
        {dynamic ? (
          <>
            <Field label={t('list.rate')} id="l-rate">
              <input id="l-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
            </Field>
            <Field label={`${t('list.minPrice')} (${payment})`} id="l-floor">
              <input id="l-floor" inputMode="decimal" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} placeholder="0" />
            </Field>
          </>
        ) : (
          <Field label={`${t('common.price')} (${payment})`} id="l-fixed">
            <input id="l-fixed" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.0" />
          </Field>
        )}
        <Field label={t('list.paymentAsset')} id="l-pay">
          <select id="l-pay" value={payment} onChange={(e) => setPayment(e.target.value)}>
            {payable.map((a) => <option key={a.symbol} value={a.symbol}>{a.symbol}</option>)}
          </select>
        </Field>
        <Field label={t('list.duration')} id="l-days">
          <input id="l-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        </Field>
        <Field label={t('list.minHf')} id="l-minhf">
          <input id="l-minhf" inputMode="decimal" value={minHf} onChange={(e) => setMinHf(e.target.value)} />
        </Field>
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={quick} onChange={(e) => setQuick(e.target.checked)} />
        {t('list.quick')}
      </label>
      <Field label={t('list.private')} id="l-buyer">
        <input id="l-buyer" value={privateBuyer} onChange={(e) => setPrivateBuyer(e.target.value)} placeholder="0x…" />
      </Field>

      <div className="preview">
        <dl>
          <dt>{t('common.netValue')}</dt><dd>{usd(position.netValueBase)}</dd>
          <dt>{t('list.discountPreview', { v: discountBps === null ? '—' : `${discountBps < 0 ? '-' : '+'}${percent(Math.abs(discountBps))}` })}</dt>
          <dd>${askUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</dd>
          <dt>{t('common.fee')}</dt><dd>{percent(ctx.config.feeBps)}</dd>
        </dl>
      </div>

      <TxFeedback status={tx.status} error={tx.error} hash={tx.hash} />

      <div className="row" style={{ marginTop: 12 }}>
        {approved === null ? (
          <button type="button" disabled>{t('common.loading')}…</button>
        ) : approved === false ? (
          <button
            type="button"
            disabled={tx.busy}
            onClick={() => tx.send({
              address: managerAddress,
              abi: ctx.abis.PositionManager,
              functionName: 'setApprovalForAll',
              args: [market, true],
            })}
          >
            {t('list.approveNft')}
          </button>
        ) : (
          <button
            type="button"
            // The contract refuses a listing that names no price at all, so leaving the field
            // empty buys nothing but a failed transaction and its gas. Stop it here instead.
            disabled={tx.busy || (dynamic
              ? !(Math.round(Number(rate) * 100) > 0)
              : parseAmount(price, asset.decimals) <= 0n)}
            onClick={async () => {
              // The contract compares the end time against the block timestamp, which
              // a development chain can move. Read it rather than trust this browser.
              const now = (await publicClient.getBlock()).timestamp;
              const ok = await tx.send({
                address: market,
                abi: ctx.abis.Marketplace,
                functionName: 'list',
                args: [BigInt(position.tokenId), {
                  seller: ZERO_ADDRESS,
                  paymentAsset: asset.address as Address,
                  allowedBuyer: (privateBuyer.trim() || ZERO_ADDRESS) as Address,
                  fixedPrice: dynamic ? 0n : parseAmount(price, asset.decimals),
                  minPrice: dynamic ? parseAmount(minPrice || '0', asset.decimals) : 0n,
                  rateBps: dynamic ? Math.round(Number(rate) * 100) : 0,
                  expiry: now + BigInt(Number(days || 7) * 86400),
                  minHealthFactor: parseAmount(minHf, 18),
                  quickSale: quick,
                }],
              });
              if (ok) onDone();
            }}
          >
            {t('list.submit')}
          </button>
        )}
      </div>
    </Card>
  );
}

function CancelListing({ tokenId, ctx, onDone }: { tokenId: string; ctx: AppContext; onDone: () => void }) {
  const { t } = useI18n();
  const tx = useTx();
  return (
    <>
      <TxFeedback status={tx.status} error={tx.error} hash={tx.hash} />
      <button
        type="button"
        className="ghost"
        disabled={tx.busy}
        style={{ marginTop: 10 }}
        onClick={async () => {
          const ok = await tx.send({
            address: ctx.config.contracts.marketplace as Address,
            abi: ctx.abis.Marketplace,
            functionName: 'cancel',
            args: [BigInt(tokenId)],
          });
          if (ok) onDone();
        }}
      >
        {t('positions.cancel')}
      </button>
    </>
  );
}

// ---------------------------------------------------------------- migrate out

function MigrateOut({ position, ctx, onDone }: { position: Position; ctx: AppContext; onDone: () => void }) {
  const { t } = useI18n();
  const { address, publicClient } = useWallet();
  const tx = useTx();
  const [pending, setPending] = useState<string[] | null>(null);
  const manager = ctx.config.contracts.positionManager as Address;

  // A stable description of the debt, so this does not re-run on every poll.
  const debtKey = position.debt.map((d) => `${d.address}:${d.amount}`).join(',');

  useEffect(() => {
    if (!address) return;
    let live = true;
    Promise.all(position.debt.map(async (d) => {
      const asset = ctx.config.assets.find((a) => a.address.toLowerCase() === (d.address ?? '').toLowerCase());
      if (!asset) return null;
      const allowed = await publicClient.readContract({
        address: asset.variableDebtToken as Address,
        abi: DEBT_TOKEN_ABI,
        functionName: 'borrowAllowance',
        args: [address, manager],
      }) as bigint;
      return allowed < BigInt(d.amount) ? asset.symbol : null;
    }))
      .then((rows) => { if (live) setPending(rows.filter(Boolean) as string[]); })
      .catch(() => { if (live) setPending(position.debt.map((d) => d.symbol)); });
    return () => { live = false; };
    // debtKey stands in for position.debt, and ctx.assets never changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, debtKey, manager, publicClient, tx.status]);

  // A null list means the delegation check has not answered yet.
  const next = pending?.[0];
  const nextAsset = ctx.config.assets.find((a) => a.symbol === next);

  return (
    <Card title={t('migrate.out.title')}>
      <p className="small muted">{t('migrate.out.intro')}</p>
      {(pending?.length ?? 0) > 0 && <p className="small muted">{t('migrate.out.delegateHint')}</p>}
      <TxFeedback status={tx.status} error={tx.error} hash={tx.hash} />
      <div className="row" style={{ marginTop: 12 }}>
        {pending === null ? (
          <button type="button" disabled>{t('common.loading')}…</button>
        ) : nextAsset ? (
          <button
            type="button"
            disabled={tx.busy}
            onClick={() => tx.send({
              address: nextAsset.variableDebtToken as Address,
              abi: DEBT_TOKEN_ABI,
              functionName: 'approveDelegation',
              args: [manager, MAX_UINT],
            })}
          >
            {t('migrate.out.delegate', { s: nextAsset.symbol })}
          </button>
        ) : (
          <button
            type="button"
            disabled={tx.busy}
            onClick={async () => {
              const ok = await tx.send({
                address: manager,
                abi: ctx.abis.PositionManager,
                functionName: 'migrateOut',
                args: [BigInt(position.tokenId), address as Address],
              });
              if (ok) {
                onDone();
                setTimeout(() => { window.location.hash = '#/positions'; }, 1500);
              }
            }}
          >
            {t('positions.migrateOut')}
          </button>
        )}
      </div>
      {position.debt.length > 0 && (
        <p className="tiny faint" style={{ marginTop: 8 }}>
          {position.debt.map((d) => `${amount(d.amount, d.decimals)} ${d.symbol}`).join(', ')}
        </p>
      )}
    </Card>
  );
}
