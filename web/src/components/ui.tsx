import { useEffect, type ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import type { FriendlyError } from '../lib/contracts';
import type { TxStatus } from '../lib/useTx';

export function Card({ title, aside, children }: { title?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || aside) && (
        <header className="card__head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          <div style={{ marginLeft: 'auto' }}>{aside}</div>
        </header>
      )}
      <div className="card__body">{children}</div>
    </section>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  return <div className={`notice notice--${kind}`} role={kind === 'error' ? 'alert' : undefined}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Field({
  label, hint, children, id,
}: { label: string; hint?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <div className="field__hint">{hint}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__head">
          <h2>{title}</h2>
          <button type="button" className="ghost small" onClick={onClose}>{t('common.close')}</button>
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}

export function TxFeedback({
  status, error, hash, explorer,
}: { status: TxStatus; error: FriendlyError | null; hash: string | null; explorer?: string }) {
  const { t } = useI18n();
  if (status === 'idle') return null;

  if (status === 'error' && error) {
    return (
      <Notice kind="error">
        <div>{error.rejected ? t('tx.rejected') : error.message}</div>
        {error.detail && !error.rejected && <div className="tiny faint">{error.detail}</div>}
      </Notice>
    );
  }
  if (status === 'success') {
    return (
      <Notice kind="ok">
        {t('tx.success')}
        {hash && explorer && (
          <> · <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{t('tx.view')}</a></>
        )}
      </Notice>
    );
  }
  return <Notice kind="info">{status === 'pending' ? t('tx.pending') : `${t('common.loading')}…`}</Notice>;
}

export function StatusTag({ status }: { status: string }) {
  const { t } = useI18n();
  const key = ['active', 'invalid', 'expired'].includes(status) ? status : 'unknown';
  return <span className={`tag tag--${key}`}>{t(`status.${key}` as never)}</span>;
}
