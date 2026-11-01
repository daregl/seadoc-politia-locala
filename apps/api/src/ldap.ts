// Sincronizarea utilizatorilor și a departamentelor din AD, cu previzualizare.
import { Body, Controller, Get, HttpCode, Injectable, Logger, OnModuleDestroy, Param, Post, UseGuards } from '@nestjs/common';
import { AuditService } from './audit.js';
import { AuthGuard, AuthService, hashPassword, passwordProblem, RequirePerm, User } from './auth.js';
import { Db, Queryable } from './db.js';
import { badRequest, conflict, fail, notFound, toInt } from './http.js';
import { DirectoryEntry, LdapClient, LdapConfig, LdapUnavailableError, NO_LOCAL_PASSWORD, normalizeDn } from './ldap-client.js';
import { CurrentUser, Role } from './perms.js';

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SETTING_LAST = 'ldap_last_sync';
/** Sub acest număr de dezactivări nu se aplică pragul procentual: un director mic poate pierde câțiva oameni odată. */
const MIN_DEACTIVATIONS_FOR_THRESHOLD = 5;

export interface SyncCounts {
  directoryUsers: number; usersCreated: number; usersUpdated: number; usersDeactivated: number; usersReactivated: number;
  rolesChanged: number; departmentsCreated: number; managersSet: number; localConflicts: number; skipped: number; managersUnresolved: number;
}
export interface SyncChange { type: string; username?: string; department?: string; fields?: string[]; from?: unknown; to?: unknown; reason?: string }
export interface SyncResult {
  dryRun: boolean; applied: boolean; counts: SyncCounts; changes: SyncChange[];
  /** Motivul pentru care aplicarea ar fi refuzată fără confirmare explicită. */
  blocked: string | null; finishedAt: string;
}

interface Plan {
  counts: SyncCounts; changes: SyncChange[]; blocked: string | null;
  departmentsToCreate: string[];
  toCreate: (DirectoryEntry & { role: Role })[];
  toUpdate: { id: number; username: string; values: Record<string, unknown> }[];
  toDeactivate: number[];
  toReactivate: number[];
  /** Nume departament (cu litere mici) → nume utilizator manager. */
  managers: { department: string; username: string }[];
  departmentByKey: Map<string, number>;
}

const deptKey = (name: string) => name.trim().toLowerCase();

