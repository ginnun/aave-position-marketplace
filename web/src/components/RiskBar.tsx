import { healthFactorText, usd } from '../lib/format';
import { useI18n } from '../lib/i18n';

/**
 * The whole bar is the collateral. The filled part is the debt. The notch marks
 * the point where Aave allows a liquidator in. When the fill reaches the notch,
 * the position is liquidatable.
 */
export function RiskBar({
  totalCollateralBase,
  totalDebtBase,
  liquidationThreshold,
  healthFactor,
  compact = false,
}: {
  totalCollateralBase: string;
  totalDebtBase: string;
  liquidationThreshold: number;
  healthFactor: string;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const collateral = Number(BigInt(totalCollateralBase));
  const debt = Number(BigInt(totalDebtBase));
  const fill = collateral === 0 ? 0 : Math.min(100, (debt / collateral) * 100);
  const line = Math.min(100, liquidationThreshold / 100);
  const danger = fill >= line && debt > 0;

  return (
    <div className={`risk${danger ? ' risk--danger' : ''}`}>
      <div
        className="risk__track"
        role="img"
        aria-label={`${t('common.collateral')} ${usd(totalCollateralBase)}, ${t('common.debt')} ${usd(totalDebtBase)}, ${t('common.healthFactor')} ${healthFactorText(healthFactor)}`}
      >
        <div className="risk__fill" style={{ width: `${fill}%` }} />
        {debt > 0 && <div className="risk__line" style={{ left: `${line}%` }} />}
      </div>
      {!compact && (
        <div className="risk__legend">
          <span>
            <strong style={{ color: 'var(--debt)' }}>{usd(totalDebtBase)}</strong> {t('common.debt')}
          </span>
          <span>
            {t('common.collateral')} <strong style={{ color: 'var(--collateral)' }}>{usd(totalCollateralBase)}</strong>
          </span>
        </div>
      )}
    </div>
  );
}
