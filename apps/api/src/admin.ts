import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { isIP } from 'node:net';
import { AuditService } from './audit.js';
import { AuthGuard, AuthService, hashPassword, PasswordPolicy, passwordProblem, RequirePerm, User } from './auth.js';
import { Db, Queryable } from './db.js';
import { badRequest, conflict, notFound, optInt, optText, toInt } from './http.js';
import { CurrentUser, PERMISSIONS, Role } from './perms.js';

type Body_ = Record<string, unknown>;

const ROLES: Role[] = ['admin', 'manager', 'user', 'registratura', 'arhivar'];
const FIELD_TYPES = ['text', 'date', 'number'];
const GRANT_TARGETS: Record<string, { table: string; label: string }> = {
  document: { table: 'documents', label: 'title' },
  folder: { table: 'folders', label: 'name' },
  type: { table: 'document_types', label: 'name' },
  department: { table: 'departments', label: 'name' },
};
const has = (body: Body_, key: string) => Object.hasOwn(body, key);

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') badRequest(`Câmp invalid: ${field}`);
  return value as boolean;
}

function requiredText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? optText(value) : null;
  if (!text) badRequest(`Câmp obligatoriu: ${field}`);
  return text as string;
}

function nullableDate(value: unknown, field: string): string | null {
  const text = optText(value);
  if (text && !/^\d{4}-\d{2}-\d{2}$/.test(text)) badRequest(`Câmp invalid: ${field}`);
  return text;
}

function cleanFields(raw: unknown) {
  if (!Array.isArray(raw)) return badRequest('Câmpurile configurabile trebuie să fie o listă');
  const seen = new Set<string>();
  return raw.map((f: any) => {
    const key = typeof f?.key === 'string' ? f.key.trim() : '';
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(key)) badRequest(`Cheie de câmp invalidă: ${key || '(goală)'}`);
    if (seen.has(key)) badRequest(`Cheie de câmp duplicată: ${key}`);
    seen.add(key);
    const type = f.type ?? 'text';
    if (!FIELD_TYPES.includes(type)) badRequest(`Tip de câmp invalid: ${type}`);
    return { key, label: requiredText(f.label, 'etichetă câmp'), type, required: f.required === true };
  });
}

function retention(value: unknown): number | null {
  const years = optInt(value, 'termen de păstrare');
  if (years != null && (years < 0 || years > 200)) badRequest('Termenul de păstrare trebuie să fie între 0 și 200 de ani');
  return years;
}

function registerCode(value: unknown): string {
  const code = requiredText(value, 'cod registru');
  if (!/^[\p{L}0-9._-]{1,20}$/u.test(code)) badRequest('Codul registrului poate conține doar litere, cifre, punct, cratimă și liniuță de subliniere');
  return code;
}

function validCidr(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const [addr, prefix, extra] = value.trim().split('/');
  const family = isIP(addr ?? '');
  if (!family || extra !== undefined || !/^\d{1,3}$/.test(prefix ?? '')) return false;
  return Number(prefix) <= (family === 6 ? 128 : 32);
}

