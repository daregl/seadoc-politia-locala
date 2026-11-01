// Conexiunea cu directorul LDAP/AD. Fișierul nu depinde de auth.ts, ca auth.ts să îl poată folosi fără import circular.
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Client, InvalidCredentialsError, ResultCodeError } from 'ldapts';
import fs from 'node:fs';
import { Role } from './perms.js';

export interface LdapConfig {
  url: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  /** Filtrul de căutare, cu `{username}` în locul numelui de utilizator. */
  userFilter: string;
  /** Atributul din care se ia numele de utilizator la import. */
  usernameAttribute: string;
  tlsCa: string | null;
  /** Ordinea contează: se aplică primul grup din listă în care se află utilizatorul. */
  groupRoleMap: { group: string; role: Role }[];
  syncIntervalMinutes: number;
  maxDeactivatePercent: number;
}

export interface DirectoryEntry {
  dn: string;
  username: string;
  fullName: string;
  email: string | null;
  department: string | null;
  managerDn: string | null;
  jobTitle: string | null;
  disabled: boolean;
  groups: string[];
}

const VALID_ROLES: Role[] = ['admin', 'manager', 'user', 'registratura', 'arhivar'];
const ATTRIBUTE = /^[A-Za-z][A-Za-z0-9-]*$/;
const AD_FILTER = '(&(objectClass=user)(objectCategory=person)(sAMAccountName={username}))';
/** Marcaj în locul parolei pentru conturile externe; nu este un hash, deci nicio parolă nu i se potrivește. */
export const NO_LOCAL_PASSWORD = 'extern$fara-parola-locala';

/** Eroare de infrastructură: directorul nu răspunde. Nu spune nimic despre parolă și nu contează la blocarea contului. */
export class LdapUnavailableError extends Error {}

/** RFC 4515: valorile din filtre nu pot schimba structura filtrului. */
export function escapeLdapFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export function normalizeDn(dn: string): string {
  return dn.trim().replace(/\s*,\s*/g, ',').replace(/\s*=\s*/g, '=').toLowerCase();
}

export function ldapConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LdapConfig | null {
  const { LDAP_URL: url, LDAP_BIND_DN: bindDn, LDAP_BIND_PASSWORD: bindPassword, LDAP_BASE_DN: baseDn } = env;
  if (!url || !bindDn || !bindPassword || !baseDn) return null;
  const raw = (env.LDAP_USER_FILTER ?? '').trim() || 'sAMAccountName';
  let userFilter: string;
  let usernameAttribute: string;
  if (raw.includes('{username}')) {
    userFilter = raw;
    usernameAttribute = /\(([A-Za-z][A-Za-z0-9-]*)=\{username\}\)/.exec(raw)?.[1] ?? 'sAMAccountName';
  } else if (ATTRIBUTE.test(raw)) {
    userFilter = raw.toLowerCase() === 'samaccountname' ? AD_FILTER : `(${raw}={username})`;
    usernameAttribute = raw;
  } else {
    throw new Error('LDAP_USER_FILTER trebuie să fie un nume de atribut sau un filtru care conține {username}');
  }
  let groupRoleMap: LdapConfig['groupRoleMap'] = [];
  if (env.LDAP_GROUP_ROLE_MAP?.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(env.LDAP_GROUP_ROLE_MAP); } catch { throw new Error('LDAP_GROUP_ROLE_MAP nu este JSON valid'); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('LDAP_GROUP_ROLE_MAP trebuie să fie un obiect {"DN grup":"rol"}');
    groupRoleMap = Object.entries(parsed as Record<string, string>).map(([group, role]) => {
      if (!VALID_ROLES.includes(role as Role)) throw new Error(`LDAP_GROUP_ROLE_MAP: rol necunoscut „${role}”`);
      return { group: normalizeDn(group), role: role as Role };
    });
  }
  let tlsCa: string | null = null;
  if (env.LDAP_TLS_CA?.trim()) {
    tlsCa = env.LDAP_TLS_CA.includes('BEGIN CERTIFICATE') ? env.LDAP_TLS_CA : fs.readFileSync(env.LDAP_TLS_CA, 'utf8');
  }
  return {
    url, bindDn, bindPassword, baseDn, userFilter, usernameAttribute, tlsCa, groupRoleMap,
    syncIntervalMinutes: Math.max(Number(env.LDAP_SYNC_INTERVAL_MINUTES ?? 0) || 0, 0),
    maxDeactivatePercent: Math.min(Math.max(Number(env.LDAP_SYNC_MAX_DEACTIVATE_PERCENT ?? 30) || 30, 0), 100),
  };
}

/** Avertismentele de la pornire pentru configurația dată (fără parole). */
export function ldapWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const partial = ['LDAP_URL', 'LDAP_BIND_DN', 'LDAP_BIND_PASSWORD', 'LDAP_BASE_DN'].filter((k) => !env[k]);
  if (partial.length > 0 && partial.length < 4) out.push(`LDAP rămâne dezactivat: lipsesc ${partial.join(', ')}`);
  if (env.LDAP_URL) {
    let host = '';
    let protocol = '';
    try {
      const u = new URL(env.LDAP_URL);
      host = u.hostname.replace(/^\[|\]$/g, '');
      protocol = u.protocol;
    } catch {
      out.push('LDAP_URL nu este un URL valid');
    }
    if (protocol && protocol !== 'ldaps:' && !['localhost', '127.0.0.1', '::1'].includes(host)) {
      out.push(`LDAP_URL folosește ${protocol}// fără TLS către ${host}: parolele utilizatorilor circulă necriptat. Folosiți ldaps://.`);
    }
  }
  return out;
}

