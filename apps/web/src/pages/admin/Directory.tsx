import { useMemo, useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, DefinitionList, Empty, ErrorAlert, Loading, Section, TableScroll } from '../../components/Ui';
import { fmtDateTime } from '../../format';
import { useAsync, usePageTitle } from '../../hooks';
import { roleLabel } from '../../labels';
import type { AdminUser } from '../../types';

interface SyncCounts {
  directoryUsers: number; usersCreated: number; usersUpdated: number; usersDeactivated: number; usersReactivated: number;
  rolesChanged: number; departmentsCreated: number; managersSet: number; localConflicts: number; skipped: number; managersUnresolved: number;
}
interface SyncChange { type: string; username?: string; department?: string; fields?: string[]; from?: string; to?: string; reason?: string }
interface SyncResult { dryRun: boolean; applied: boolean; counts: SyncCounts; changes: SyncChange[]; blocked: string | null; finishedAt: string }
interface Status {
  enabled: boolean; url: string | null; baseDn: string | null; tls: boolean | null; syncIntervalMinutes: number;
  groupRoleMap: { group: string; role: string }[]; lastSync: { at: string; by: string; counts: SyncCounts } | null; accounts: Record<string, number>;
}

const CHANGE_LABEL: Record<string, string> = {
  utilizator_nou: 'Utilizator nou',
  utilizator_modificat: 'Date modificate',
  utilizator_dezactivat: 'Dezactivare',
  utilizator_reactivat: 'Reactivare',
  rol_modificat: 'Rol schimbat',
  departament_nou: 'Departament nou',
  manager_departament: 'Manager departament',
  conflict_cont_local: 'Cont local cu același nume',
  ignorat: 'Ignorat',
};
const COUNT_LABEL: [keyof SyncCounts, string][] = [
  ['directoryUsers', 'Utilizatori în director'],
  ['usersCreated', 'Utilizatori noi'],
  ['usersUpdated', 'Utilizatori modificați'],
  ['usersDeactivated', 'Dezactivați'],
  ['usersReactivated', 'Reactivați'],
  ['rolesChanged', 'Roluri schimbate'],
  ['departmentsCreated', 'Departamente noi'],
  ['managersSet', 'Manageri setați'],
  ['localConflicts', 'Conflicte cu conturi locale'],
  ['skipped', 'Ignorați'],
  ['managersUnresolved', 'Manageri negăsiți în director'],
];

function describe(c: SyncChange): string {
  if (c.type === 'rol_modificat') return `${roleLabel(c.from ?? '')} → ${roleLabel(c.to ?? '')}`;
  if (c.type === 'utilizator_nou') return `${roleLabel(c.to ?? '')}${c.department ? ` · ${c.department}` : ''}`;
  if (c.type === 'manager_departament') return `${c.department}: ${c.username}`;
  if (c.fields) return c.fields.join(', ');
  return c.reason ?? '';
}

