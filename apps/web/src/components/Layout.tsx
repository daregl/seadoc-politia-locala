import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './ErrorBoundary';
import { useAuth, useUser } from '../auth';
import { roleLabel } from '../labels';
import type { Permission } from '../types';
import { NotificationsBell } from './NotificationsBell';

interface NavItem { to: string; label: string; perms?: Permission[]; end?: boolean }
const NAV: NavItem[] = [
  { to: '/panou', label: 'Panou' },
  { to: '/documente', label: 'Documente', end: true },
  { to: '/documente/nou', label: 'Înregistrare document', perms: ['register'] },
  { to: '/email-primit', label: 'Email primit', perms: ['register'] },
  { to: '/sarcini', label: 'Sarcinile mele' },
  { to: '/fluxuri', label: 'Fluxuri' },
  { to: '/arhiva', label: 'Arhivă', perms: ['archive'] },
  { to: '/audit', label: 'Audit', perms: ['audit_all', 'archive_journal'] },
  { to: '/gdpr', label: 'GDPR', perms: ['audit_all'] },
  { to: '/erp', label: 'Date ERP (import)' },
  { to: '/rapoarte', label: 'Rapoarte', perms: ['reports'] },
  { to: '/administrare', label: 'Administrare', perms: ['users_admin'] },
];

export function Layout() {
  const { logout, can } = useAuth();
  const user = useUser();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => { setMenuOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const items = NAV.filter((item) => !item.perms || can(...item.perms));
  return (
    <div className="app">
      <a className="skip-link" href="#continut">Sari la conținut</a>
      <header className="app-header">
        <button
          type="button"
          className="header-btn menu-toggle"
          aria-label={menuOpen ? 'Închide meniul' : 'Deschide meniul'}
          aria-expanded={menuOpen}
          aria-controls="navigatie"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            {menuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
        <NavLink to="/panou" className="brand">
          <span className="brand-name">SeaDoc</span>
          <span className="brand-tag">Management documente</span>
        </NavLink>
        <div className="header-right">
          <NotificationsBell />
          <div className="header-user">
            <span className="header-user-name">{user.fullName}</span>
            <span className="header-user-role">{roleLabel(user.role)}</span>
          </div>
          <button type="button" className="header-btn header-logout" onClick={() => void logout()}>Ieșire</button>
        </div>
      </header>
      <div className="app-body">
        <nav id="navigatie" className={`app-nav ${menuOpen ? 'app-nav-open' : ''}`} aria-label="Navigare principală">
          <div className="nav-user">
            <strong>{user.fullName}</strong>
            <span>{roleLabel(user.role)}{user.departmentName ? ` · ${user.departmentName}` : ''}</span>
          </div>
          <ul>
            {items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => (isActive || (item.to === '/documente' && /^\/documente\/\d/.test(location.pathname)) ? 'active' : '')}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main id="continut" className="app-main" tabIndex={-1}>
          <ErrorBoundary resetKey={location.pathname}><Outlet /></ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
