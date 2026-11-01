import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Info, Inbox, TriangleAlert, X, type LucideIcon,
} from 'lucide-react';
import { errorMessage } from '../api';
import { DOC_STATUS, type Tone } from '../labels';
import { plural } from '../format';
import type { DocStatus } from '../types';

type AlertKind = 'info' | 'success' | 'warning' | 'error';
const ALERT_ICONS: Record<AlertKind, LucideIcon> = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert };

export function Alert({ kind = 'info', title, children }: { kind?: AlertKind; title?: string; children?: ReactNode }) {
  const Icon = ALERT_ICONS[kind];
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon className="alert-icon" size={18} aria-hidden="true" />
      <div className="alert-content">
        {title && <p className="alert-title">{title}</p>}
        {children && <div>{children}</div>}
      </div>
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

export function Empty({ title, icon: Icon = Inbox, children }: { title: string; icon?: LucideIcon; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true"><Icon size={22} /></span>
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
  return <span className={`badge badge-${info.tone} badge-dot`}>{info.label}</span>;
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

/**
 * Panou cu titlu. Cu `collapsible`, conținutul se poate restrânge; formularele din el își păstrează
 * valorile, iar `defaultOpen` deschide panoul și când datele sosesc după prima afișare.
 */
export function Section({ title, icon: Icon, count, actions, children, id, collapsible, defaultOpen = true }: {
  title: string; icon?: LucideIcon; count?: number; actions?: ReactNode; children: ReactNode; id?: string;
  collapsible?: boolean; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
  const heading = (
    <h2 className="panel-title">
      {Icon && <Icon size={17} aria-hidden="true" />}
      {title}
      {count !== undefined && count > 0 && <span className="panel-count">{count}</span>}
    </h2>
  );
  if (!collapsible) {
    return (
      <section className="panel" id={id}>
        <div className="panel-head">
          {heading}
          {actions && <div className="panel-actions">{actions}</div>}
        </div>
        <div className="panel-body">{children}</div>
      </section>
    );
  }
  return (
    <details className="panel panel-collapsible" id={id} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="panel-head">
        <span className="panel-summary">
          <ChevronRight className="panel-chevron" size={17} aria-hidden="true" />
          {heading}
        </span>
        {actions && <div className="panel-actions">{actions}</div>}
      </summary>
      <div className="panel-body">{children}</div>
    </details>
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
      <span className="pagination-info">{plural(total, 'rezultat', 'rezultate')}{pages > 1 ? ` · pagina ${page} din ${pages}` : ''}</span>
      {pages > 1 && (
        <span className="pagination-buttons">
          <button type="button" className="btn" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}><ChevronLeft size={16} aria-hidden="true" />Înapoi</button>
          <button type="button" className="btn" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Înainte<ChevronRight size={16} aria-hidden="true" /></button>
        </span>
      )}
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
        <button type="button" className="icon-btn" aria-label="Închide" onClick={onClose}><X size={20} aria-hidden="true" /></button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </dialog>
  );
}

/** Listă de date. Rândurile fără valoare nu se afișează. */
export function DefinitionList({ items }: { items: { label: string; value: ReactNode }[] }) {
  const visible = items.filter((item) => item.value !== null && item.value !== undefined && item.value !== '' && item.value !== '–');
  return (
    <dl className="deflist">
      {visible.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
