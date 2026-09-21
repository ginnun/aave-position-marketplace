import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import type { AppContext } from '../App';
import { useI18n } from '../lib/i18n';
import { useWallet } from '../lib/wallet';
import { useTx } from '../lib/useTx';
import { BLOCKERS, ERC20_ABI, FAUCET_ABI, MAX_UINT, POOL_ABI, WETH_ABI } from '../lib/contracts';
import { RiskBar } from '../components/RiskBar';
import { Card, Empty, Field, Notice, TxFeedback } from '../components/ui';
import { amount, healthFactorText, parseAmount, usd } from '../lib/format';

// One list, in contracts.ts. A second copy here went out of date the moment the enum grew.

type Scan = {
  aTokens: readonly Address[];
  aBalances: readonly bigint[];
  debtAssets: readonly Address[];
  debtAmounts: readonly bigint[];
};

export function MigratePage({ ctx }: { ctx: AppContext }) {
  const { t } = useI18n();
  const { address, publicClient } = useWallet();
  const tx = useTx();
  const manager = ctx.config.contracts.positionManager as Address;
  const poolAddress = ctx.config.contracts.pool as Address;

  const [scan, setScan] = useState<Scan | null>(null);
  const [account, setAccount] = useState<readonly bigint[] | null>(null);
  // 'Unknown' is not a contract value. It is what this page knows when the read failed, and it
  // has to block the button: treating a failed read as "nothing is in the way" invites a
  // migration the chain will refuse.
  const [blocker, setBlocker] = useState<string>('Unknown');
  const [needsApproval, setNeedsApproval] = useState<Address[] | null>(null);
  const [loading, setLoading] = useState(false);

  const read = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const [raw, data, blockerCode] = await Promise.all([
        publicClient.readContract({
          address: manager, abi: ctx.abis.PositionManager, functionName: 'scan', args: [address],
        }) as Promise<readonly [readonly Address[], readonly bigint[], readonly Address[], readonly bigint[]]>,
        publicClient.readContract({
          address: poolAddress, abi: POOL_ABI,
          functionName: 'getUserAccountData', args: [address],
        }) as Promise<readonly bigint[]>,
        publicClient.readContract({
          address: manager, abi: ctx.abis.PositionManager, functionName: 'migrationBlocker', args: [address],
        }) as Promise<number>,
      ]);

      const parsed: Scan = {
        aTokens: raw[0], aBalances: raw[1], debtAssets: raw[2], debtAmounts: raw[3],
      };
      setScan(parsed);
      setAccount(data);
      setBlocker(BLOCKERS[Number(blockerCode)] ?? 'None');

      const missing: Address[] = [];
      for (let i = 0; i < parsed.aTokens.length; i += 1) {
        const allowed = await publicClient.readContract({
          address: parsed.aTokens[i], abi: ERC20_ABI, functionName: 'allowance',
          args: [address, manager],
        }) as bigint;
        if (allowed < parsed.aBalances[i]) missing.push(parsed.aTokens[i]);
      }
      setNeedsApproval(missing);
    } catch {
      // A failed read must not leave the page waiting. Asking for approvals that turn
      // out to be unnecessary costs one transaction each and nothing else.
      setNeedsApproval([]);
      setBlocker('Unknown');
    } finally {
      setLoading(false);
    }
    // ctx.abis never changes after the first load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, manager, poolAddress, publicClient]);

  useEffect(() => { read(); }, [read, tx.status]);

  if (!address) return <Empty>{t('wallet.connect')}</Empty>;

  const hasPosition = scan !== null && scan.aTokens.length > 0;
  // A null list means the approval check has not answered yet.
  const nextApproval = needsApproval?.[0];
  const nextSymbol = ctx.config.assets.find((a) => a.aToken.toLowerCase() === nextApproval?.toLowerCase())?.symbol;

  return (
    <>
      <h1>{t('migrate.title')}</h1>
      <p className="muted">{t('migrate.intro')}</p>

      <Card title={t('common.position')} aside={<button type="button" className="ghost small" onClick={read} disabled={loading}>{t('common.retry')}</button>}>
        {/* The result stays on screen after the position it describes has moved away. */}
        <TxFeedback status={tx.status} error={tx.error} hash={tx.hash} />
        {!hasPosition && tx.status !== 'success' && <Empty>{t('migrate.none')}</Empty>}

        {hasPosition && account && (
          <>
            <RiskBar
              totalCollateralBase={account[0].toString()}
              totalDebtBase={account[1].toString()}
              liquidationThreshold={Number(account[3])}
              healthFactor={account[5].toString()}
            />
            <div className="spread" style={{ marginTop: 14 }}>
              <div>
                <div className="small muted">{t('common.netValue')}</div>
                <div className="big">{usd(account[0] - account[1])}</div>
              </div>
              <div className="right">
                <div className="small muted">{t('common.healthFactor')}</div>
                <div className="big">{healthFactorText(account[5])}</div>
              </div>
            </div>

            <table className="table" style={{ marginTop: 14 }}>
              <tbody>
                {scan.aTokens.map((aToken, i) => {
                  const asset = ctx.config.assets.find((a) => a.aToken.toLowerCase() === aToken.toLowerCase());
                  return (
                    <tr key={aToken}>
                      <td>{t('common.collateral')}</td>
                      <td>{asset?.symbol ?? aToken}</td>
                      <td className="right num">{amount(scan.aBalances[i], asset?.decimals ?? 18)}</td>
                    </tr>
                  );
                })}
                {scan.debtAssets.map((assetAddress, i) => {
                  const asset = ctx.config.assets.find((a) => a.address.toLowerCase() === assetAddress.toLowerCase());
                  return (
                    <tr key={assetAddress}>
                      <td style={{ color: 'var(--debt)' }}>{t('common.debt')}</td>
                      <td style={{ color: 'var(--debt)' }}>{asset?.symbol ?? assetAddress}</td>
                      <td className="right num" style={{ color: 'var(--debt)' }}>
                        {amount(scan.debtAmounts[i], asset?.decimals ?? 18)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {blocker !== 'None' && (
              <Notice kind="error">
                {blocker === 'Unknown'
                  ? t('migrate.blocked.Unknown')
                  : t(`migrate.blocked.${blocker}` as never)}
              </Notice>
            )}

            <div className="row" style={{ marginTop: 12 }}>
              {needsApproval === null ? (
                <button type="button" disabled>{t('common.loading')}…</button>
              ) : nextApproval ? (
                <button
                  type="button"
                  disabled={tx.busy}
                  onClick={() => tx.send({
                    address: nextApproval, abi: ERC20_ABI, functionName: 'approve',
                    args: [manager, MAX_UINT],
                  })}
                >
                  {t('migrate.approve', { s: nextSymbol ?? '' })}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={tx.busy || blocker !== 'None'}
                  onClick={async () => {
                    const ok = await tx.send({
                      address: manager, abi: ctx.abis.PositionManager, functionName: 'migrateIn', args: [],
                    });
                    // Leave the success notice on screen for a moment before moving on.
                    if (ok) setTimeout(() => { window.location.hash = '#/positions'; }, 1500);
                  }}
                >
                  {t('migrate.run')}
                </button>
              )}
            </div>
          </>
        )}
      </Card>

      {ctx.config.isLocal && <Faucet ctx={ctx} />}
    </>
  );
}

/** Test money, so a new person can try the whole flow without hunting for tokens. */
function Faucet({ ctx }: { ctx: AppContext }) {
  const { t } = useI18n();
  const { address } = useWallet();
  const tx = useTx();
  const [symbol, setSymbol] = useState('USDC');
  const [value, setValue] = useState('5000');

  const asset = ctx.config.assets.find((a) => a.symbol === symbol)!;
  const isWeth = symbol === 'WETH';

  return (
    <Card title={t('faucet.get')}>
      <p className="small muted">{t('faucet.hint')}</p>
      <div className="grid-2">
        <Field label={t('common.asset')} id="fa-asset">
          <select id="fa-asset" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {ctx.config.assets.map((a) => <option key={a.symbol} value={a.symbol}>{a.symbol}</option>)}
          </select>
        </Field>
        <Field label={t('common.amount')} id="fa-amount">
          <input id="fa-amount" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </div>
      <TxFeedback status={tx.status} error={tx.error} hash={tx.hash} />
      <button
        type="button"
        disabled={tx.busy || !address}
        onClick={() => tx.send(isWeth
          ? {
            address: asset.address as Address, abi: WETH_ABI, functionName: 'deposit', args: [],
            value: parseAmount(value, 18),
          }
          : {
            address: ctx.config.contracts.faucet as Address, abi: FAUCET_ABI, functionName: 'mint',
            args: [asset.address as Address, address as Address, parseAmount(value, asset.decimals)],
          })}
      >
        {t('faucet.get')}
      </button>
    </Card>
  );
}
