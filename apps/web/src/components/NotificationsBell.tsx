import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { fmtDateTime } from '../format';
import { useInterval } from '../hooks';
import type { Notification } from '../types';

interface NotificationsResponse { unread: number; items: Notification[] }

export function NotificationsBell() {
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      setData(await api<NotificationsResponse>('/notifications'));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useInterval(() => { void load(); }, 30_000);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openItem = async (item: Notification) => {
    setOpen(false);
    try {
      if (!item.readAt) await api(`/notifications/${item.id}/read`, { method: 'POST' });
      void load();
    } catch (err) {
      setError(errorMessage(err));
    }
    if (item.documentId) {
      navigate(item.taskId ? `/documente/${item.documentId}#sarcina` : `/documente/${item.documentId}`);
    } else if (item.taskId) {
      navigate('/sarcini');
    }
  };

  const readAll = async () => {
    try {
      await api('/notifications/read-all', { method: 'POST' });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const unread = data?.unread ?? 0;
  const label = unread ? `Notificări: ${unread} necitite` : 'Notificări: niciuna necitită';
  return (
    <div className="bell" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="header-btn"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => { setOpen(!open); if (!open) void load(); }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10 21a2 2 0 0 0 4 0" />
        </svg>
        {unread > 0 && <span className="bell-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel">
          <div className="bell-head">
            <h2>Notificări</h2>
            {unread > 0 && <button type="button" className="btn btn-sm" onClick={readAll}>Marchează toate ca citite</button>}
          </div>
          {error && <p className="bell-error" role="alert">{error}</p>}
          {!data && !error && <p className="bell-empty">Se încarcă…</p>}
          {data && data.items.length === 0 && <p className="bell-empty">Nu aveți notificări.</p>}
          {data && data.items.length > 0 && (
            <ul className="bell-list">
              {data.items.map((item) => (
                <li key={item.id} className={item.readAt ? '' : 'bell-unread'}>
                  <button type="button" onClick={() => void openItem(item)}>
                    {!item.readAt && <span className="visually-hidden">Necitită: </span>}
                    <span className="bell-title">{item.title}</span>
                    <span className="bell-date">{fmtDateTime(item.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <span className="visually-hidden" role="status">{unread ? `${unread} notificări necitite` : ''}</span>
    </div>
  );
}
