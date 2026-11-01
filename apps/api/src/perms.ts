// Matricea din specificație, secțiunea „Roluri și permisiuni”.
export type Role = 'admin' | 'manager' | 'user' | 'registratura' | 'arhivar';

export const PERMISSIONS = {
  register: ['admin', 'manager', 'registratura'],
  approve: ['admin', 'manager', 'user'],
  sign_qualified: ['admin', 'manager', 'user'], // utilizatorul doar dacă are token
  workflow_edit: ['admin', 'manager'], // managerul doar fluxurile departamentului
  archive: ['admin', 'arhivar'],
  users_admin: ['admin'],
  audit_all: ['admin'],
  reports: ['admin', 'manager'], // managerul doar pe departament
  archive_journal: ['admin', 'arhivar'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export interface CurrentUser {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  departmentId: number | null;
  departmentName: string | null;
  jobTitle: string | null;
  hasToken: boolean;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  authSource?: string;
  overrides: Record<string, boolean>;
  ip: string;
}

export function can(user: CurrentUser, permission: Permission): boolean {
  const override = user.overrides[permission];
  if (override !== undefined) return override;
  if (permission === 'sign_qualified' && user.role === 'user') return user.hasToken;
  return (PERMISSIONS[permission] as readonly string[]).includes(user.role);
}

export function permissionsOf(user: CurrentUser): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(user, p));
}

/**
 * Condiția SQL de vizibilitate, folosită la listă, căutare și detaliu, ca nimeni să nu
 * vadă un document la care nu are acces. Adaugă parametrii în `params`.
 */
export function visibleSql(user: CurrentUser, params: unknown[], alias = 'd'): string {
  if (user.role === 'admin') return 'TRUE';
  params.push(user.id);
  const uid = `$${params.length}`;
  const parts = [
    `${alias}.owner_id = ${uid}`,
    `EXISTS (SELECT 1 FROM document_access da WHERE da.document_id = ${alias}.id AND da.user_id = ${uid})`,
    `EXISTS (SELECT 1 FROM access_grants g WHERE g.user_id = ${uid} AND (
       (g.scope = 'document' AND g.target_id = ${alias}.id) OR
       (g.scope = 'folder' AND g.target_id = ${alias}.folder_id) OR
       (g.scope = 'type' AND g.target_id = ${alias}.document_type_id) OR
       (g.scope = 'department' AND g.target_id = ${alias}.department_id)))`,
  ];
  if (['manager', 'registratura', 'arhivar'].includes(user.role) && user.departmentId != null) {
    params.push(user.departmentId);
    parts.push(`${alias}.department_id = $${params.length}`);
  }
  // Arhivarul trebuie să vadă documentele soluționate, ca să le poată arhiva.
  if (user.role === 'arhivar') parts.push(`${alias}.status IN ('aprobat','respins','arhivat','eliminat')`);
  return `(${parts.join(' OR ')})`;
}