export default function AdminDirectoryPage() {
  usePageTitle('Sincronizare AD');
  const status = useAsync(() => api<Status>('/admin/ldap/status'), []);
  const users = useAsync(() => api<AdminUser[]>('/admin/users'), []);
  const [preview, setPreview] = useState<SyncResult | null>(null);
  const [applied, setApplied] = useState<SyncResult | null>(null);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const byUsername = useMemo(() => new Map((users.data ?? []).map((u) => [u.username.toLowerCase(), u])), [users.data]);

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<SyncResult>('/admin/ldap/sync', { method: 'POST', body: { dryRun, force } });
      if (dryRun) { setPreview(res); setApplied(null); setForce(false); } else { setApplied(res); setPreview(null); await status.reload(); await users.reload(); }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const link = async (user: AdminUser) => {
    if (!window.confirm(`${user.fullName} se va autentifica de acum prin Active Directory. Parola locală se șterge, iar sesiunile deschise se închid. Continuați?`)) return;
    setError(null);
    try {
      await api(`/admin/ldap/users/${user.id}/source`, { method: 'POST', body: { source: 'ldap' } });
      await users.reload();
      await run(true);
    } catch (err) {
      setError(err);
    }
  };

  if (status.loading && !status.data) return <Loading />;
  if (status.error) return <ErrorAlert error={status.error} retry={() => void status.reload()} />;
  const s = status.data;
  if (!s) return null;
  if (!s.enabled) {
    return (
      <Section title="Sincronizare AD">
        <Alert kind="info">LDAP nu este configurat. Setați variabilele LDAP_URL, LDAP_BIND_DN, LDAP_BIND_PASSWORD și LDAP_BASE_DN, apoi reporniți serverul.</Alert>
      </Section>
    );
  }
  const result = applied ?? preview;
  return (
    <>
      <Section title="Director">
        {s.tls === false && <Alert kind="warning">Conexiunea cu directorul nu este criptată. Parolele circulă în clar dacă serverul nu este pe aceeași mașină. Folosiți ldaps://.</Alert>}
        <DefinitionList items={[
          { label: 'Server', value: s.url },
          { label: 'Bază de căutare', value: s.baseDn },
          { label: 'Sincronizare periodică', value: s.syncIntervalMinutes ? `la ${s.syncIntervalMinutes} minute` : 'Nu; doar la cerere' },
          { label: 'Conturi active', value: `${s.accounts.ldap ?? 0} LDAP, ${s.accounts.local ?? 0} locale${s.accounts.oidc ? `, ${s.accounts.oidc} SSO` : ''}` },
          { label: 'Ultima sincronizare', value: s.lastSync ? `${fmtDateTime(s.lastSync.at)} (${s.lastSync.by})` : 'Niciuna' },
          { label: 'Mapare grupuri', value: s.groupRoleMap.length ? s.groupRoleMap.map((m) => `${m.group} → ${roleLabel(m.role)}`).join('; ') : 'Fără; rolurile rămân cele setate manual' },
        ]} />
        <div className="form-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(true)}>{busy && !preview ? 'Se citește directorul…' : 'Previzualizează schimbările'}</button>
        </div>
        <ErrorAlert error={error} />
      </Section>
      {result && (
        <Section title={result.dryRun ? 'Previzualizare: nu s-a modificat nimic' : 'Sincronizare aplicată'}>
          {result.blocked && <Alert kind="warning" title="Verificați înainte de a aplica">{result.blocked}</Alert>}
          <div className="badge-row">
            {COUNT_LABEL.filter(([key]) => result.counts[key] > 0).map(([key, label]) => <Badge key={key}>{label}: {result.counts[key]}</Badge>)}
          </div>
          {result.changes.length === 0 && <Empty title="Nicio schimbare." />}
          {result.changes.length > 0 && (
            <TableScroll label="Schimbări">
              <table className="table table-cards">
                <caption className="visually-hidden">Schimbări</caption>
                <thead><tr><th scope="col">Schimbare</th><th scope="col">Utilizator sau departament</th><th scope="col">Detalii</th><th scope="col"><span className="visually-hidden">Acțiuni</span></th></tr></thead>
                <tbody>
                  {result.changes.map((c, i) => {
                    const local = c.type === 'conflict_cont_local' ? byUsername.get(c.username ?? '') : undefined;
                    return (
                      <tr key={i}>
                        <td data-label="Schimbare">{CHANGE_LABEL[c.type] ?? c.type}</td>
                        <td data-label="Utilizator sau departament">{c.username ?? c.department}</td>
                        <td data-label="Detalii">{describe(c)}</td>
                        <td className="cell-actions">{local && <button type="button" className="btn btn-sm" onClick={() => void link(local)}>Treci pe AD</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          )}
          {result.dryRun && (
            <div className="form-actions">
              {result.blocked && (
                <label className="check"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Am verificat și aplic oricum</label>
              )}
              <button type="button" className="btn btn-primary" disabled={busy || (!!result.blocked && !force)} onClick={() => void run(false)}>{busy ? 'Se aplică…' : 'Aplică schimbările'}</button>
            </div>
          )}
        </Section>
      )}
    </>
  );
}
