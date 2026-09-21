import { useState } from 'react';
import { useI18n } from '../lib/i18n';
import { shortAddress } from '../lib/format';
import { useWallet } from '../lib/wallet';
import { Modal, Notice } from './ui';

export function WalletButton({ expectedChainId, isLocal }: { expectedChainId: number; isLocal: boolean }) {
  const { t } = useI18n();
  const {
    address, kind, label, chainId, connect, disconnect, switchChain, hasInjected, testAccounts, error,
  } = useWallet();
  const [open, setOpen] = useState(false);
  const wrongNetwork = address !== null && chainId !== null && chainId !== expectedChainId;

  if (!address) {
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>{t('wallet.connect')}</button>
        {open && (
          <Modal title={t('wallet.choose')} onClose={() => setOpen(false)}>
            <div className="stack">
              {error && <Notice kind="error">{error}</Notice>}
              <button
                type="button"
                disabled={!hasInjected}
                onClick={async () => { await connect('injected'); setOpen(false); }}
              >
                {t('wallet.browser')}
              </button>
              {!hasInjected && <p className="small muted">{t('wallet.noInjected')}</p>}

              {isLocal && (
                <fieldset>
                  <legend>{t('wallet.test')}</legend>
                  <p className="small muted">{t('wallet.testHint')}</p>
                  <div className="row">
                    {testAccounts.map((account, index) => (
                      <button
                        key={account.label}
                        type="button"
                        className="ghost small"
                        onClick={async () => { await connect('test', index); setOpen(false); }}
                      >
                        {account.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
            </div>
          </Modal>
        )}
      </>
    );
  }

  return (
    <div className="row" style={{ gap: 8 }}>
      {wrongNetwork && (
        <button type="button" className="small" onClick={switchChain}>{t('wallet.switch')}</button>
      )}
      <span className="wallet-chip">
        <span className={`dot${wrongNetwork ? ' dot--warn' : ''}`} />
        <span>{label ? `${label} · ` : ''}{shortAddress(address)}</span>
        <span className="faint">
          {wrongNetwork ? t('wallet.wrongNetwork') : (kind === 'test' ? t('wallet.test') : '')}
        </span>
      </span>
      <button type="button" className="ghost small" onClick={disconnect}>{t('wallet.disconnect')}</button>
    </div>
  );
}
