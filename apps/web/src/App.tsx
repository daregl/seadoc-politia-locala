import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Link, Navigate, Outlet, RouterProvider, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { Alert, Loading, PageHeader } from './components/Ui';
import DashboardPage from './pages/Dashboard';
import DocumentDetailPage from './pages/document/DocumentDetail';
import DocumentsPage from './pages/Documents';
import LoginPage from './pages/Login';
import RegisterDocumentPage from './pages/RegisterDocument';
import TasksPage from './pages/Tasks';
import type { Permission } from './types';

// bpmn-js și paginile de administrare se încarcă doar când sunt deschise.
const DocumentWorkflowPage = lazy(() => import('./pages/DocumentWorkflow'));
const WorkflowsPage = lazy(() => import('./pages/Workflows'));
const WorkflowDetailPage = lazy(() => import('./pages/WorkflowDetail'));
const ArchivePage = lazy(() => import('./pages/Archive'));
const AuditPage = lazy(() => import('./pages/Audit'));
const GdprPage = lazy(() => import('./pages/Gdpr'));
const GdprRequestsPage = lazy(() => import('./pages/GdprRequests'));
const GdprRequestDetailPage = lazy(() => import('./pages/GdprRequestDetail'));
const EmailInboxPage = lazy(() => import('./pages/EmailInbox'));
const EmailMessagePage = lazy(() => import('./pages/EmailMessage'));
const AdminEmailOutbox = lazy(() => import('./pages/admin/EmailOutbox'));
const ReportsPage = lazy(() => import('./pages/Reports'));
const AdminPage = lazy(() => import('./pages/admin/Admin'));
const AdminUsers = lazy(() => import('./pages/admin/Users'));
const AdminOrganization = lazy(() => import('./pages/admin/Organization'));
const AdminTypes = lazy(() => import('./pages/admin/DocumentTypes'));
const AdminRegisters = lazy(() => import('./pages/admin/Registers'));
const AdminFolders = lazy(() => import('./pages/admin/Folders'));
const AdminSettings = lazy(() => import('./pages/admin/Settings'));
const AdminGrants = lazy(() => import('./pages/admin/Grants'));
const AdminDirectory = lazy(() => import('./pages/admin/Directory'));
const AdminMigration = lazy(() => import('./pages/admin/Migration'));
const ErpPage = lazy(() => import('./pages/Erp'));
const ErpRecordPage = lazy(() => import('./pages/ErpRecord'));

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Loading />}>{children}</Suspense>;
}

function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') {
    return <div className="boot"><Loading label="Se încarcă SeaDoc…" /></div>;
  }
  if (status !== 'ok') {
    return <Navigate to="/autentificare" replace state={{ from: location.pathname + location.search + location.hash }} />;
  }
  return <Layout />;
}

function RequirePerm({ perms, children }: { perms: Permission[]; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(...perms)) {
    return (
      <>
        <PageHeader title="Acces restricționat" />
        <Alert kind="warning">Contul dumneavoastră nu are drepturi pentru această pagină.</Alert>
      </>
    );
  }
  return <Lazy>{children}</Lazy>;
}

function NotFound() {
  return (
    <>
      <PageHeader title="Pagina nu există" />
      <p>Adresa accesată nu corespunde niciunei pagini.</p>
      <p><Link to="/panou">Înapoi la pagina principală</Link></p>
    </>
  );
}

function RootBoundary() {
  const location = useLocation();
  return <ErrorBoundary resetKey={location.pathname}><Outlet /></ErrorBoundary>;
}

const router = createBrowserRouter([
  {
    element: <RootBoundary />,
    children: [
      { path: '/autentificare', element: <LoginPage /> },
      {
        element: <RequireAuth />,
        children: [
          { path: '/', element: <Navigate to="/panou" replace /> },
          { path: '/panou', element: <DashboardPage /> },
          { path: '/documente', element: <DocumentsPage /> },
          { path: '/documente/nou', element: <RequirePerm perms={['register']}><RegisterDocumentPage /></RequirePerm> },
          { path: '/documente/:id', element: <DocumentDetailPage /> },
          { path: '/documente/:id/flux', element: <Lazy><DocumentWorkflowPage /></Lazy> },
          { path: '/sarcini', element: <TasksPage /> },
          { path: '/fluxuri', element: <Lazy><WorkflowsPage /></Lazy> },
          { path: '/fluxuri/nou', element: <RequirePerm perms={['workflow_edit']}><WorkflowDetailPage /></RequirePerm> },
          { path: '/fluxuri/:key', element: <Lazy><WorkflowDetailPage /></Lazy> },
          { path: '/arhiva', element: <RequirePerm perms={['archive']}><ArchivePage /></RequirePerm> },
          { path: '/audit', element: <RequirePerm perms={['audit_all', 'archive_journal']}><AuditPage /></RequirePerm> },
          { path: '/gdpr', element: <RequirePerm perms={['audit_all']}><GdprPage /></RequirePerm> },
          { path: '/gdpr/cereri', element: <RequirePerm perms={['audit_all']}><GdprRequestsPage /></RequirePerm> },
          { path: '/gdpr/cereri/:id', element: <RequirePerm perms={['audit_all']}><GdprRequestDetailPage /></RequirePerm> },
          { path: '/email-primit', element: <RequirePerm perms={['register']}><EmailInboxPage /></RequirePerm> },
          { path: '/email-primit/:id', element: <RequirePerm perms={['register']}><EmailMessagePage /></RequirePerm> },
          { path: '/erp', element: <Lazy><ErpPage /></Lazy> },
          { path: '/erp/:id', element: <Lazy><ErpRecordPage /></Lazy> },
          { path: '/rapoarte', element: <RequirePerm perms={['reports']}><ReportsPage /></RequirePerm> },
          {
            path: '/administrare',
            element: <RequirePerm perms={['users_admin']}><AdminPage /></RequirePerm>,
            children: [
              { index: true, element: <Navigate to="utilizatori" replace /> },
              { path: 'utilizatori', element: <Lazy><AdminUsers /></Lazy> },
              { path: 'organigrama', element: <Lazy><AdminOrganization /></Lazy> },
              { path: 'tipuri', element: <Lazy><AdminTypes /></Lazy> },
              { path: 'registre', element: <Lazy><AdminRegisters /></Lazy> },
              { path: 'dosare', element: <Lazy><AdminFolders /></Lazy> },
              { path: 'acces', element: <Lazy><AdminGrants /></Lazy> },
              { path: 'setari', element: <Lazy><AdminSettings /></Lazy> },
              { path: 'ad', element: <Lazy><AdminDirectory /></Lazy> },
              { path: 'migrare', element: <Lazy><AdminMigration /></Lazy> },
              { path: 'email', element: <Lazy><AdminEmailOutbox /></Lazy> },
            ],
          },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);

export default function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
