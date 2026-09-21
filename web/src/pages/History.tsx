import { useState } from 'react';
import { useApi, type HistoryEntry } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useWallet } from '../lib/wallet';
import { Card, Empty } from '../components/ui';
import { amount, money, shortAddress } from '../lib/format';

export function HistoryPage() {
  const { t } = useI18n();
  const { address, chain } = useWallet();
  const [mineOnly, setMineOnly] = useState(true);
  const { data } = useApi<{ items: HistoryEntry[] }>('/api/history', {
    address: mineOnly && address ? address : undefined,
    limit: 200,
  });
  const explorer = chain.blockExplorers?.default.url;

  return (
    <>
      <h1>{t('history.title')}</h1>
      <Card
        aside={
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={mineOnly}
              disabled={!address}
              onChange={(e) => setMineOnly(e.target.checked)}
            />
            {t('history.mine')}
          </label>
        }
        title={t('history.title')}
      >
        {(!data || data.items.length === 0) && <Empty>{t('history.empty')}</Empty>}
        {data && data.items.length > 0 && (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.blockNumber')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('common.position')}</th>
                  <th>{t('common.amount')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((entry) => (
                  <tr key={`${entry.txHash}-${entry.logIndex}`}>
                    <td className="num faint">{entry.blockNumber}</td>
                    <td>{t(`history.type.${entry.type}` as never)}{entry.action ? ` · ${entry.action}` : ''}</td>
                    <td>{entry.tokenId ? <a href={`#/position/${entry.tokenId}`}>#{entry.tokenId}</a> : '—'}</td>
                    <td className="num">
                      {entry.price
                        ? money(entry.price, entry.assetSymbol === 'DAI' ? 18 : 6, entry.assetSymbol ?? '')
                        : entry.amount
                          ? `${amount(entry.amount, entry.decimals ?? 18)} ${entry.assetSymbol ?? ''}`
                          : '—'}
                    </td>
                    <td className="right tiny">
                      {explorer
                        ? <a href={`${explorer}/tx/${entry.txHash}`} target="_blank" rel="noreferrer">{shortAddress(entry.txHash)}</a>
                        : <span className="faint">{shortAddress(entry.txHash)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