/** UPDATE doar pe coloanele trimise. Numele coloanelor vin din cod, niciodată din cerere. */
async function updateRow(c: Queryable, table: string, id: number, values: Record<string, unknown>): Promise<boolean> {
  const cols = Object.keys(values);
  if (!cols.length) return (await c.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount! > 0;
  const sets = cols.map((col, i) => `${col} = $${i + 2}`).join(', ');
  return (await c.query(`UPDATE ${table} SET ${sets} WHERE id = $1`, [id, ...cols.map((col) => values[col])])).rowCount! > 0;
}

const TYPE_COLUMNS = `id, name, nomenclator_code AS "nomenclatorCode", retention_years AS "retentionYears", fields`;
const REGISTER_COLUMNS = `id, name, code, department_id AS "departmentId", document_type_id AS "documentTypeId", active`;
const FOLDER_COLUMNS = `id, name, parent_id AS "parentId", department_id AS "departmentId"`;
const USER_SELECT = `SELECT u.id, u.username, u.full_name AS "fullName", u.email, u.role, u.department_id AS "departmentId", d.name AS "departmentName",
    u.job_title AS "jobTitle", u.has_token AS "hasToken", u.active, u.mfa_enabled AS "mfaEnabled", u.must_change_password AS "mustChangePassword", u.auth_source AS "authSource",
    u.locked_until AS "lockedUntil", u.substitute_id AS "substituteId", s.full_name AS "substituteName", u.substitute_until::text AS "substituteUntil",
    coalesce((SELECT jsonb_object_agg(p.permission, p.allowed) FROM user_permissions p WHERE p.user_id = u.id), '{}') AS permissions
  FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN users s ON s.id = u.substitute_id`;

@Controller('meta')
@UseGuards(AuthGuard)
export class MetaController {
  constructor(private readonly db: Db) {}

  @Get()
  async meta() {
    const rows = (sql: string) => this.db.query(sql).then((r) => r.rows);
    const [departments, documentTypes, registers, folders, users] = await Promise.all([
      rows(`SELECT d.id, d.name, d.parent_id AS "parentId", d.manager_id AS "managerId", m.full_name AS "managerName"
            FROM departments d LEFT JOIN users m ON m.id = d.manager_id ORDER BY d.name`),
      rows(`SELECT ${TYPE_COLUMNS} FROM document_types ORDER BY name`),
      rows(`SELECT ${REGISTER_COLUMNS} FROM registers ORDER BY name`),
      rows(`SELECT ${FOLDER_COLUMNS} FROM folders ORDER BY name`),
      rows(`SELECT u.id, u.full_name AS "fullName", u.job_title AS "jobTitle", d.name AS "departmentName"
            FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.active ORDER BY u.full_name`),
    ]);
    return { departments, documentTypes, registers, folders, users };
  }
}

@Controller('admin')
@UseGuards(AuthGuard)
@RequirePerm('users_admin')
export class AdminController {
  constructor(private readonly db: Db, private readonly audit: AuditService, private readonly auth: AuthService) {}

  // Tipuri de document ---------------------------------------------------------
  @Post('document-types')
  async createType(@User() user: CurrentUser, @Body() body: Body_) {
    return this.db.tx(async (c) => {
      const r = (await c.query(
        `INSERT INTO document_types (name, nomenclator_code, retention_years, fields) VALUES ($1,$2,$3,$4) RETURNING ${TYPE_COLUMNS}`,
        [requiredText(body.name, 'denumire'), requiredText(body.nomenclatorCode, 'cod nomenclator'), retention(body.retentionYears), JSON.stringify(cleanFields(body.fields ?? []))])).rows[0];
      await this.audit.log(user, { action: 'admin.tip_document_creat', details: { tip: r.id, denumire: r.name, cod: r.nomenclatorCode, pastrareAni: r.retentionYears } }, c);
      return r;
    });
  }

  @Patch('document-types/:id')
  async updateType(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Body_) {
    const typeId = toInt(id);
    const values: Record<string, unknown> = {};
    if (has(body, 'name')) values.name = requiredText(body.name, 'denumire');
    if (has(body, 'nomenclatorCode')) values.nomenclator_code = requiredText(body.nomenclatorCode, 'cod nomenclator');
    if (has(body, 'retentionYears')) values.retention_years = retention(body.retentionYears);
    if (has(body, 'fields')) values.fields = JSON.stringify(cleanFields(body.fields));
    return this.db.tx(async (c) => {
      if (!(await updateRow(c, 'document_types', typeId, values))) notFound('Tip de document inexistent');
      await this.audit.log(user, { action: 'admin.tip_document_modificat', details: { tip: typeId, campuri: Object.keys(values) } }, c);
      return (await c.query(`SELECT ${TYPE_COLUMNS} FROM document_types WHERE id = $1`, [typeId])).rows[0];
    });
  }

  // Registre -------------------------------------------------------------------
  @Post('registers')
  async createRegister(@User() user: CurrentUser, @Body() body: Body_) {
    return this.db.tx(async (c) => {
      const r = (await c.query(
        `INSERT INTO registers (name, code, department_id, document_type_id, active) VALUES ($1,$2,$3,$4,$5) RETURNING ${REGISTER_COLUMNS}`,
        [requiredText(body.name, 'denumire'), registerCode(body.code), optInt(body.departmentId, 'departament'), optInt(body.documentTypeId, 'tip document'),
          has(body, 'active') ? bool(body.active, 'activ') : true])).rows[0];
      await this.audit.log(user, { action: 'admin.registru_creat', details: { registru: r.id, denumire: r.name, cod: r.code } }, c);
      return r;
    });
  }

  @Patch('registers/:id')
  async updateRegister(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Body_) {
    const registerId = toInt(id);
    const values: Record<string, unknown> = {};
    if (has(body, 'name')) values.name = requiredText(body.name, 'denumire');
    if (has(body, 'code')) values.code = registerCode(body.code);
    if (has(body, 'departmentId')) values.department_id = optInt(body.departmentId, 'departament');
    if (has(body, 'documentTypeId')) values.document_type_id = optInt(body.documentTypeId, 'tip document');
    if (has(body, 'active')) values.active = bool(body.active, 'activ');
    return this.db.tx(async (c) => {
      if (!(await updateRow(c, 'registers', registerId, values))) notFound('Registru inexistent');
      await this.audit.log(user, { action: 'admin.registru_modificat', details: { registru: registerId, campuri: Object.keys(values) } }, c);
      return (await c.query(`SELECT ${REGISTER_COLUMNS} FROM registers WHERE id = $1`, [registerId])).rows[0];
    });
  }

  // Dosare ---------------------------------------------------------------------
  @Post('folders')
  async createFolder(@User() user: CurrentUser, @Body() body: Body_) {
    const name = requiredText(body.name, 'denumire');
    const parentId = optInt(body.parentId, 'dosar părinte');
    return this.db.tx(async (c) => {
      // UNIQUE (parent_id, name) nu acoperă dosarele fără părinte.
      const dup = await c.query('SELECT 1 FROM folders WHERE name = $1 AND parent_id IS NOT DISTINCT FROM $2::int', [name, parentId]);
      if (dup.rowCount) conflict('Există deja un dosar cu această denumire');
      const r = (await c.query(`INSERT INTO folders (name, parent_id, department_id) VALUES ($1,$2,$3) RETURNING ${FOLDER_COLUMNS}`,
        [name, parentId, optInt(body.departmentId, 'departament')])).rows[0];
      await this.audit.log(user, { action: 'admin.dosar_creat', details: { dosar: r.id, denumire: r.name } }, c);
      return r;
    });
  }

  // Departamente ---------------------------------------------------------------
  private async activeUser(c: Queryable, id: number | null) {
    if (id != null && !(await c.query('SELECT 1 FROM users WHERE id = $1 AND active', [id])).rowCount) badRequest('Managerul trebuie să fie un utilizator activ');
  }

  @Post('departments')
  async createDepartment(@User() user: CurrentUser, @Body() body: Body_) {
    const managerId = optInt(body.managerId, 'manager');
    return this.db.tx(async (c) => {
      await this.activeUser(c, managerId);
      const r = (await c.query(
        `INSERT INTO departments (name, parent_id, manager_id) VALUES ($1,$2,$3) RETURNING id, name, parent_id AS "parentId", manager_id AS "managerId"`,
        [requiredText(body.name, 'denumire'), optInt(body.parentId, 'departament părinte'), managerId])).rows[0];
      await this.audit.log(user, { action: 'admin.departament_creat', details: { departament: r.id, denumire: r.name, manager: managerId } }, c);
      return r;
    });
  }

  @Patch('departments/:id')
  async updateDepartment(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Body_) {
    const departmentId = toInt(id);
    const values: Record<string, unknown> = {};
    if (has(body, 'name')) values.name = requiredText(body.name, 'denumire');
    if (has(body, 'parentId')) values.parent_id = optInt(body.parentId, 'departament părinte');
    if (has(body, 'managerId')) values.manager_id = optInt(body.managerId, 'manager');
    return this.db.tx(async (c) => {
      await c.query('LOCK TABLE departments IN SHARE ROW EXCLUSIVE MODE');
      if (values.manager_id !== undefined) await this.activeUser(c, values.manager_id as number | null);
      if (values.parent_id != null) {
        const loop = await c.query(
          `WITH RECURSIVE up AS (SELECT id, parent_id FROM departments WHERE id = $1
             UNION SELECT d.id, d.parent_id FROM departments d JOIN up ON d.id = up.parent_id)
           SELECT 1 FROM up WHERE id = $2`, [values.parent_id, departmentId]);
        if (loop.rowCount) badRequest('Un departament nu poate fi subordonat lui însuși');
      }
      if (!(await updateRow(c, 'departments', departmentId, values))) notFound('Departament inexistent');
      await this.audit.log(user, { action: 'admin.departament_modificat', details: { departament: departmentId, ...values } }, c);
      return (await c.query('SELECT id, name, parent_id AS "parentId", manager_id AS "managerId" FROM departments WHERE id = $1', [departmentId])).rows[0];
    });
  }

  // Utilizatori ----------------------------------------------------------------
  @Get('users')
  async users() {
    return (await this.db.query(`${USER_SELECT} ORDER BY u.full_name`)).rows;
  }

  private async checkedPassword(value: unknown): Promise<string> {
    const password = typeof value === 'string' ? value : '';
    const problem = passwordProblem(password, await this.auth.policy());
    if (problem) badRequest(problem);
    return hashPassword(password);
  }

  @Post('users')
  async createUser(@User() user: CurrentUser, @Body() body: Body_) {
    const username = requiredText(body.username, 'utilizator').toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(username)) badRequest('Numele de utilizator poate conține doar litere fără diacritice, cifre, punct și cratimă');
    const fullName = requiredText(body.fullName, 'nume complet');
    if (!ROLES.includes(body.role as Role)) badRequest('Rol invalid');
    const hash = await this.checkedPassword(body.password);
    return this.db.tx(async (c) => {
      if ((await c.query('SELECT 1 FROM users WHERE lower(username) = $1', [username])).rowCount) conflict('Există deja un utilizator cu acest nume');
      // Parola dată de administrator este temporară: titularul o schimbă la prima autentificare.
      const id = (await c.query(
        `INSERT INTO users (username, full_name, email, password_hash, role, department_id, job_title, has_token, must_change_password)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING id`,
        [username, fullName, optText(body.email), hash, body.role, optInt(body.departmentId, 'departament'), optText(body.jobTitle),
          has(body, 'hasToken') ? bool(body.hasToken, 'token') : false])).rows[0].id;
      await this.audit.log(user, { action: 'admin.utilizator_creat', details: { utilizator: id, username, rol: body.role, departament: optInt(body.departmentId) } }, c);
      return (await c.query(`${USER_SELECT} WHERE u.id = $1`, [id])).rows[0];
    });
  }

  @Patch('users/:id')
  async updateUser(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Body_) {
    const targetId = toInt(id);
    const values: Record<string, unknown> = {};
    if (has(body, 'fullName')) values.full_name = requiredText(body.fullName, 'nume complet');
    if (has(body, 'email')) values.email = optText(body.email);
    if (has(body, 'role')) {
      if (!ROLES.includes(body.role as Role)) badRequest('Rol invalid');
      values.role = body.role;
    }
    if (has(body, 'departmentId')) values.department_id = optInt(body.departmentId, 'departament');
    if (has(body, 'jobTitle')) values.job_title = optText(body.jobTitle);
    if (has(body, 'hasToken')) values.has_token = bool(body.hasToken, 'token');
    if (has(body, 'active')) {
      values.active = bool(body.active, 'activ');
      if (values.active === false && targetId === user.id) conflict('Nu vă puteți dezactiva propriul cont');
      // O decizie a administratorului nu se mai poate anula la următoarea sincronizare cu directorul.
      values.deactivated_by_sync = false;
    }
    if (has(body, 'substituteId')) {
      values.substitute_id = optInt(body.substituteId, 'înlocuitor');
      if (values.substitute_id === targetId) badRequest('Un utilizator nu își poate fi propriul înlocuitor');
    }
    if (has(body, 'substituteUntil')) values.substitute_until = nullableDate(body.substituteUntil, 'înlocuitor până la');
    const overrides = has(body, 'permissions') ? this.cleanOverrides(body.permissions) : null;
    const passwordChange = has(body, 'password');
    if (passwordChange) {
      // Pentru contul propriu se folosește /auth/password, care cere parola curentă.
      if (targetId === user.id) badRequest('Parola proprie se schimbă din contul dumneavoastră');
      const source = (await this.db.one('SELECT auth_source FROM users WHERE id = $1', [targetId]))?.auth_source;
      if (source && source !== 'local') conflict('Parola acestui cont se administrează în directorul organizației, nu în SeaDoc.');
      values.password_hash = await this.checkedPassword(body.password);
      values.password_changed_at = new Date();
      values.must_change_password = true;
      values.failed_attempts = 0;
      values.locked_until = null;
    }

    return this.db.tx(async (c) => {
      // Serializează modificările care pot lăsa aplicația fără administrator.
      await c.query('SELECT pg_advisory_xact_lock(727002)');
      const before = (await c.query('SELECT role, active FROM users WHERE id = $1 FOR UPDATE', [targetId])).rows[0];
      if (!before) notFound('Utilizator inexistent');
      await updateRow(c, 'users', targetId, values);
      for (const [permission, allowed] of Object.entries(overrides ?? {})) {
        if (allowed === null) await c.query('DELETE FROM user_permissions WHERE user_id = $1 AND permission = $2', [targetId, permission]);
        else {
          await c.query(
            `INSERT INTO user_permissions (user_id, permission, allowed) VALUES ($1,$2,$3)
             ON CONFLICT (user_id, permission) DO UPDATE SET allowed = excluded.allowed`, [targetId, permission, allowed]);
        }
      }
      if (values.role !== undefined || values.active !== undefined || overrides) {
        const admins = (await c.query(
          `SELECT count(*)::int AS n FROM users u
           LEFT JOIN user_permissions p ON p.user_id = u.id AND p.permission = 'users_admin'
           WHERE u.active AND u.role = 'admin' AND coalesce(p.allowed, true)`)).rows[0].n;
        if (admins === 0) conflict('Trebuie să rămână cel puțin un administrator activ');
      }
      // Conturile dezactivate și parolele resetate invalidează sesiunile deschise.
      if (passwordChange || values.active === false) await c.query('DELETE FROM sessions WHERE user_id = $1', [targetId]);
      const { password_hash: _h, password_changed_at: _p, deactivated_by_sync: _d, ...visible } = values;
      await this.audit.log(user, {
        action: 'admin.utilizator_modificat',
        details: { utilizator: targetId, ...visible, parolaResetata: passwordChange || undefined, permisiuni: overrides ?? undefined, rolAnterior: values.role !== undefined ? before.role : undefined },
      }, c);
      return (await c.query(`${USER_SELECT} WHERE u.id = $1`, [targetId])).rows[0];
    });
  }

  private cleanOverrides(raw: unknown): Record<string, boolean | null> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) badRequest('Permisiuni invalide');
    const out: Record<string, boolean | null> = {};
    for (const [permission, allowed] of Object.entries(raw as object)) {
      if (!Object.hasOwn(PERMISSIONS, permission)) badRequest(`Permisiune necunoscută: ${permission}`);
      if (allowed !== null && typeof allowed !== 'boolean') badRequest(`Valoare invalidă pentru permisiunea ${permission}`);
      out[permission] = allowed;
    }
    return out;
  }

  // Acces controlat ------------------------------------------------------------
  @Get('grants')
  async grants(@Query('userId') userId?: string) {
    const uid = optInt(userId, 'utilizator');
    return (await this.db.query(
      `SELECT g.id, g.user_id AS "userId", u.full_name AS "userName", g.scope, g.target_id AS "targetId",
         CASE g.scope
           WHEN 'document' THEN (SELECT title FROM documents WHERE id = g.target_id)
           WHEN 'folder' THEN (SELECT name FROM folders WHERE id = g.target_id)
           WHEN 'type' THEN (SELECT name FROM document_types WHERE id = g.target_id)
           WHEN 'department' THEN (SELECT name FROM departments WHERE id = g.target_id)
         END AS "targetName"
       FROM access_grants g JOIN users u ON u.id = g.user_id
       WHERE $1::int IS NULL OR g.user_id = $1 ORDER BY u.full_name, g.scope, g.target_id`, [uid])).rows;
  }

  @Post('grants')
  async createGrant(@User() user: CurrentUser, @Body() body: Body_) {
    const userId = toInt(body.userId, 'utilizator');
    const scope = String(body.scope);
    const targetId = toInt(body.targetId, 'țintă');
    if (!Object.hasOwn(GRANT_TARGETS, scope)) badRequest('Tip de acces invalid');
    return this.db.tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount) notFound('Utilizator inexistent');
      if (!(await c.query(`SELECT 1 FROM ${GRANT_TARGETS[scope].table} WHERE id = $1`, [targetId])).rowCount) notFound('Ținta accesului nu există');
      const r = (await c.query(
        `INSERT INTO access_grants (user_id, scope, target_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING
         RETURNING id, user_id AS "userId", scope, target_id AS "targetId"`, [userId, scope, targetId])).rows[0];
      if (!r) conflict('Accesul este deja acordat');
      await this.audit.log(user, { action: 'admin.acces_acordat', documentId: scope === 'document' ? targetId : null, details: { acces: r.id, utilizator: userId, tip: scope, tinta: targetId } }, c);
      return r;
    });
  }

  @Delete('grants/:id') @HttpCode(200)
  async deleteGrant(@User() user: CurrentUser, @Param('id') id: string) {
    return this.db.tx(async (c) => {
      const r = (await c.query('DELETE FROM access_grants WHERE id = $1 RETURNING user_id, scope, target_id', [toInt(id)])).rows[0];
      if (!r) notFound('Accesul nu există');
      await this.audit.log(user, { action: 'admin.acces_revocat', documentId: r.scope === 'document' ? r.target_id : null, details: { acces: toInt(id), utilizator: r.user_id, tip: r.scope, tinta: r.target_id } }, c);
      return { ok: true };
    });
  }

  // Setări ---------------------------------------------------------------------
  @Get('settings')
  async settings() {
    const rows = (await this.db.query(`SELECT key, value FROM settings WHERE key IN ('password_policy','internal_networks')`)).rows;
    const by = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return { passwordPolicy: by.password_policy, internalNetworks: by.internal_networks };
  }

  private async saveSetting(user: CurrentUser, key: string, value: unknown, action: string) {
    await this.db.tx(async (c) => {
      await c.query('UPDATE settings SET value = $2 WHERE key = $1', [key, JSON.stringify(value)]);
      await this.audit.log(user, { action, details: { valoare: value } }, c);
    });
    return value;
  }

  @Put('settings/password-policy')
  async savePolicy(@User() user: CurrentUser, @Body() body: Partial<PasswordPolicy>) {
    const current = await this.auth.policy();
    const number = (key: keyof PasswordPolicy, min: number, max: number): number => {
      const value = body[key] ?? current[key];
      if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) badRequest(`Valoare invalidă pentru ${key} (${min}–${max})`);
      return value as number;
    };
    const requireComplexity = body.requireComplexity ?? current.requireComplexity;
    if (typeof requireComplexity !== 'boolean') badRequest('Valoare invalidă pentru requireComplexity');
    return this.saveSetting(user, 'password_policy', {
      minLength: number('minLength', 8, 128),
      requireComplexity,
      expiryDays: number('expiryDays', 0, 3650),
      maxFailedAttempts: number('maxFailedAttempts', 1, 100),
      lockMinutes: number('lockMinutes', 1, 10080),
    }, 'admin.politica_parole_modificata');
  }

  @Put('settings/internal-networks')
  async saveNetworks(@User() user: CurrentUser, @Body() body: { networks?: unknown }) {
    const raw = body?.networks;
    if (!Array.isArray(raw)) return badRequest('Trimiteți lista de rețele în câmpul networks');
    const invalid = raw.find((net) => !validCidr(net));
    if (invalid !== undefined) badRequest(`Rețea invalidă: ${String(invalid)} (format CIDR, de exemplu 10.0.0.0/8)`);
    const networks = raw.map((net: string) => net.trim());
    await this.saveSetting(user, 'internal_networks', networks, 'admin.retele_interne_modificate');
    return { networks };
  }
}
