import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Archive, ChartColumn, ChevronDown, Database, FileText, FolderOpen, House, Inbox, ListChecks, Lock, MapPin, Megaphone, Menu,
  Search, Settings, ShieldCheck, UserRound, Workflow, X, type LucideIcon,
} from 'lucide-react';
import { api, qs } from '../api';
import { useAuth, useUser } from '../auth';
import { useAsync, useInterval } from '../hooks';
import { roleLabel } from '../labels';
import type { Permission, Task } from '../types';
import { Wordmark } from './Brand';
import { ErrorBoundary } from './ErrorBoundary';
import { NotificationsBell } from './NotificationsBell';
import { TASKS_CHANGED } from './TaskActions';

interface NavItem { to: string; label: string; icon: LucideIcon; perms?: Permission[] }
interface NavGroup { title?: string; items: NavItem[] }

const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { to: '/panou', label: 'Acasă', icon: House },
      { to: '/sarcini', label: 'Sarcinile mele', icon: ListChecks },
      { to: '/documente', label: 'Documente', icon: FileText },
      { to: '/email-primit', label: 'Email primit', icon: Inbox, perms: ['register'] },
    ],
  },
  {
    title: 'Lucrări',
    items: [
      { to: '/lucrari', label: 'Lucrări', icon: FolderOpen },
      { to: '/istoric-adresa', label: 'Istoric pe adresă', icon: MapPin },
      { to: '/intranet', label: 'Intranet', icon: Megaphone },
    ],
  },
  {
    title: 'Organizare',
    items: [
      { to: '/fluxuri', label: 'Fluxuri', icon: Workflow },
      { to: '/arhiva', label: 'Arhivă', icon: Archive, perms: ['archive'] },
      { to: '/erp', label: 'Date ERP', icon: Database },
      { to: '/rapoarte', label: 'Rapoarte', icon: ChartColumn, perms: ['reports'] },
    ],
  },
  {
    title: 'Control',
    items: [
      { to: '/audit', label: 'Audit', icon: ShieldCheck, perms: ['audit_all', 'archive_journal'] },
      { to: '/gdpr', label: 'GDPR', icon: Lock, perms: ['audit_all'] },
      { to: '/administrare', label: 'Administrare', icon: Settings, perms: ['users_admin'] },
    ],
  },
];

function CountPill({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span className="nav-count">{count > 99 ? '99+' : count}<span className="visually-hidden"> deschise</span></span>;
}

/** Căutare disponibilă din orice pagină; pe pagina Documente rămâne doar căutarea ei. */
function GlobalSearch() {
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = term.trim();
    navigate(q ? `/documente${qs({ q })}` : '/documente');
    setTerm('');
  };
  return (
    <form className="topbar-search" role="search" onSubmit={submit}>
      <Search size={17} aria-hidden="true" />
      <input type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Caută în documente" aria-label="Caută în documente" />
    </form>
  );
}

function UserMenu() {
  const { logout } = useAuth();
  const user = useUser();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

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

  return (
    <div className="user-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="user-btn"
        aria-label={`Contul meu: ${user.fullName}`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(!open)}
      >
        <UserRound className="phone-only" size={20} aria-hidden="true" />
        <span className="user-btn-name">{user.fullName}</span>
        <ChevronDown className="user-btn-name" size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="user-panel">
          <div className="user-panel-head">
            <strong>{user.fullName}</strong>
            <span className="muted">{roleLabel(user.role)}{user.departmentName ? ` · ${user.departmentName}` : ''}</span>
          </div>
          <button type="button" className="user-panel-action" onClick={() => void logout()}>Ieșire</button>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { can } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const openTasks = useAsync(() => api<Task[]>(`/tasks${qs({ scope: 'open' })}`), [location.pathname]);
  useInterval(() => { void openTasks.reload(); }, 60_000);
  const taskCount = openTasks.data?.length ?? 0;
  useEffect(() => {
    const onChanged = () => { void openTasks.reload(); };
    window.addEventListener(TASKS_CHANGED, onChanged);
    return () => window.removeEventListener(TASKS_CHANGED, onChanged);
  }, []);

  useEffect(() => { setMenuOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const groups = NAV_GROUPS
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.perms || can(...item.perms)) }))
    .filter((group) => group.items.length > 0);

  return (
    <div className="app">
      <a className="skip-link" href="#continut">Sari la conținut</a>
      {menuOpen && <button type="button" className="sidebar-backdrop" aria-label="Închide meniul" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand">
          <Link to="/panou" className="brand"><Wordmark /></Link>
          <button type="button" className="icon-btn sidebar-close" aria-label="Închide meniul" onClick={() => setMenuOpen(false)}><X size={20} aria-hidden="true" /></button>
        </div>
        {can('register') && (
          <Link to="/documente/nou" className="btn sidebar-cta">Înregistrează document</Link>
        )}
        <nav id="navigatie" className="app-nav" aria-label="Navigare principală">
          {groups.map((group) => (
            <div key={group.title ?? 'principal'} className="nav-group">
              {group.title && <p className="nav-group-title">{group.title}</p>}
              <ul>
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to} className={({ isActive }) => (isActive && location.pathname !== '/documente/nou' ? 'active' : '')}>
                      <item.icon size={16} aria-hidden="true" />
                      <span className="nav-label">{item.label}</span>
                      {item.to === '/sarcini' && <CountPill count={taskCount} />}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="app-content">
        <header className="topbar">
          <Link to="/panou" className="brand topbar-brand"><Wordmark /></Link>
          {location.pathname !== '/documente' && <GlobalSearch />}
          <div className="topbar-right">
            <NotificationsBell />
            <UserMenu />
          </div>
        </header>
        <main id="continut" className="app-main" tabIndex={-1}>
          <ErrorBoundary resetKey={location.pathname}><Outlet /></ErrorBoundary>
        </main>
      </div>

      <nav className="bottom-nav" aria-label="Navigare rapidă">
        <NavLink to="/panou"><House size={21} aria-hidden="true" /><span>Acasă</span></NavLink>
        <NavLink to="/sarcini">
          <span className="bottom-nav-icon"><ListChecks size={21} aria-hidden="true" /><CountPill count={taskCount} /></span>
          <span>Sarcini</span>
        </NavLink>
        <NavLink to="/documente" className={({ isActive }) => (isActive && location.pathname !== '/documente/nou' ? 'active' : '')}><FileText size={21} aria-hidden="true" /><span>Documente</span></NavLink>
        <button type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><Menu size={21} aria-hidden="true" /><span>Meniu</span></button>
      </nav>
    </div>
  );
}
