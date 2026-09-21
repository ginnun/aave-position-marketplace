import { useState } from 'react';
import type { AppContext } from '../App';
import { useApi, type Position } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useWallet } from '../lib/wallet';
import { RiskBar } from '../components/RiskBar';
import { Card, Empty, Field, Notice } from '../components/ui';
import { healthFactor, healthFactorText, usd } from '../lib/format';

const ALERT_KEY = 'hfAlert';

export function PositionsPage({ ctx }: { ctx: AppContext }) {
  const { t } = useI18n();
  const { address } = useWallet();
  const { data } = useApi<{ items: Position[] }>(address ? '/api/positions' : null, { owner: address ?? '' });
  const [alert, setAlert] = useState(() => localStorage.getItem(ALERT_KEY) ?? '1.20');

  if (!address) return <Empty>{t('wallet.connect')}</Empty>;

  const items = data?.items ?? [];
  const threshold = Number(alert) || 0;
  const atRisk = items.filter((p) => {
    const hf = healthFactor(p.healthFactor);
    return hf !== null && hf < threshold;
  });

  return (
    <>
      <h1>{t('positions.title')}</h1>

      <Card title={t('positions.riskAlert')}>
        <div className="grid-2">
          <Field label={t('positions.riskAlert')} hint={t('positions.riskAlertHint')} id="alert">
            <input
              id="alert"
              inputMode="decimal"
              value={alert}
              onChange={(e) => { setAlert(e.target.value); localStorage.setItem(ALERT_KEY, e.target.value); }}
            />
          </Field>
        </div>
        {atRisk.length > 0 && (
          <Notice kind="warn">
            {t('positions.atRisk')}: {atRisk.map((p) => `#${p.tokenId}`).join(', ')}
          </Notice>
        )}
      </Card>

      {items.length === 0 && (
        <Empty>
          {t('positions.empty')}
          <div style={{ marginTop: 12 }}>
            <a className="button" href="#/migrate">{t('nav.migrate')}</a>
          </div>
        </Empty>
      )}

      <div className="stack">
        {items.map((position) => (
          <PositionCard key={position.tokenId} position={position} threshold={threshold} ctx={ctx} />
        ))}
      </div>
    </>
  );
}

function PositionCard({ position, threshold }: { position: Position; threshold: number; ctx: AppContext }) {
  const { t } = useI18n();
  const hf = healthFactor(position.healthFactor);
  const flagged = hf !== null && hf < threshold;

  return (
    <a className="card" href={`#/position/${position.tokenId}`} style={{ display: 'block', textDecoration: 'none' }}>
      <div className="card__head">
        <h3>#{position.tokenId}</h3>
        {position.listing && <span className="tag tag--active">{t('positions.listed')}</span>}
        {flagged && <span className="tag tag--invalid">{t('positions.atRisk')}</span>}
        <span className="tiny faint" style={{ marginLeft: 'auto' }}>
          {position.collateral.map((c) => c.symbol).join(' + ')} → {position.debt.map((d) => d.symbol).join(' + ') || t('common.none')}
        </span>
      </div>
      <div className="card__body">
        {position.unavailable && (
          <p className="small muted" style={{ margin: 0 }}>{t('common.unavailable')}</p>
        )}
        {!position.unavailable && (
        <>
        <div className="spread" style={{ alignItems: 'flex-end', marginBottom: 12 }}>
          <div>
            <div className="small muted">{t('common.netValue')}</div>
            <div className="big">{usd(position.netValueBase)}</div>
          </div>
          <div className="right">
            <div className="small muted">{t('common.healthFactor')}</div>
            <div className="big">{healthFactorText(position.healthFactor)}</div>
          </div>
        </div>
        <RiskBar
          totalCollateralBase={position.totalCollateralBase}
          totalDebtBase={position.totalDebtBase}
          liquidationThreshold={position.liquidationThreshold}
          healthFactor={position.healthFactor}
        />
        </>
        )}
      </div>
    </a>
  );
}