@Injectable()
export class LdapSyncService implements OnModuleDestroy {
  private readonly log = new Logger('LDAP');
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: Db, private readonly audit: AuditService, private readonly ldap: LdapClient) {}

  /** Rolul din maparea grupurilor, dacă există; altfel `null`, iar rolul existent rămâne neatins. */
  private mappedRole(cfg: LdapConfig, entry: DirectoryEntry): Role | null {
    return cfg.groupRoleMap.find((m) => entry.groups.includes(m.group))?.role ?? null;
  }

  private async plan(c: Queryable, cfg: LdapConfig, directory: DirectoryEntry[]): Promise<Plan> {
    const users = (await c.query(
      `SELECT id, username, auth_source, full_name, email, department_id, job_title, role, active, ldap_dn, deactivated_by_sync FROM users`)).rows;
    const departments = (await c.query('SELECT id, name, manager_id FROM departments')).rows;
    const byUsername = new Map(users.map((u) => [u.username.toLowerCase(), u]));
    const departmentByKey = new Map<string, number>(departments.map((d) => [deptKey(d.name), d.id]));
    const managerByDept = new Map<number, number | null>(departments.map((d) => [d.id, d.manager_id]));

    const counts: SyncCounts = {
      directoryUsers: directory.length, usersCreated: 0, usersUpdated: 0, usersDeactivated: 0, usersReactivated: 0,
      rolesChanged: 0, departmentsCreated: 0, managersSet: 0, localConflicts: 0, skipped: 0, managersUnresolved: 0,
    };
    const plan: Plan = { counts, changes: [], blocked: null, departmentsToCreate: [], toCreate: [], toUpdate: [], toDeactivate: [], toReactivate: [], managers: [], departmentByKey };
    const seen = new Set<string>();
    const accepted: DirectoryEntry[] = [];
    const planned = new Set<string>();

    const planDepartment = (raw: string | null): string | null => {
      if (!raw) return null;
      const key = deptKey(raw);
      if (!departmentByKey.has(key) && !planned.has(key)) {
        planned.add(key);
        plan.departmentsToCreate.push(raw.trim());
        counts.departmentsCreated++;
        plan.changes.push({ type: 'departament_nou', department: raw.trim() });
      }
      return key;
    };

    for (const entry of directory) {
      if (!USERNAME.test(entry.username) || seen.has(entry.username)) {
        counts.skipped++;
        plan.changes.push({ type: 'ignorat', username: entry.username, reason: seen.has(entry.username) ? 'nume duplicat în director' : 'nume de utilizator nepermis' });
        continue;
      }
      seen.add(entry.username);
      const existing = byUsername.get(entry.username);
      // Un cont local cu același nume nu devine extern pe tăcute: AD ar prelua controlul unui cont, poate de administrator.
      if (existing && existing.auth_source !== 'ldap') {
        counts.localConflicts++;
        plan.changes.push({ type: 'conflict_cont_local', username: entry.username, reason: 'există un cont local cu același nume' });
        continue;
      }
      if (entry.disabled) {
        if (!existing) {
          counts.skipped++;
          plan.changes.push({ type: 'ignorat', username: entry.username, reason: 'dezactivat în director, nu se importă' });
        } else if (existing.active) {
          plan.toDeactivate.push(existing.id);
          counts.usersDeactivated++;
          plan.changes.push({ type: 'utilizator_dezactivat', username: entry.username, reason: 'dezactivat în director' });
        }
        continue;
      }
      accepted.push(entry);
      const role = this.mappedRole(cfg, entry);
      const department = planDepartment(entry.department);
      if (!existing) {
        plan.toCreate.push({ ...entry, role: role ?? 'user' });
        counts.usersCreated++;
        plan.changes.push({ type: 'utilizator_nou', username: entry.username, to: role ?? 'user', department: entry.department ?? undefined });
        continue;
      }
      const values: Record<string, unknown> = {};
      if (existing.full_name !== entry.fullName) values.full_name = entry.fullName;
      if (entry.email && existing.email !== entry.email) values.email = entry.email;
      if (entry.jobTitle && existing.job_title !== entry.jobTitle) values.job_title = entry.jobTitle;
      if (existing.ldap_dn !== entry.dn) values.ldap_dn = entry.dn;
      if (department) {
        const id = departmentByKey.get(department);
        if (id === undefined || id !== existing.department_id) values.__department = department;
      }
      const fields = Object.keys(values).map((k) => (k === '__department' ? 'department_id' : k)).filter((k) => k !== 'ldap_dn');
      if (Object.keys(values).length) {
        plan.toUpdate.push({ id: existing.id, username: entry.username, values });
        if (fields.length) {
          counts.usersUpdated++;
          plan.changes.push({ type: 'utilizator_modificat', username: entry.username, fields });
        }
      }
      if (role && role !== existing.role) {
        plan.toUpdate.push({ id: existing.id, username: entry.username, values: { role } });
        counts.rolesChanged++;
        plan.changes.push({ type: 'rol_modificat', username: entry.username, from: existing.role, to: role });
      }
      if (!existing.active && existing.deactivated_by_sync) {
        plan.toReactivate.push(existing.id);
        counts.usersReactivated++;
        plan.changes.push({ type: 'utilizator_reactivat', username: entry.username });
      }
    }

    // Conturile LDAP care au dispărut din director. Conturile locale nu intră niciodată aici.
    for (const u of users) {
      if (u.auth_source === 'ldap' && u.active && !seen.has(u.username.toLowerCase())) {
        plan.toDeactivate.push(u.id);
        counts.usersDeactivated++;
        plan.changes.push({ type: 'utilizator_dezactivat', username: u.username, reason: 'lipsește din director' });
      }
    }

    // Managerul unui departament: cel la care raportează cei mai mulți oameni din departament.
    const byDn = new Map(accepted.map((e) => [normalizeDn(e.dn), e]));
    const votes = new Map<string, Map<string, number>>();
    for (const entry of accepted) {
      if (!entry.department || !entry.managerDn) continue;
      const manager = byDn.get(normalizeDn(entry.managerDn));
      if (!manager) { counts.managersUnresolved++; continue; }
      if (manager.username === entry.username) continue;
      const key = deptKey(entry.department);
      const tally = votes.get(key) ?? new Map<string, number>();
      tally.set(manager.username, (tally.get(manager.username) ?? 0) + 1);
      votes.set(key, tally);
    }
    const entryByUsername = new Map(accepted.map((e) => [e.username, e]));
    for (const [department, tally] of votes) {
      const ranked = [...tally.entries()].sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        // La egalitate are prioritate managerul din același departament.
        const inA = deptKey(entryByUsername.get(a[0])?.department ?? '') === department ? 0 : 1;
        const inB = deptKey(entryByUsername.get(b[0])?.department ?? '') === department ? 0 : 1;
        return inA - inB || a[0].localeCompare(b[0]);
      });
      const username = ranked[0][0];
      const deptId = departmentByKey.get(department);
      const currentManagerId = deptId === undefined ? null : managerByDept.get(deptId) ?? null;
      const managerRow = byUsername.get(username);
      if (managerRow && managerRow.id === currentManagerId) continue;
      plan.managers.push({ department, username });
      counts.managersSet++;
      const label = accepted.find((e) => deptKey(e.department ?? '') === department)?.department ?? department;
      plan.changes.push({ type: 'manager_departament', department: label, username });
    }

    const activeLdap = users.filter((u) => u.auth_source === 'ldap' && u.active).length;
    const gone = plan.toDeactivate.length;
    if (gone >= MIN_DEACTIVATIONS_FOR_THRESHOLD && activeLdap > 0 && (gone * 100) / activeLdap > cfg.maxDeactivatePercent) {
      plan.blocked = `Sincronizarea ar dezactiva ${gone} din ${activeLdap} conturi LDAP active, peste pragul de ${cfg.maxDeactivatePercent}%. Verificați LDAP_BASE_DN și filtrul înainte de a confirma.`;
    }
    return plan;
  }

  private async apply(c: Queryable, plan: Plan) {
    for (const name of plan.departmentsToCreate) {
      const id = (await c.query('INSERT INTO departments (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
      plan.departmentByKey.set(deptKey(name), id);
    }
    for (const entry of plan.toCreate) {
      await c.query(
        `INSERT INTO users (username, full_name, email, password_hash, role, department_id, job_title, auth_source, ldap_dn)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'ldap',$8)`,
        [entry.username, entry.fullName, entry.email, NO_LOCAL_PASSWORD, entry.role,
          entry.department ? plan.departmentByKey.get(deptKey(entry.department)) ?? null : null, entry.jobTitle, entry.dn]);
    }
    for (const update of plan.toUpdate) {
      const { __department: department, ...values } = update.values;
      if (department) values.department_id = plan.departmentByKey.get(department as string) ?? null;
      const cols = Object.keys(values);
      if (!cols.length) continue;
      await c.query(`UPDATE users SET ${cols.map((col, i) => `${col} = $${i + 2}`).join(', ')} WHERE id = $1`, [update.id, ...cols.map((col) => values[col])]);
    }
    if (plan.toDeactivate.length) {
      await c.query('UPDATE users SET active = false, deactivated_by_sync = true WHERE id = ANY($1)', [plan.toDeactivate]);
      await c.query('DELETE FROM sessions WHERE user_id = ANY($1)', [plan.toDeactivate]);
    }
    if (plan.toReactivate.length) await c.query('UPDATE users SET active = true, deactivated_by_sync = false WHERE id = ANY($1)', [plan.toReactivate]);
    for (const m of plan.managers) {
      await c.query('UPDATE departments SET manager_id = (SELECT id FROM users WHERE lower(username) = $2) WHERE id = $1',
        [plan.departmentByKey.get(m.department), m.username]);
    }
  }

  async run(actor: CurrentUser | null, options: { dryRun: boolean; force?: boolean }): Promise<SyncResult> {
    const cfg = this.ldap.config;
    if (!cfg) return fail(409, 'LDAP nu este configurat');
    let directory: DirectoryEntry[];
    try {
      directory = await this.ldap.listUsers();
    } catch (err) {
      if (!(err instanceof LdapUnavailableError)) throw err;
      this.log.error(`Sincronizare: ${err.message}`);
      return fail(502, 'Directorul LDAP nu poate fi interogat');
    }
    // Un rezultat gol vine aproape sigur dintr-o configurație greșită, nu dintr-o organizație fără angajați.
    if (directory.length === 0) return conflict('Directorul nu a întors niciun utilizator. Nu se modifică nimic.');

    if (options.dryRun) {
      const plan = await this.plan(this.db, cfg, directory);
      return { dryRun: true, applied: false, counts: plan.counts, changes: plan.changes, blocked: plan.blocked, finishedAt: new Date().toISOString() };
    }
    return this.db.tx(async (c) => {
      const locked = (await c.query('SELECT pg_try_advisory_xact_lock(727010) AS ok')).rows[0].ok;
      if (!locked) conflict('O altă sincronizare este în curs');
      // Aceeași blocare ca la modificările din administrare care pot lăsa aplicația fără administrator.
      await c.query('SELECT pg_advisory_xact_lock(727002)');
      const plan = await this.plan(c, cfg, directory);
      if (plan.blocked && !options.force) conflict(plan.blocked);
      await this.apply(c, plan);
      const admins = (await c.query(
        `SELECT count(*)::int AS n FROM users u LEFT JOIN user_permissions p ON p.user_id = u.id AND p.permission = 'users_admin'
         WHERE u.active AND u.role = 'admin' AND coalesce(p.allowed, true)`)).rows[0].n;
      if (admins === 0) conflict('Sincronizarea ar lăsa aplicația fără administrator activ. Nu s-a modificat nimic.');
      const finishedAt = new Date().toISOString();
      const summary = { at: finishedAt, counts: plan.counts, by: actor?.username ?? 'sistem' };
      await c.query(`INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [SETTING_LAST, JSON.stringify(summary)]);
      await this.audit.log(actor, {
        action: 'ldap.sincronizare',
        details: {
          ...plan.counts, fortat: options.force === true || undefined,
          dezactivati: plan.changes.filter((x) => x.type === 'utilizator_dezactivat').slice(0, 200).map((x) => x.username),
          roluri: plan.changes.filter((x) => x.type === 'rol_modificat').slice(0, 200),
        },
      }, c);
      return { dryRun: false, applied: true, counts: plan.counts, changes: plan.changes, blocked: plan.blocked, finishedAt };
    });
  }

  /** Rularea periodică, doar în procesul serverului. Fără `force`: un rezultat suspect rămâne de confirmat de un administrator. */
  startInterval() {
    const minutes = this.ldap.config?.syncIntervalMinutes ?? 0;
    if (!minutes) return;
    this.timer = setInterval(() => {
      this.run(null, { dryRun: false }).catch((err) => this.log.error(`Sincronizarea periodică a eșuat: ${err?.response?.message ?? err.message}`));
    }, minutes * 60_000);
    this.timer.unref();
    this.log.log(`Sincronizare AD la fiecare ${minutes} minute`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}

@Controller('admin/ldap')
@UseGuards(AuthGuard)
@RequirePerm('users_admin')
export class LdapController {
  constructor(
    private readonly db: Db, private readonly audit: AuditService, private readonly auth: AuthService,
    private readonly ldap: LdapClient, private readonly sync: LdapSyncService,
  ) {}

  @Get('status')
  async status() {
    const cfg = this.ldap.config;
    const last = await this.db.one('SELECT value FROM settings WHERE key = $1', [SETTING_LAST]);
    const accounts = (await this.db.query(`SELECT auth_source AS source, count(*)::int AS n FROM users WHERE active GROUP BY 1`)).rows;
    return {
      enabled: !!cfg,
      // Fără contul de serviciu și parolă: pagina doar arată spre ce director este legată aplicația.
      url: cfg?.url ?? null,
      baseDn: cfg?.baseDn ?? null,
      tls: cfg ? cfg.url.startsWith('ldaps:') : null,
      syncIntervalMinutes: cfg?.syncIntervalMinutes ?? 0,
      groupRoleMap: cfg?.groupRoleMap ?? [],
      lastSync: last?.value ?? null,
      accounts: Object.fromEntries(accounts.map((a) => [a.source, a.n])),
    };
  }

  /** Implicit doar previzualizează; aplicarea cere `dryRun: false` explicit. */
  @Post('sync') @HttpCode(200)
  run(@User() user: CurrentUser, @Body() body: { dryRun?: unknown; force?: unknown }) {
    return this.sync.run(user, { dryRun: body?.dryRun !== false, force: body?.force === true });
  }

  /** Mutarea explicită a unui cont între local și LDAP. Sincronizarea nu face acest lucru singură. */
  @Post('users/:id/source') @HttpCode(200)
  async setSource(@User() user: CurrentUser, @Param('id') id: string, @Body() body: { source?: string; password?: string }) {
    const targetId = toInt(id);
    if (targetId === user.id) badRequest('Nu vă puteți schimba propria sursă de autentificare');
    const source = body?.source;
    if (source !== 'ldap' && source !== 'local') badRequest('Sursă de autentificare invalidă');
    let hash = NO_LOCAL_PASSWORD;
    if (source === 'local') {
      const password = typeof body.password === 'string' ? body.password : '';
      const problem = passwordProblem(password, await this.auth.policy());
      if (problem) badRequest(problem);
      hash = hashPassword(password);
    } else if (!this.ldap.enabled) {
      conflict('LDAP nu este configurat');
    }
    const target = await this.db.one('SELECT username FROM users WHERE id = $1', [targetId]);
    if (!target) notFound('Utilizator inexistent');
    let dn: string | null = null;
    if (source === 'ldap') {
      const entry = (await this.ldap.listUsers().catch(() => fail(502, 'Directorul LDAP nu poate fi interogat')))
        .find((e) => e.username === target.username.toLowerCase());
      if (!entry) conflict('Contul nu există în director');
      dn = entry!.dn;
    }
    return this.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(727002)');
      await c.query(
        `UPDATE users SET auth_source = $2, password_hash = $3, ldap_dn = $4, must_change_password = $5, password_changed_at = now(), failed_attempts = 0, locked_until = NULL WHERE id = $1`,
        [targetId, source, hash, dn, source === 'local']);
      // Administratorul local este contul de urgență: nu poate dispărea odată cu directorul.
      const locals = (await c.query(`SELECT count(*)::int AS n FROM users WHERE active AND role = 'admin' AND auth_source = 'local'`)).rows[0].n;
      if (locals === 0) conflict('Trebuie să rămână cel puțin un administrator local');
      await c.query('DELETE FROM sessions WHERE user_id = $1', [targetId]);
      await this.audit.log(user, { action: 'ldap.sursa_cont', details: { utilizator: targetId, username: target.username, sursa: source } }, c);
      return { id: targetId, authSource: source };
    });
  }
}
