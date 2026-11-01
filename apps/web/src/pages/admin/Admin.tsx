import { NavLink, Outlet } from 'react-router-dom';
import { PageHeader } from '../../components/Ui';
import { usePageTitle } from '../../hooks';

const TABS = [
  { to: 'utilizatori', label: 'Utilizatori' },
  { to: 'organigrama', label: 'Organigramă' },
  { to: 'tipuri', label: 'Tipuri de document' },
  { to: 'registre', label: 'Registre' },
  { to: 'dosare', label: 'Dosare' },
  { to: 'acces', label: 'Acces controlat' },
  { to: 'setari', label: 'Securitate' },
  { to: 'ad', label: 'Sincronizare AD' },
  { to: 'migrare', label: 'Migrare' },
  { to: 'email', label: 'Email' },
];

export default function AdminPage() {
  usePageTitle('Administrare');
  return (
    <>
      <PageHeader title="Administrare" subtitle="Fiecare modificare se înregistrează în jurnalul de audit." />
      <nav className="tabs" aria-label="Secțiuni administrare">
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={({ isActive }) => (isActive ? 'tab tab-active' : 'tab')}>{tab.label}</NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