const list = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v)));
};
const first = (value: unknown): string | null => list(value).map((v) => v.trim()).find(Boolean) ?? null;

@Injectable()
export class LdapClient implements OnModuleInit {
  private readonly log = new Logger('LDAP');
  readonly config: LdapConfig | null = ldapConfigFromEnv();

  get enabled(): boolean { return this.config !== null; }

  onModuleInit() {
    for (const warning of ldapWarnings()) this.log.warn(warning);
  }

  private connection(cfg: LdapConfig): Client {
    return new Client({
      url: cfg.url,
      timeout: 10_000,
      connectTimeout: 5_000,
      strictDN: false,
      tlsOptions: cfg.url.startsWith('ldaps:') ? { ca: cfg.tlsCa ? [cfg.tlsCa] : undefined, rejectUnauthorized: true } : undefined,
    });
  }

  private filterFor(cfg: LdapConfig, username: string): string {
    return cfg.userFilter.replace(/\{username\}/g, () => escapeLdapFilter(username));
  }

  private toEntry(cfg: LdapConfig, raw: Record<string, unknown>): DirectoryEntry | null {
    const attrs = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
    const username = first(attrs[cfg.usernameAttribute.toLowerCase()]);
    const dn = first(attrs.dn);
    if (!username || !dn) return null;
    const control = Number(first(attrs.useraccountcontrol) ?? 0);
    return {
      dn,
      username: username.toLowerCase(),
      fullName: first(attrs.displayname) ?? first(attrs.cn) ?? username,
      email: first(attrs.mail),
      department: first(attrs.department),
      managerDn: first(attrs.manager),
      jobTitle: first(attrs.title),
      // Bitul ACCOUNTDISABLE din userAccountControl.
      disabled: Number.isInteger(control) && (control & 2) !== 0,
      groups: list(attrs.memberof).map(normalizeDn),
    };
  }

  private attributes(cfg: LdapConfig) {
    return [cfg.usernameAttribute, 'displayName', 'cn', 'mail', 'department', 'manager', 'title', 'userAccountControl', 'memberOf'];
  }

  /** Operație cu contul de serviciu. Orice eroare, inclusiv un cont de serviciu greșit, înseamnă director indisponibil. */
  private async withService<T>(cfg: LdapConfig, fn: (c: Client) => Promise<T>): Promise<T> {
    const client = this.connection(cfg);
    try {
      await client.bind(cfg.bindDn, cfg.bindPassword);
      return await fn(client);
    } catch (err) {
      throw new LdapUnavailableError((err as Error).message);
    } finally {
      await client.unbind().catch(() => {});
    }
  }

  /**
   * Verifică parola prin bind cu DN-ul utilizatorului. Parola goală este refuzată înainte de orice conexiune:
   * multe servere tratează un bind cu parolă goală drept bind anonim reușit.
   */
  async verifyPassword(username: string, password: string): Promise<boolean> {
    const cfg = this.config;
    if (!cfg) return false;
    if (password.length === 0 || password.includes('\0') || !username) return false;
    const found = await this.withService(cfg, async (c) => {
      const { searchEntries } = await c.search(cfg.baseDn, {
        scope: 'sub', filter: this.filterFor(cfg, username), attributes: this.attributes(cfg),
      });
      return searchEntries;
    });
    // Mai multe potriviri înseamnă un filtru ambiguu: nu se ghicește contul.
    if (found.length !== 1) return false;
    const entry = this.toEntry(cfg, found[0]);
    if (!entry || entry.disabled || entry.username !== username.toLowerCase()) return false;
    const client = this.connection(cfg);
    try {
      await client.bind(entry.dn, password);
      return true;
    } catch (err) {
      if (err instanceof InvalidCredentialsError) return false;
      if (err instanceof ResultCodeError) {
        this.log.warn(`Bind refuzat de server, cod ${err.code}`);
        return false;
      }
      throw new LdapUnavailableError((err as Error).message);
    } finally {
      await client.unbind().catch(() => {});
    }
  }

  /** Toți utilizatorii din director, pe pagini. O eroare oprește operația: un rezultat parțial nu se confundă cu „lipsește”. */
  async listUsers(): Promise<DirectoryEntry[]> {
    const cfg = this.config;
    if (!cfg) throw new LdapUnavailableError('LDAP nu este configurat');
    const entries = await this.withService(cfg, async (c) => (await c.search(cfg.baseDn, {
      scope: 'sub',
      filter: cfg.userFilter.replace(/\{username\}/g, '*'),
      attributes: this.attributes(cfg),
      paged: { pageSize: 500 },
    })).searchEntries);
    const out: DirectoryEntry[] = [];
    for (const raw of entries) {
      const entry = this.toEntry(cfg, raw);
      // Conturile de calculator din AD se termină cu $ și nu sunt persoane.
      if (entry && !entry.username.endsWith('$')) out.push(entry);
    }
    return out;
  }
}
