import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { errorMessage } from '../api';
import { DOC_STATUS, type Tone } from '../labels';
import { plural } from '../format';
import type { DocStatus } from '../types';

export function Alert({ kind = 'info', title, children }: { kind?: 'info' | 'success' | 'warning' | 'error'; title?: string; children?: ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {title && <p className="alert-title">{title}</p>}
      {children && <div>{children}</div>}
    </div>
  );
}

export function ErrorAlert({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  const errors = (error as { errors?: string[] }).errors;
  return (
    <Alert kind="error">
      <p>{errorMessage(error)}</p>
      {errors && errors.length > 0 && <ul className="alert-list">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      {retry && <button type="button" className="btn btn-sm alert-action" onClick={retry}>Încearcă din nou</button>}
    </Alert>
  );
}

export function Loading({ label = 'Se încarcă…' }: { label?: string }) {
  return <p className="loading" role="status"><span className="spinner" aria-hidden="true" />{label}</p>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div>{children}</div>}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: DocStatus }) {
  const info = DOC_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={info.tone}>{info.label}</Badge>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Section({ title, actions, children, id }: { title: string; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="panel" id={id}>
      <div className="panel-head">
        <h2>{title}</h2>
        {actions && <div className="panel-actions">{actions}</div>}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Field({ label, hint, required, error, children, className }: {
  label: ReactNode; hint?: ReactNode; required?: boolean; error?: string; children: ReactNode; className?: string;
}) {
  return (
    <label className={`field ${className ?? ''}`}>
      <span className="field-label">
        {label}
        {required && <span className="required" title="Câmp obligatoriu"> *</span>}
      </span>
      {children}
      {hint && <span className="hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

/** Tabel într-un container propriu: derulează orizontal fără să împingă pagina. */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>{children}</div>;
}

export function Pagination({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  if (total === 0) return null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <nav className="pagination" aria-label="Paginare">
      <span className="pagination-info">{plural(total, 'rezultat', 'rezultate')} · pagina {page} din {pages}</span>
      <span className="pagination-buttons">
        <button type="button" className="btn" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}>Înapoi</button>
        <button type="button" className="btn" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Înainte</button>
      </span>
    </nav>
  );
}

/** Dialog nativ: focusul rămâne în dialog, iar Escape îl închide. */
export function Modal({ title, onClose, children, footer, wide }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
    >
      <div className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Închide" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </dialog>
  );
}

export function DefinitionList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="deflist">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value === null || item.value === undefined || item.value === '' ? '–' : item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
