import { useMemo, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { useUser } from '../../auth';
import { ActionNotice } from '../../components/TaskActions';
import { Badge, Empty, ErrorAlert, Field, Loading, Modal } from '../../components/Ui';
import { fmtDate } from '../../format';
import { useAsync, usePageTitle } from '../../hooks';
import { PERMISSION_LABELS, ROLE_LABELS, roleLabel } from '../../labels';
import { indentedDepartments } from '../../tree';
import type { AdminUser, Meta, Permission, Role } from '../../types';

export default function AdminUsersPage() {
  usePageTitle('Utilizatori');
  const users = useAsync(() => api<AdminUser[]>('/admin/users'), []);
  const meta = useAsync(() => api<Meta>('/meta'), []);
  const [editing, setEditing] = useState<AdminUser | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const shown = useMemo(() => {
    const term = filter.trim().toLocaleLowerCase('ro');
    return (users.data ?? []).filter((u) => !term
      || `${u.fullName} ${u.username} ${u.jobTitle ?? ''} ${u.departmentName ?? ''}`.toLocaleLowerCase('ro').includes(term));
  }, [users.data, filter]);

  return (
    <>
      <div className="toolbar">
        <Field label="Caută utilizator" className="toolbar-grow">
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Nume, utilizator, funcție sau departament" />
        </Field>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>Utilizator nou</button>
      </div>
      <ActionNotice message={notice} onDismiss={() => setNotice(null)} />
      <ErrorAlert error={users.error} retry={() => void users.reload()} />
      <ErrorAlert error={meta.error} retry={() => void meta.reload()} />
      {users.loading && !users.data && <Loading />}
      {users.data && shown.length === 0 && <Empty title="Niciun utilizator găsit." />}
      {shown.length > 0 && (
        <div className="table-cards-wrap">
          <table className="table table-cards">
            <caption className="visually-hidden">Utilizatori</caption>
            <thead>
              <tr>
                <th scope="col">Nume</th>
                <th scope="col">Rol</th>
                <th scope="col">Departament</th>
                <th scope="col">Funcție</th>
                <th scope="col">Înlocuitor</th>
                <th scope="col">Stare</th>
                <th scope="col"><span className="visually-hidden">Acțiune</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => (
                <tr key={u.id}>
                  <td data-label="Nume" className="cell-grow">
                    <strong>{u.fullName}</strong>
                    <div className="muted cell-small">{u.username}{u.email ? ` · ${u.email}` : ''}</div>
                  </td>
                  <td data-label="Rol">{roleLabel(u.role)}</td>
                  <td data-label="Departament">{u.departmentName ?? '–'}</td>
                  <td data-label="Funcție">{u.jobTitle ?? '–'}</td>
                  <td data-label="Înlocuitor">
                    {u.substituteName ?? '–'}
                    {u.substituteName && u.substituteUntil && <div className="muted cell-small">până la {fmtDate(u.substituteUntil)}</div>}
                  </td>
                  <td data-label="Stare">
                    <span className="badge-row">
                      <Badge tone={u.active ? 'success' : 'neutral'}>{u.active ? 'Activ' : 'Inactiv'}</Badge>
                      {u.mfaEnabled && <Badge>MFA</Badge>}
                      {u.authSource === 'ldap' && <Badge tone="info">AD</Badge>}
                      {u.authSource === 'oidc' && <Badge tone="info">SSO</Badge>}
                      {u.hasToken && <Badge>Token</Badge>}
                      {u.lockedUntil && new Date(u.lockedUntil) > new Date() && <Badge tone="danger">Blocat</Badge>}
                      {Object.keys(u.permissions ?? {}).length > 0 && <Badge tone="warning">Drepturi ajustate</Badge>}
                    </span>
                  </td>
                  <td className="cell-actions"><button type="button" className="btn btn-sm" onClick={() => setEditing(u)}>Editează</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && meta.data && (
        <UserDialog
          key={editing === 'new' ? 'new' : editing.id}
          user={editing === 'new' ? null : editing}
          users={users.data ?? []}
          meta={meta.data}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setNotice(message);
            void users.reload();
          }}
        />
      )}
    </>
  );
}

type OverrideValue = '' | 'allow' | 'deny';
const PERMISSIONS = Object.keys(PERMISSION_LABELS) as Permission[];

function UserDialog({ user, users, meta, onClose, onSaved }: {
  user: AdminUser | null; users: AdminUser[]; meta: Meta; onClose: () => void; onSaved: (message: string) => void;
}) {
  const me = useUser();
  const isSelf = user?.id === me.id;
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(user?.role ?? 'user');
  const [departmentId, setDepartmentId] = useState(String(user?.departmentId ?? ''));
  const [jobTitle, setJobTitle] = useState(user?.jobTitle ?? '');
  const [hasToken, setHasToken] = useState(user?.hasToken ?? false);
  const [active, setActive] = useState(user?.active ?? true);
  const [substituteId, setSubstituteId] = useState(String(user?.substituteId ?? ''));
  const [substituteUntil, setSubstituteUntil] = useState(user?.substituteUntil?.slice(0, 10) ?? '');
  const [overrides, setOverrides] = useState<Record<Permission, OverrideValue>>(() => Object.fromEntries(PERMISSIONS.map((p) => {
    const value = user?.permissions?.[p];
    return [p, value === undefined ? '' : value ? 'allow' : 'deny'];
  })) as Record<Permission, OverrideValue>);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const departments = useMemo(() => indentedDepartments(meta.departments), [meta.departments]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const common = {
      fullName,
      email: email || null,
      role,
      departmentId: departmentId ? Number(departmentId) : null,
      jobTitle: jobTitle || null,
      hasToken,
    };
    try {
      if (user) {
        // Se trimit doar ajustările schimbate; null readuce permisiunea la valoarea din rol.
        const permissions: Partial<Record<Permission, boolean | null>> = {};
        for (const p of PERMISSIONS) {
          const before = user.permissions?.[p];
          const next = overrides[p] === '' ? undefined : overrides[p] === 'allow';
          if (before !== next) permissions[p] = next ?? null;
        }
        await api(`/admin/users/${user.id}`, {
          method: 'PATCH',
          body: {
            ...common,
            active,
            substituteId: substituteId ? Number(substituteId) : null,
            substituteUntil: substituteUntil || null,
            ...(Object.keys(permissions).length ? { permissions } : {}),
            ...(password ? { password } : {}),
          },
        });
        onSaved(`Contul ${user.username} a fost actualizat.`);
      } else {
        const created = await api<AdminUser>('/admin/users', { method: 'POST', body: { ...common, username, password } });
        const hasOverrides = PERMISSIONS.some((p) => overrides[p] !== '');
        if (hasOverrides) {
          const permissions = Object.fromEntries(PERMISSIONS.filter((p) => overrides[p] !== '').map((p) => [p, overrides[p] === 'allow']));
          await api(`/admin/users/${created.id}`, { method: 'PATCH', body: { permissions } });
        }
        onSaved(`Contul ${created.username} a fost creat. Titularul își schimbă parola la prima autentificare.`);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={user ? `Editare: ${user.fullName}` : 'Utilizator nou'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Renunță</button>
          <button type="submit" form="user-form" className="btn btn-primary" disabled={busy}>{busy ? 'Se salvează…' : 'Salvează'}</button>
        </>
      )}
    >
      <form id="user-form" onSubmit={submit}>
        <ErrorAlert error={error} />
        <div className="form-grid">
          {!user && (
            <Field label="Nume de utilizator" required hint="Litere fără diacritice, cifre, punct și cratimă.">
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" spellCheck={false} autoComplete="off" required />
            </Field>
          )}
          <Field label="Nume complet" required><input value={fullName} onChange={(e) => setFullName(e.target.value)} required /></Field>
          <Field label="E-mail"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" /></Field>
          <Field label="Rol" required>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {(Object.keys(ROLE_LABELS) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </Field>
          <Field label="Departament">
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">Fără departament</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
          </Field>
          <Field label="Funcție"><input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} /></Field>
          {!isSelf && (!user?.authSource || user.authSource === 'local') && (
            <Field
              label={user ? 'Parolă nouă' : 'Parolă temporară'}
              required={!user}
              hint={user ? 'Gol păstrează parola actuală. Titularul o schimbă la următoarea autentificare.' : 'Titularul o schimbă la prima autentificare.'}
            >
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required={!user} />
            </Field>
          )}
          <label className="check form-grid-end">
            <input type="checkbox" checked={hasToken} onChange={(e) => setHasToken(e.target.checked)} />
            <span>Are token pentru semnătură cu certificat</span>
          </label>
          {user && (
            <label className="check form-grid-end">
              <input type="checkbox" checked={active} disabled={isSelf} onChange={(e) => setActive(e.target.checked)} />
              <span>Cont activ {isSelf && <span className="hint">Nu vă puteți dezactiva propriul cont.</span>}</span>
            </label>
          )}
        </div>

        {user && (
          <fieldset className="fieldset">
            <legend>Înlocuitor</legend>
            <div className="form-grid">
              <Field label="Persoană" hint="Pe durata înlocuirii primește sarcinile în locul titularului.">
                <select value={substituteId} onChange={(e) => setSubstituteId(e.target.value)}>
                  <option value="">Fără înlocuitor</option>
                  {users.filter((u) => u.id !== user.id && u.active).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
                </select>
              </Field>
              <Field label="Până la data">
                <input type="date" value={substituteUntil} onChange={(e) => setSubstituteUntil(e.target.value)} />
              </Field>
            </div>
          </fieldset>
        )}

        <fieldset className="fieldset">
          <legend>Ajustări individuale de drepturi</legend>
          <p className="hint">„Conform rolului” păstrează dreptul dat de rol. Celelalte două opțiuni îl suprascriu doar pentru acest cont.</p>
          <div className="form-grid form-grid-dense">
            {PERMISSIONS.map((p) => (
              <Field key={p} label={PERMISSION_LABELS[p]}>
                <select value={overrides[p]} onChange={(e) => setOverrides((prev) => ({ ...prev, [p]: e.target.value as OverrideValue }))}>
                  <option value="">Conform rolului</option>
                  <option value="allow">Permis</option>
                  <option value="deny">Interzis</option>
                </select>
              </Field>
            ))}
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
