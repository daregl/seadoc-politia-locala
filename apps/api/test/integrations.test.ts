// Teste de integrare pentru LDAP/AD, OIDC, datele ERP și migrarea arhivei, pe serverul HTTP real și pe PostgreSQL.
// LDAP rulează pe un server ldapjs real în proces, cu intrări ca în AD. OIDC rulează pe un emitent mic, cu JWKS și semnături reale.
// Comenzile de migrare rulează în procese separate, exact ca în producție. Baza de test se golește la fiecare rulare.
import { generateKeyPair, exportJWK, SignJWT, type JWK, type CryptoKey as JoseKey } from 'jose';
import ldap from 'ldapjs';
import { Client as LdapTestClient } from 'ldapts';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { textPdf } from '../scripts/pdf-tools.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://seadoc@127.0.0.1:55432/seadoc_intg_test';
if (!/test/.test(new URL(databaseUrl).pathname)) throw new Error('Testele șterg baza de date: DATABASE_URL trebuie să indice o bază de test');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seadoc-intg-'));
const storageDir = path.join(scratch, 'stocare');
const STORAGE_KEY = crypto.randomBytes(32).toString('hex');
const SIGNATURE_SECRET = crypto.randomBytes(32).toString('hex');
Object.assign(process.env, {
  DATABASE_URL: databaseUrl, STORAGE_DIR: storageDir, STORAGE_KEY, SIGNATURE_SECRET,
  OCR_POLL_MS: '86400000', SCHEDULER_MS: '86400000', TRUST_PROXY: '1', COOKIE_SECURE: 'false',
});
const PASSWORD = 'Parola-Test-2026!';
const REMOTE_IP = '8.8.8.8';
const AD_PASSWORD = 'Parola-AD-pentru-test!';
const BASE_DN = 'dc=ctp,dc=test';
const SERVICE_DN = 'cn=seadoc-svc,ou=servicii,dc=ctp,dc=test';
const SERVICE_PASSWORD = 'parola-cont-serviciu';
const GROUP_ADMIN = 'CN=SeaDoc-Admin,OU=Grupuri,DC=ctp,DC=test';
const GROUP_MANAGER = 'CN=SeaDoc-Manageri,OU=Grupuri,DC=ctp,DC=test';

type Json = any;
interface Reply { status: number; body: Json; text: string; headers: Headers; location: string }

let base = '';
let apiPort = 0;
let app: Json;
let db: Json;
let ocr: Json;
let pdfText: (data: Buffer) => Promise<string[]>;

class Client {
  private jar = new Map<string, string>();
  constructor(readonly headers: Record<string, string> = {}) {}

  private absorb(res: Response) {
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(';');
      const [name, value] = pair.split('=');
      if (!value || attrs.some((a) => /max-age=0|expires=thu, 01 jan 1970/i.test(a))) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  get cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  has(name: string) { return this.jar.has(name); }
  drop(name: string) { this.jar.delete(name); }
  copyTo(other: Client) { for (const [k, v] of this.jar) other.jar.set(k, v); }

  async send(method: string, url: string, body?: BodyInit, contentType?: string): Promise<Reply> {
    const headers: Record<string, string> = { ...this.headers };
    if (this.cookie) headers.cookie = this.cookie;
    if (contentType) headers['content-type'] = contentType;
    const res = await fetch(url.startsWith('http') ? url : base + url, { method, headers, body, redirect: 'manual' });
    this.absorb(res);
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
    const parsed = (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : null;
    return { status: res.status, body: parsed, text, headers: res.headers, location: res.headers.get('location') ?? '' };
  }
  get(url: string) { return this.send('GET', url); }
  del(url: string) { return this.send('DELETE', url); }
  post(url: string, body: Json = {}) { return this.send('POST', url, JSON.stringify(body), 'application/json'); }
  patch(url: string, body: Json = {}) { return this.send('PATCH', url, JSON.stringify(body), 'application/json'); }
  upload(url: string, fields: Record<string, unknown>, file?: { name: string; data: Buffer; type?: string }) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    if (file) form.set('file', new Blob([new Uint8Array(file.data)], { type: file.type ?? 'application/octet-stream' }), file.name);
    return this.send('POST', url, form);
  }
  async bytes(url: string) {
    const res = await fetch(base + url, { headers: { ...this.headers, cookie: this.cookie } });
    return { status: res.status, data: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  }
}

const count = async (sql: string, params: unknown[] = []) => Number((await db.one(sql, params)).n);
const auditCount = (action: string) => count('SELECT count(*)::int AS n FROM audit_log WHERE action LIKE $1', [action]);

// Server LDAP de test, cu intrări ca în AD ------------------------------------

interface AdEntry { dn: string; password: string; attributes: Record<string, string | string[]> }
const directory = new Map<string, AdEntry>();
const ldapLog = { binds: [] as { dn: string; password: string }[], filters: [] as string[] };
const normalize = (dn: string) => ldap.parseDN(dn).toString().toLowerCase().replace(/\s/g, '');
function adUser(sam: string, cn: string, attrs: Record<string, string | string[]> = {}, ou = 'Angajati') {
  const dn = `CN=${cn},OU=${ou},DC=ctp,DC=test`;
  directory.set(normalize(dn), {
    dn,
    password: AD_PASSWORD,
    attributes: {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'], objectCategory: 'person',
      cn: cn.replace(/\\/g, ''), sAMAccountName: sam, displayName: cn.replace(/\\/g, ''), userAccountControl: '512', ...attrs,
    },
  });
  return dn;
}

function startLdap(options: { certificate?: string; key?: string } = {}): Promise<{ server: Json; url: string }> {
  const server = ldap.createServer(options as Json);
  server.bind('', (req: Json, res: Json, next: Json) => {
    const dn = req.dn.toString();
    const password = String(req.credentials ?? '');
    ldapLog.binds.push({ dn, password });
    // Ca multe servere reale: parola goală trece drept bind anonim reușit.
    if (password === '') { res.end(); return next(); }
    if (normalize(dn) === normalize(SERVICE_DN)) {
      if (password !== SERVICE_PASSWORD) return next(new ldap.InvalidCredentialsError());
      res.end();
      return next();
    }
    const entry = directory.get(normalize(dn));
    if (!entry || entry.password !== password) return next(new ldap.InvalidCredentialsError());
    res.end();
    return next();
  });
  server.search(BASE_DN, (req: Json, res: Json, next: Json) => {
    ldapLog.filters.push(req.filter.toString());
    res.attributes = [];
    for (const entry of directory.values()) {
      if (!req.filter.matches(entry.attributes, false)) continue;
      // ldapjs compară atributele cerute cu litere mici; AD le întoarce cu forma lor, de exemplu sAMAccountName.
      const wanted = (req.attributes as string[]).map((x) => x.toLowerCase());
      const attributes = Object.fromEntries(Object.entries(entry.attributes).filter(([k]) => !wanted.length || wanted.includes(k.toLowerCase())));
      res.send({ dn: entry.dn, attributes }, true);
    }
    res.end();
    return next();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const scheme = options.certificate ? 'ldaps' : 'ldap';
      resolve({ server, url: `${scheme}://127.0.0.1:${(server as Json).address().port}` });
    });
  });
}

// Emitent OIDC de test ---------------------------------------------------------

interface Tamper {
  signWith?: 'other' | 'none' | 'hs256'; nonce?: string; aud?: string; iss?: string; exp?: number;
  sub?: string; username?: string; email?: string; emailVerified?: boolean; amr?: string[]; acr?: string; name?: string;
}
const OIDC_CLIENT_ID = 'seadoc';
const OIDC_CLIENT_SECRET = 'secret-client-oidc-pentru-test-cu-lungime-suficienta';
const issuerState = { tamper: {} as Tamper, codes: new Map<string, Json>(), tokenCalls: 0 };
let issuerUrl = '';
let issuerServer: http.Server;
let signingKey: JoseKey;
let otherKey: JoseKey;
let publicJwk: JWK;

async function startIssuer() {
  const keys = await generateKeyPair('RS256', { extractable: true });
  signingKey = keys.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  publicJwk = { ...(await exportJWK(keys.publicKey)), kid: 'cheie-1', alg: 'RS256', use: 'sig' };
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  issuerServer = http.createServer(async (req, res) => {
    const url = new URL(req.url!, issuerUrl);
    const route = url.pathname.replace('/realms/ctp', '');
    if (route === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: issuerUrl,
        authorization_endpoint: `${issuerUrl}/authorize`,
        token_endpoint: `${issuerUrl}/token`,
        jwks_uri: `${issuerUrl}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (route === '/jwks') return json(res, 200, { keys: [publicJwk] });
    if (route === '/authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== OIDC_CLIENT_ID || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('nonce') || !q.get('state')) {
        return json(res, 400, { error: 'invalid_request' });
      }
      const code = crypto.randomBytes(16).toString('hex');
      issuerState.codes.set(code, { nonce: q.get('nonce'), challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri') });
      const back = new URL(q.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state')!);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (route === '/token') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      issuerState.tokenCalls++;
      const entry = issuerState.codes.get(form.get('code') ?? '');
      if (!entry) return json(res, 400, { error: 'invalid_grant' });
      issuerState.codes.delete(form.get('code')!);
      const basic = (req.headers.authorization ?? '').startsWith('Basic ') ? Buffer.from(req.headers.authorization!.slice(6), 'base64').toString().split(':') : [];
      const clientId = form.get('client_id') ?? decodeURIComponent(basic[0] ?? '');
      const secret = form.get('client_secret') ?? decodeURIComponent(basic[1] ?? '');
      if (clientId !== OIDC_CLIENT_ID || secret !== OIDC_CLIENT_SECRET) return json(res, 401, { error: 'invalid_client' });
      if (form.get('redirect_uri') !== entry.redirectUri) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri' });
      const challenge = crypto.createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== entry.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'pkce' });
      const t = issuerState.tamper;
      const claims: Record<string, unknown> = {
        nonce: t.nonce ?? entry.nonce,
        preferred_username: t.username,
        email: t.email,
        email_verified: t.emailVerified,
        amr: t.amr,
        acr: t.acr,
        name: t.name,
      };
      const now = Math.floor(Date.now() / 1000);
      const builder = (alg: string) => new SignJWT(claims)
        .setProtectedHeader({ alg, kid: 'cheie-1' })
        .setIssuer(t.iss ?? issuerUrl).setAudience(t.aud ?? OIDC_CLIENT_ID).setSubject(t.sub ?? 'sub-implicit')
        .setIssuedAt(now).setExpirationTime(t.exp ?? now + 300);
      let idToken: string;
      if (t.signWith === 'none') {
        const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
        idToken = `${b64({ alg: 'none' })}.${b64({ ...claims, iss: issuerUrl, aud: OIDC_CLIENT_ID, sub: t.sub ?? 'x', iat: now, exp: now + 300 })}.`;
      } else if (t.signWith === 'hs256') {
        idToken = await builder('HS256').sign(new TextEncoder().encode(OIDC_CLIENT_SECRET));
      } else {
        idToken = await builder('RS256').sign(t.signWith === 'other' ? otherKey : signingKey);
      }
      return json(res, 200, { access_token: 'token-acces', token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    return json(res, 404, {});
  });
  await new Promise<void>((resolve) => issuerServer.listen(0, '127.0.0.1', resolve));
  issuerUrl = `http://127.0.0.1:${(issuerServer.address() as net.AddressInfo).port}/realms/ctp`;
}

/** Trece prin tot traseul din browser: start → furnizor → callback. */
async function oidcFlow(client: Client, tamper: Tamper) {
  issuerState.tamper = tamper;
  const start = await client.get('/api/auth/oidc/start');
  assert.equal(start.status, 302, start.text);
  assert.ok(start.location.startsWith(issuerUrl), start.location);
  const authorize = await client.get(start.location);
  assert.equal(authorize.status, 302, authorize.text);
  const callback = await client.get(authorize.location);
  return { callback, callbackUrl: authorize.location, start };
}

// Utilitare pentru date --------------------------------------------------------

const ids: Record<string, number> = {};
let admin: Client;
let passwordHash = '';

async function addLocalUser(username: string, role: string, departmentId: number | null) {
  return (await db.one(
    `INSERT INTO users (username, full_name, password_hash, role, department_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [username, `Test ${username}`, passwordHash, role, departmentId])).id as number;
}
async function login(username: string, password = PASSWORD, headers: Record<string, string> = {}) {
  const client = new Client(headers);
  const r = await client.post('/api/auth/login', { username, password });
  assert.equal(r.status, 200, `autentificare ${username}: ${r.text}`);
  return client;
}
async function addDocument(client: Client, fields: Record<string, unknown>) {
  const title = String(fields.title ?? `Document ${crypto.randomUUID()}`);
  const data = await textPdf({ title, paragraphs: [`Conținut de test pentru documentul ${title}, cu suficient text ca să treacă de pragul de pagină.`] });
  const r = await client.upload('/api/documents', { title, documentTypeId: ids.type, ...fields }, { name: 'doc.pdf', data, type: 'application/pdf' });
  assert.equal(r.status, 201, r.text);
  return r.body as { id: number; regLabel: string | null };
}

// CLI ---------------------------------------------------------------------------

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts/migrate-archive.js');
function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      cwd: scratch,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, DATABASE_URL: databaseUrl, STORAGE_DIR: storageDir, STORAGE_KEY, SIGNATURE_SECRET, ...env },
    }, (error, out, err) => resolve({ code: error ? Number((error as Json).code ?? 1) : 0, out, err }));
  });
}
const sha = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');
function readCsv(file: string): Record<string, string>[] {
  const lines = parseCsvLines(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const [header, ...rows] = lines;
  return rows.map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] ?? ''])));
}
function parseCsvLines(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ';') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  return rows;
}

// Pornire -----------------------------------------------------------------------

let ldapMain: { server: Json; url: string };

before(async () => {
  adUser('ion.popescu', 'Ion Popescu', { department: 'Informatică', title: 'Inginer de sistem', mail: 'ion.popescu@ctp.test', manager: 'CN=Maria Ionescu,OU=Angajati,DC=ctp,DC=test' });
  adUser('maria.ionescu', 'Maria Ionescu', { department: 'Informatică', title: 'Șef serviciu', mail: 'maria.ionescu@ctp.test', manager: 'CN=Director General,OU=Angajati,DC=ctp,DC=test', memberOf: GROUP_MANAGER });
  adUser('director.general', 'Director General', { department: 'Conducere', mail: 'director@ctp.test' });
  adUser('admin.ad', 'Admin Din AD', { department: 'Informatică', memberOf: [GROUP_ADMIN, 'CN=Altul,OU=Grupuri,DC=ctp,DC=test'] });
  adUser('ana.popescu', 'Popescu\\, Ana', { department: 'Contabilitate', mail: 'ana@ctp.test' });
  adUser('dezactivat.ad', 'Cont Dezactivat', { department: 'Informatică', userAccountControl: '514' });
  adUser('admin.local', 'Omonim Administrator Local', { department: 'Informatică', memberOf: GROUP_MANAGER });
  adUser('pleaca.ad', 'Pleacă Din Companie', { department: 'Contabilitate' });
  adUser('rol.manual', 'Rol Manual', { department: 'Contabilitate' });
  directory.set('calculator', { dn: 'CN=PC01,OU=Calculatoare,DC=ctp,DC=test', password: 'x', attributes: { objectClass: ['top', 'computer', 'user'], objectCategory: 'computer', cn: 'PC01', sAMAccountName: 'pc01$', userAccountControl: '4096' } });
  directory.set('masina', { dn: 'CN=Masina,OU=Angajati,DC=ctp,DC=test', password: 'x', attributes: { objectClass: ['user'], objectCategory: 'person', cn: 'Masina', sAMAccountName: 'masina$', userAccountControl: '512' } });
  ldapMain = await startLdap();
  await startIssuer();
  const reserve = net.createServer();
  await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  apiPort = (reserve.address() as net.AddressInfo).port;
  await new Promise((resolve) => reserve.close(resolve));

  Object.assign(process.env, {
    LDAP_URL: ldapMain.url, LDAP_BIND_DN: SERVICE_DN, LDAP_BIND_PASSWORD: SERVICE_PASSWORD, LDAP_BASE_DN: BASE_DN,
    LDAP_GROUP_ROLE_MAP: JSON.stringify({ [GROUP_ADMIN]: 'admin', [GROUP_MANAGER]: 'manager' }),
    OIDC_ISSUER: issuerUrl, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI: `http://127.0.0.1:${apiPort}/api/auth/oidc/callback`,
    OIDC_LABEL: 'Intră cu contul de serviciu',
  });

  const reset = new pg.Client({ connectionString: databaseUrl });
  await reset.connect();
  await reset.query('DROP SCHEMA public CASCADE');
  await reset.query('CREATE SCHEMA public');
  await reset.end();

  const { config } = await import('../src/config.js');
  config.webDist = path.join(scratch, 'fara-web');
  const main = await import('../src/main.js');
  const { Db } = await import('../src/db.js');
  const { OcrService, pdfText: extract } = await import('../src/ocr.js');
  const { hashPassword } = await import('../src/auth.js');
  pdfText = extract;
  passwordHash = hashPassword(PASSWORD);
  app = await main.createApp({ logger: ['error'] });
  db = app.get(Db);
  ocr = app.get(OcrService);
  await app.listen(apiPort, '127.0.0.1');
  base = `http://127.0.0.1:${apiPort}`;

  ids.alpha = (await db.one(`INSERT INTO departments (name) VALUES ('Alpha') RETURNING id`)).id;
  ids.beta = (await db.one(`INSERT INTO departments (name) VALUES ('Beta') RETURNING id`)).id;
  ids.type = (await db.one(
    `INSERT INTO document_types (name, nomenclator_code, retention_years, fields) VALUES ('Contract','C-1',10,$1) RETURNING id`,
    [JSON.stringify([{ key: 'partener', label: 'Partener', type: 'text', required: false }])])).id;
  ids.general = (await db.one(`INSERT INTO document_types (name, nomenclator_code, retention_years) VALUES ('Corespondență','C-2',5) RETURNING id`)).id;
  ids.register = (await db.one(`INSERT INTO registers (name, code) VALUES ('Registru contracte','RC') RETURNING id`)).id;
  ids.adminLocal = await addLocalUser('admin.local', 'admin', ids.alpha);
  ids.managerAlpha = await addLocalUser('manager.alpha', 'manager', ids.alpha);
  ids.managerBeta = await addLocalUser('manager.beta', 'manager', ids.beta);
  ids.userAlpha = await addLocalUser('user.alpha', 'user', ids.alpha);
  admin = await login('admin.local');
});

after(async () => {
  await app?.close();
  ldapMain?.server.close();
  issuerServer?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

// LDAP ---------------------------------------------------------------------------

describe('LDAP: configurare și filtre', () => {
  test('fără configurație, LDAP este dezactivat; o configurație parțială primește avertisment', async () => {
    const { ldapConfigFromEnv, ldapWarnings } = await import('../src/ldap-client.js');
    assert.equal(ldapConfigFromEnv({}), null);
    assert.equal(ldapConfigFromEnv({ LDAP_URL: 'ldaps://ad', LDAP_BASE_DN: 'dc=x' }), null);
    assert.equal(ldapWarnings({}).length, 0);
    assert.match(ldapWarnings({ LDAP_URL: 'ldaps://ad' })[0], /lipsesc/);
  });

  test('ldap:// necriptat în afara mașinii locale produce avertisment; ldaps:// și localhost nu', async () => {
    const { ldapWarnings } = await import('../src/ldap-client.js');
    const full = { LDAP_BIND_DN: 'a', LDAP_BIND_PASSWORD: 'b', LDAP_BASE_DN: 'c' };
    assert.match(ldapWarnings({ ...full, LDAP_URL: 'ldap://ad.ctp.ro:389' })[0], /fără TLS/);
    assert.deepEqual(ldapWarnings({ ...full, LDAP_URL: 'ldaps://ad.ctp.ro' }), []);
    assert.deepEqual(ldapWarnings({ ...full, LDAP_URL: 'ldap://127.0.0.1:389' }), []);
    assert.deepEqual(ldapWarnings({ ...full, LDAP_URL: 'ldap://localhost:389' }), []);
  });

  test('valorile din filtru se escapează după RFC 4515', async () => {
    const { escapeLdapFilter } = await import('../src/ldap-client.js');
    assert.equal(escapeLdapFilter('a*b(c)d\\e\0'), 'a\\2ab\\28c\\29d\\5ce\\00');
    assert.equal(escapeLdapFilter('ion.popescu'), 'ion.popescu');
  });

  test('un rol necunoscut în LDAP_GROUP_ROLE_MAP oprește pornirea, nu este ignorat', async () => {
    const { ldapConfigFromEnv } = await import('../src/ldap-client.js');
    assert.throws(() => ldapConfigFromEnv({ LDAP_URL: 'ldap://x', LDAP_BIND_DN: 'a', LDAP_BIND_PASSWORD: 'b', LDAP_BASE_DN: 'c', LDAP_GROUP_ROLE_MAP: '{"cn=g":"superadmin"}' }), /rol necunoscut/);
  });
});

describe('LDAP: sincronizare AD', () => {
  test('previzualizarea raportează schimbările și nu modifică nimic', async () => {
    const snapshot = async () => [
      await db.one(`SELECT count(*)::int AS n, max(id) AS m, md5(string_agg(username || role || active::text, ',' ORDER BY id)) AS h FROM users`),
      await db.one(`SELECT count(*)::int AS n, md5(string_agg(name || coalesce(manager_id::text,''), ',' ORDER BY id)) AS h FROM departments`),
      await db.one(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'ldap.%'`),
      await db.one(`SELECT count(*)::int AS n FROM settings`),
    ];
    const beforeState = await snapshot();
    const r = await admin.post('/api/admin/ldap/sync', {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.dryRun, true, 'fără dryRun:false se face doar previzualizare');
    assert.equal(r.body.applied, false);
    assert.equal(r.body.counts.usersCreated, 7);
    assert.equal(r.body.counts.departmentsCreated, 3);
    assert.ok(r.body.changes.some((c: Json) => c.type === 'utilizator_nou' && c.username === 'maria.ionescu' && c.to === 'manager'));
    assert.deepEqual(await snapshot(), beforeState);
  });

  test('aplicarea importă utilizatori, departamente și manageri; raportează numărătorile', async () => {
    const r = await admin.post('/api/admin/ldap/sync', { dryRun: false });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.applied, true);
    const c = r.body.counts;
    assert.equal(c.usersCreated, 7);
    assert.equal(c.departmentsCreated, 3);
    assert.equal(c.localConflicts, 1, 'contul local cu același nume nu este preluat');
    assert.equal(c.usersDeactivated, 0);

    const maria = await db.one(`SELECT u.*, d.name AS dep FROM users u JOIN departments d ON d.id = u.department_id WHERE username = 'maria.ionescu'`);
    assert.equal(maria.auth_source, 'ldap');
    assert.equal(maria.role, 'manager', 'rolul vine din maparea grupului');
    assert.equal(maria.dep, 'Informatică');
    assert.equal(maria.job_title, 'Șef serviciu');
    assert.equal(maria.email, 'maria.ionescu@ctp.test');
    assert.doesNotMatch(maria.password_hash, /^scrypt/, 'contul LDAP nu are hash de parolă');
    assert.equal((await db.one(`SELECT role FROM users WHERE username = 'admin.ad'`)).role, 'admin');
    assert.equal((await db.one(`SELECT role FROM users WHERE username = 'ion.popescu'`)).role, 'user');
    assert.match((await db.one(`SELECT ldap_dn FROM users WHERE username = 'ana.popescu'`)).ldap_dn, /popescu(\\,|\\2c) ?ana/i, 'virgula din nume rămâne escapată în DN');

    // Managerul departamentului este cel la care raportează angajații lui.
    const dep = await db.one(`SELECT u.username FROM departments d JOIN users u ON u.id = d.manager_id WHERE d.name = 'Informatică'`);
    assert.equal(dep.username, 'maria.ionescu');

    assert.equal(await count(`SELECT count(*)::int AS n FROM users WHERE username = 'dezactivat.ad'`), 0, 'conturile dezactivate nu se importă');
    assert.equal(await count(`SELECT count(*)::int AS n FROM users WHERE username LIKE '%$%'`), 0, 'conturile de calculator nu se importă');
    const local = await db.one(`SELECT auth_source, role, active, password_hash FROM users WHERE id = $1`, [ids.adminLocal]);
    assert.deepEqual([local.auth_source, local.role, local.active, local.password_hash], ['local', 'admin', true, passwordHash]);
    assert.ok((await auditCount('ldap.sincronizare')) === 1);

    const second = await admin.post('/api/admin/ldap/sync', { dryRun: false });
    assert.deepEqual([second.body.counts.usersCreated, second.body.counts.usersUpdated, second.body.counts.departmentsCreated, second.body.counts.managersSet], [0, 0, 0, 0], 'a doua rulare nu mai schimbă nimic');
  });

  test('neadministratorii nu pot sincroniza', async () => {
    const user = await login('user.alpha');
    assert.equal((await user.post('/api/admin/ldap/sync', {})).status, 403);
    assert.equal((await user.get('/api/admin/ldap/status')).status, 403);
  });

  test('un rol setat manual rămâne când nu se aplică nicio mapare; maparea îl înlocuiește când se aplică', async () => {
    await db.query(`UPDATE users SET role = 'registratura' WHERE username IN ('rol.manual', 'maria.ionescu')`);
    const r = await admin.post('/api/admin/ldap/sync', { dryRun: false });
    assert.equal(r.status, 200, r.text);
    assert.equal((await db.one(`SELECT role FROM users WHERE username = 'rol.manual'`)).role, 'registratura');
    assert.equal((await db.one(`SELECT role FROM users WHERE username = 'maria.ionescu'`)).role, 'manager');
    assert.equal(r.body.counts.rolesChanged, 1);
  });

  test('conturile dezactivate sau dispărute din AD se dezactivează; administratorii locali niciodată; sesiunile se închid', async () => {
    const pleaca = await login('pleaca.ad', AD_PASSWORD);
    assert.equal((await pleaca.get('/api/auth/me')).status, 200);
    const ana = directory.get(normalize('CN=Popescu\\, Ana,OU=Angajati,DC=ctp,DC=test'))!;
    ana.attributes.userAccountControl = '66050'; // 66048 + bitul 2
    const removed = directory.get(normalize('CN=Pleacă Din Companie,OU=Angajati,DC=ctp,DC=test'))!;
    directory.delete(normalize(removed.dn));
    // Administratorul local nu apare în director sub alt nume decât omonimul, iar un alt administrator local lipsește cu totul.
    const extraAdmin = await addLocalUser('admin.urgenta', 'admin', null);

    const preview = await admin.post('/api/admin/ldap/sync', {});
    assert.equal(preview.body.counts.usersDeactivated, 2);
    assert.equal((await db.one(`SELECT active FROM users WHERE username = 'pleaca.ad'`)).active, true, 'previzualizarea nu dezactivează');

    const r = await admin.post('/api/admin/ldap/sync', { dryRun: false });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.counts.usersDeactivated, 2);
    assert.equal((await db.one(`SELECT active FROM users WHERE username = 'ana.popescu'`)).active, false);
    assert.equal((await db.one(`SELECT active FROM users WHERE username = 'pleaca.ad'`)).active, false);
    assert.equal((await db.one(`SELECT active FROM users WHERE id = $1`, [extraAdmin])).active, true, 'administrator local absent din AD');
    assert.equal((await db.one(`SELECT active FROM users WHERE id = $1`, [ids.adminLocal])).active, true);
    assert.equal((await pleaca.get('/api/auth/me')).status, 401, 'sesiunea deschisă nu mai este valabilă');

    // Revenirea în AD reactivează doar ce a dezactivat sincronizarea.
    ana.attributes.userAccountControl = '512';
    const back = await admin.post('/api/admin/ldap/sync', { dryRun: false });
    assert.equal(back.body.counts.usersReactivated, 1);
    assert.equal((await db.one(`SELECT active FROM users WHERE username = 'ana.popescu'`)).active, true);

    // O dezactivare decisă de administrator nu se anulează la sincronizare.
    const anaRow = await db.one(`SELECT id FROM users WHERE username = 'ana.popescu'`);
    assert.equal((await admin.patch(`/api/admin/users/${anaRow.id}`, { active: false })).status, 200);
    const third = await admin.post('/api/admin/ldap/sync', { dryRun: false });
    assert.equal(third.body.counts.usersReactivated, 0);
    assert.equal((await db.one(`SELECT active FROM users WHERE id = $1`, [anaRow.id])).active, false);
    await admin.patch(`/api/admin/users/${anaRow.id}`, { active: true });
  });

  test('un director gol sau o pierdere masivă nu dezactivează pe nimeni fără confirmare', async () => {
    const saved = [...directory.entries()];
    directory.clear();
    const empty = await admin.post('/api/admin/ldap/sync', { dryRun: false });
    assert.equal(empty.status, 409);
    assert.match(empty.body.message, /niciun utilizator/);
    const forced = await admin.post('/api/admin/ldap/sync', { dryRun: false, force: true });
    assert.equal(forced.status, 409, 'nici confirmarea nu trece peste un director gol');
    for (const [k, v] of saved) directory.set(k, v);

    for (let i = 0; i < 8; i++) {
      await db.query(`INSERT INTO users (username, full_name, password_hash, role, auth_source) VALUES ($1,'Masiv','extern$x','user','ldap')`, [`masiv.${i}`]);
    }
    const preview = await admin.post('/api/admin/ldap/sync', {});
    assert.ok(preview.body.blocked, 'previzualizarea avertizează');
    const refused = await admin.post('/api/admin/ldap/sync', { dryRun: false });
    assert.equal(refused.status, 409);
    assert.equal(await count(`SELECT count(*)::int AS n FROM users WHERE username LIKE 'masiv.%' AND active`), 8);
    const confirmed = await admin.post('/api/admin/ldap/sync', { dryRun: false, force: true });
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(await count(`SELECT count(*)::int AS n FROM users WHERE username LIKE 'masiv.%' AND active`), 0);
  });

  test('sincronizarea nu poate lăsa aplicația fără administrator', async () => {
    await db.query(`UPDATE users SET active = false WHERE role = 'admin' AND auth_source = 'local'`);
    await db.query(`UPDATE users SET role = 'admin' WHERE username = 'ion.popescu'`);
    const adEntry = directory.get(normalize('CN=Ion Popescu,OU=Angajati,DC=ctp,DC=test'))!;
    const adAdmin = directory.get(normalize('CN=Admin Din AD,OU=Angajati,DC=ctp,DC=test'))!;
    const previous = [adEntry.attributes.userAccountControl, adAdmin.attributes.userAccountControl];
    adEntry.attributes.userAccountControl = '514';
    adAdmin.attributes.userAccountControl = '514';
    // Sesiunea administratorului local nu mai merge: sincronizarea rulează direct, ca la pornirea periodică.
    const { LdapSyncService } = await import('../src/ldap.js');
    await assert.rejects(() => app.get(LdapSyncService).run(null, { dryRun: false }), /fără administrator|HttpException/);
    assert.equal((await db.one(`SELECT active FROM users WHERE username = 'ion.popescu'`)).active, true, 'tranzacția s-a anulat');
    adEntry.attributes.userAccountControl = previous[0];
    adAdmin.attributes.userAccountControl = previous[1];
    await db.query(`UPDATE users SET role = 'user' WHERE username = 'ion.popescu'`);
    await db.query(`UPDATE users SET active = true WHERE role = 'admin' AND auth_source = 'local'`);
    admin = await login('admin.local');
  });
});

describe('LDAP: rulare periodică', () => {
  test('intervalul rulează sincronizarea, dar nu trece peste o pierdere masivă', async () => {
    const { LdapClient } = await import('../src/ldap-client.js');
    const { LdapSyncService } = await import('../src/ldap.js');
    const service = app.get(LdapSyncService);
    const config = app.get(LdapClient).config;
    assert.equal(config.syncIntervalMinutes, 0, 'implicit doar la cerere');
    const before_ = await auditCount('ldap.sincronizare');
    config.syncIntervalMinutes = 0.002;
    try {
      service.startInterval();
      for (let i = 0; i < 100 && (await auditCount('ldap.sincronizare')) === before_; i++) await new Promise((r) => setTimeout(r, 50));
    } finally {
      service.onModuleDestroy();
      config.syncIntervalMinutes = 0;
    }
    assert.ok((await auditCount('ldap.sincronizare')) > before_);
    await new Promise((r) => setTimeout(r, 300));
    const last = (await db.one(`SELECT username FROM audit_log WHERE action = 'ldap.sincronizare' ORDER BY seq DESC LIMIT 1`));
    assert.equal(last.username, 'sistem');
  });
});

describe('LDAP: autentificare', () => {
  test('parola corectă din AD deschide sesiunea, parola nu se stochează', async () => {
    const hashBefore = (await db.one(`SELECT password_hash FROM users WHERE username = 'ion.popescu'`)).password_hash;
    const client = new Client();
    const r = await client.post('/api/auth/login', { username: 'Ion.Popescu', password: AD_PASSWORD });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.state, 'ok');
    assert.equal(r.body.user.authSource, 'ldap');
    assert.equal((await client.get('/api/auth/me')).body.user.username, 'ion.popescu');
    const row = await db.one(`SELECT password_hash FROM users WHERE username = 'ion.popescu'`);
    assert.equal(row.password_hash, hashBefore);
    assert.ok(!row.password_hash.includes(AD_PASSWORD));
    assert.ok(ldapLog.binds.some((b) => b.dn.toLowerCase().includes('ion popescu') && b.password === AD_PASSWORD), 'autentificarea trece prin bind cu DN-ul utilizatorului');
  });

  test('DN-ul cu virgulă escapată se autentifică', async () => {
    await login('ana.popescu', AD_PASSWORD);
  });

  test('parola greșită și utilizatorul inexistent primesc exact același răspuns', async () => {
    const wrong = await new Client().post('/api/auth/login', { username: 'ion.popescu', password: 'gresita' });
    const unknown = await new Client().post('/api/auth/login', { username: 'nimeni.nicaieri', password: 'gresita' });
    const wrongLocal = await new Client().post('/api/auth/login', { username: 'user.alpha', password: 'gresita' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
    assert.deepEqual(wrong.body, wrongLocal.body);
    await db.query(`UPDATE users SET failed_attempts = 0 WHERE username IN ('ion.popescu','user.alpha')`);
  });

  test('parola goală este refuzată fără bind, deși serverul ar accepta-o', async () => {
    // Serverul de test se comportă ca serverele reale: parola goală trece drept bind anonim reușit.
    const raw = new LdapTestClient({ url: ldapMain.url, strictDN: false });
    await raw.bind('CN=Ion Popescu,OU=Angajati,DC=ctp,DC=test', '');
    await raw.unbind();

    const before_ = ldapLog.binds.length;
    for (const body of [{ username: 'ion.popescu', password: '' }, { username: 'ion.popescu' }, { username: 'ion.popescu', password: [] }, { username: 'ion.popescu', password: null }]) {
      const client = new Client();
      const r = await client.post('/api/auth/login', body);
      assert.equal(r.status, 401, JSON.stringify(body));
      assert.equal(client.has('seadoc_session'), false);
    }
    const nul = await new Client().post('/api/auth/login', { username: 'ion.popescu', password: '\0' });
    assert.equal(nul.status, 401);
    assert.equal(ldapLog.binds.length, before_, 'parola goală nu ajunge la server');
    await db.query(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = 'ion.popescu'`);
  });

  test('injecția în filtru nu schimbă căutarea', async () => {
    // Fără rând în aplicație, cererea nici nu ajunge la director.
    const searches = ldapLog.filters.length;
    const direct = await new Client().post('/api/auth/login', { username: '*', password: AD_PASSWORD });
    assert.equal(direct.status, 401);
    assert.equal(ldapLog.filters.length, searches);

    // Cu un cont LDAP al cărui nume conține metacaractere, filtrul primește valoarea doar ca text.
    for (const evil of ['*', 'ion.popescu)(objectclass=*', '*)(samaccountname=ion.popescu', 'x*)(|(samaccountname=*']) {
      await db.query(`INSERT INTO users (username, full_name, password_hash, role, auth_source) VALUES ($1,'Rău','extern$x','user','ldap')`, [evil]);
      const seen = ldapLog.filters.length;
      const r = await new Client().post('/api/auth/login', { username: evil, password: AD_PASSWORD });
      assert.equal(r.status, 401, `numele ${evil} nu trebuie să se potrivească`);
      const filter = ldapLog.filters.at(-1)!;
      assert.equal(ldapLog.filters.length, seen + 1);
      assert.ok(!/\(samaccountname=ion\.popescu\)/i.test(filter), filter);
      assert.ok(/\\2a|\\28/.test(filter), `metacaracterele sunt escapate: ${filter}`);
      await db.query(`DELETE FROM users WHERE username = $1`, [evil]);
    }
  });

  test('blocarea existentă se aplică și directorul nu mai este întrebat cât timp contul e blocat', async () => {
    const policy = (await db.one(`SELECT value FROM settings WHERE key = 'password_policy'`)).value;
    for (let i = 0; i < policy.maxFailedAttempts; i++) {
      const r = await new Client().post('/api/auth/login', { username: 'ion.popescu', password: 'gresita' });
      assert.equal(r.status, 401);
    }
    assert.ok(await auditCount('auth.cont_blocat') >= 1);
    const binds = ldapLog.binds.length;
    const locked = await new Client().post('/api/auth/login', { username: 'ion.popescu', password: AD_PASSWORD });
    assert.equal(locked.status, 423);
    assert.equal(ldapLog.binds.length, binds, 'un cont blocat nu generează bind-uri, care ar bloca și contul din AD');
    await db.query(`UPDATE users SET locked_until = NULL, failed_attempts = 0 WHERE username = 'ion.popescu'`);
    assert.equal((await new Client().post('/api/auth/login', { username: 'ion.popescu', password: AD_PASSWORD })).status, 200);
  });

  test('accesul din afara rețelei cere MFA și pentru conturile LDAP', async () => {
    const client = new Client({ 'x-forwarded-for': REMOTE_IP });
    const r = await client.post('/api/auth/login', { username: 'ion.popescu', password: AD_PASSWORD });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.state, 'mfa_enrol');
    assert.equal((await client.get('/api/documents')).status, 401);
  });

  test('schimbarea parolei și expirarea nu se aplică; resetarea de administrator este refuzată', async () => {
    const client = await login('ion.popescu', AD_PASSWORD);
    const change = await client.post('/api/auth/password', { current: AD_PASSWORD, next: 'Alta-Parola-2026!' });
    assert.equal(change.status, 409);
    assert.match(change.body.message, /director/);
    await db.query(`UPDATE users SET password_changed_at = now() - interval '10 years' WHERE username = 'ion.popescu'`);
    const old = await new Client().post('/api/auth/login', { username: 'ion.popescu', password: AD_PASSWORD });
    assert.equal(old.body.state, 'ok', 'parola din AD nu expiră aici');
    const id = (await db.one(`SELECT id FROM users WHERE username = 'ion.popescu'`)).id;
    const reset = await admin.patch(`/api/admin/users/${id}`, { password: 'Alta-Parola-2026!' });
    assert.equal(reset.status, 409);
    assert.doesNotMatch((await db.one(`SELECT password_hash FROM users WHERE id = $1`, [id])).password_hash, /^scrypt/);
  });

  test('contul LDAP confirmă semnătura internă cu parola din director', async () => {
    const { DocumentsService } = await import('../src/documents.js');
    const { AuthService } = await import('../src/auth.js');
    const row = await db.one(`SELECT id FROM users WHERE username = 'maria.ionescu'`);
    const manager = await login('maria.ionescu', AD_PASSWORD);
    const doc = await addDocument(manager, { title: 'Pentru semnare LDAP', departmentId: (await db.one(`SELECT department_id FROM users WHERE id = $1`, [row.id])).department_id });
    const current = await app.get(AuthService).loadUser(row.id, '127.0.0.1');
    await assert.rejects(() => app.get(DocumentsService).signInternal(current, doc.id, 'gresita'), /HttpException|incorectă/);
    const signature = await app.get(DocumentsService).signInternal(current, doc.id, AD_PASSWORD);
    assert.ok(signature.id);
  });

  test('un cont poate trece explicit între local și LDAP, iar conturile locale merg în continuare', async () => {
    await addLocalUser('local.apoi.ad', 'user', ids.alpha);
    adUser('local.apoi.ad', 'Local Apoi AD', { department: 'Informatică' });
    const id = (await db.one(`SELECT id FROM users WHERE username = 'local.apoi.ad'`)).id;
    const before_ = await login('local.apoi.ad');
    assert.equal((await admin.post(`/api/admin/ldap/users/${ids.adminLocal}/source`, { source: 'ldap' })).status, 400, 'nu pe contul propriu');
    assert.equal((await admin.post(`/api/admin/ldap/users/${id}/source`, { source: 'ldap' })).status, 200);
    assert.equal((await before_.get('/api/auth/me')).status, 401, 'sesiunile vechi se închid');
    assert.equal((await new Client().post('/api/auth/login', { username: 'local.apoi.ad', password: PASSWORD })).status, 401, 'parola locală nu mai merge');
    await login('local.apoi.ad', AD_PASSWORD);
    const back = await admin.post(`/api/admin/ldap/users/${id}/source`, { source: 'local', password: 'Parola-Noua-2026!' });
    assert.equal(back.status, 200, back.text);
    const client = await login('local.apoi.ad', 'Parola-Noua-2026!');
    assert.equal((await client.get('/api/auth/me')).body.state, 'change_password');
    directory.delete(normalize('CN=Local Apoi AD,OU=Angajati,DC=ctp,DC=test'));
    await db.query(`UPDATE users SET active = false WHERE id = $1`, [id]);
  });

  test('ldaps:// verifică certificatul față de LDAP_TLS_CA', async () => {
    const dir = path.join(scratch, 'tls');
    fs.mkdirSync(dir);
    const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { cwd: dir });
    assert.equal(made.status, 0, String(made.stderr));
    const certificate = fs.readFileSync(path.join(dir, 'c.pem'), 'utf8');
    const secure = await startLdap({ certificate, key: fs.readFileSync(path.join(dir, 'k.pem'), 'utf8') });
    const { LdapClient, LdapUnavailableError } = await import('../src/ldap-client.js');
    const saved = { LDAP_URL: process.env.LDAP_URL, LDAP_TLS_CA: process.env.LDAP_TLS_CA };
    try {
      process.env.LDAP_URL = secure.url;
      process.env.LDAP_TLS_CA = path.join(dir, 'c.pem');
      assert.equal(await new LdapClient().verifyPassword('ion.popescu', AD_PASSWORD), true);
      assert.equal(await new LdapClient().verifyPassword('ion.popescu', 'gresita'), false);
      delete process.env.LDAP_TLS_CA;
      await assert.rejects(() => new LdapClient().verifyPassword('ion.popescu', AD_PASSWORD), LdapUnavailableError, 'certificat neverificabil = refuz');
    } finally {
      process.env.LDAP_URL = saved.LDAP_URL;
      if (saved.LDAP_TLS_CA) process.env.LDAP_TLS_CA = saved.LDAP_TLS_CA;
      secure.server.close();
    }
  });

  test('directorul oprit nu blochează conturi; administratorul local intră în continuare', async () => {
    const { LdapClient } = await import('../src/ldap-client.js');
    const client = app.get(LdapClient);
    const original = client.config.url;
    client.config.url = 'ldap://127.0.0.1:1';
    try {
      const before_ = (await db.one(`SELECT failed_attempts FROM users WHERE username = 'ion.popescu'`)).failed_attempts;
      const down = await new Client().post('/api/auth/login', { username: 'ion.popescu', password: 'oricare' });
      assert.equal(down.status, 503);
      assert.equal((await db.one(`SELECT failed_attempts FROM users WHERE username = 'ion.popescu'`)).failed_attempts, before_);
      await login('admin.local');
      const sync = await admin.post('/api/admin/ldap/sync', { dryRun: false });
      assert.equal(sync.status, 502, 'o eroare de citire nu se confundă cu dispariția utilizatorilor');
      assert.equal((await db.one(`SELECT active FROM users WHERE username = 'ion.popescu'`)).active, true);
    } finally {
      client.config.url = original;
    }
  });

  test('un cont de serviciu greșit nu contează drept parolă greșită', async () => {
    const { LdapClient } = await import('../src/ldap-client.js');
    const client = app.get(LdapClient);
    const original = client.config.bindPassword;
    client.config.bindPassword = 'alta-parola';
    try {
      assert.equal((await new Client().post('/api/auth/login', { username: 'ion.popescu', password: AD_PASSWORD })).status, 503);
    } finally {
      client.config.bindPassword = original;
    }
  });
});

// OIDC --------------------------------------------------------------------------

describe('OIDC', () => {
  const assertRefused = async (client: Client, callback: Reply) => {
    assert.equal(callback.status, 302);
    assert.match(callback.location, /^\/autentificare\?sso=/);
    assert.equal(client.has('seadoc_session'), false, 'fără sesiune');
    assert.equal((await client.get('/api/auth/me')).status, 401);
  };

  test('butonul apare doar dacă OIDC este configurat', async () => {
    const r = await new Client().get('/api/auth/sso');
    assert.deepEqual(r.body, { oidc: true, label: 'Intră cu contul de serviciu' });
    const { oidcConfigFromEnv } = await import('../src/oidc.js');
    assert.equal(oidcConfigFromEnv({}), null);
    assert.throws(() => oidcConfigFromEnv({ OIDC_ISSUER: 'http://idp.ctp.ro', OIDC_CLIENT_ID: 'a', OIDC_CLIENT_SECRET: 'b', OIDC_REDIRECT_URI: 'https://x/' }), /https/);
  });

  test('traseul reușit: cod + PKCE, state, nonce, semnătură verificată', async () => {
    const client = new Client();
    const { callback, start } = await oidcFlow(client, { sub: 'sub-maria', username: 'maria.ionescu' });
    const url = new URL(start.location);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('state') && url.searchParams.get('nonce'));
    assert.equal(url.searchParams.get('redirect_uri'), `${base}/api/auth/oidc/callback`);
    assert.equal(callback.status, 302, callback.text);
    assert.equal(callback.location, '/panou');
    const me = await client.get('/api/auth/me');
    assert.equal(me.body.state, 'ok');
    assert.equal(me.body.user.username, 'maria.ionescu');
    assert.equal(client.has('seadoc_oidc'), false, 'cookie-ul de legătură cu browserul se șterge');
    const row = await db.one(`SELECT oidc_subject, oidc_issuer FROM users WHERE username = 'maria.ionescu'`);
    assert.equal(row.oidc_subject, 'sub-maria');
    assert.equal(row.oidc_issuer, issuerUrl);
  });

  test('semnătură greșită, alg none și HS256 cu secretul clientului sunt respinse', async () => {
    for (const signWith of ['other', 'none', 'hs256'] as const) {
      const client = new Client();
      const { callback } = await oidcFlow(client, { sub: 'sub-maria', username: 'maria.ionescu', signWith });
      await assertRefused(client, callback);
    }
  });

  test('nonce greșit este respins', async () => {
    const client = new Client();
    const { callback } = await oidcFlow(client, { sub: 'sub-maria', username: 'maria.ionescu', nonce: 'alt-nonce' });
    await assertRefused(client, callback);
  });

  test('audiență greșită este respinsă', async () => {
    const client = new Client();
    const { callback } = await oidcFlow(client, { sub: 'sub-maria', username: 'maria.ionescu', aud: 'alta-aplicatie' });
    await assertRefused(client, callback);
  });

  test('emitent greșit și token expirat sunt respinse', async () => {
    for (const tamper of [{ iss: 'https://altul.example' }, { exp: Math.floor(Date.now() / 1000) - 3600 }]) {
      const client = new Client();
      const { callback } = await oidcFlow(client, { sub: 'sub-maria', username: 'maria.ionescu', ...tamper });
      await assertRefused(client, callback);
    }
  });

  test('o stare folosită o dată nu se mai poate reutiliza', async () => {
    const client = new Client();
    const { callback, callbackUrl } = await oidcFlow(client, { sub: 'sub-maria', username: 'maria.ionescu' });
    assert.equal(callback.location, '/panou');

    // Atacatorul reia aceeași adresă de revenire, cu un browser care are cookie-ul din nou.
    const attacker = new Client();
    const started = await attacker.get('/api/auth/oidc/start');
    assert.equal(started.status, 302);
    const calls = issuerState.tokenCalls;
    const replay = await attacker.get(callbackUrl);
    await assertRefused(attacker, replay);
    assert.equal(issuerState.tokenCalls, calls, 'o stare consumată nu ajunge la furnizor');

    // Aceeași stare cu un cod nou, din același browser.
    const second = new Client();
    const { callback: first, callbackUrl: url2 } = await oidcFlow(second, { sub: 'sub-maria', username: 'maria.ionescu' });
    assert.equal(first.location, '/panou');
    const victim = new Client();
    second.copyTo(victim);
    victim.drop('seadoc_session');
    const again = await victim.get(url2);
    assert.match(again.location, /sso=/);
  });

  test('un apel de revenire din alt browser decât cel care a pornit este respins (CSRF la autentificare)', async () => {
    const starter = new Client();
    issuerState.tamper = { sub: 'sub-maria', username: 'maria.ionescu' };
    const start = await starter.get('/api/auth/oidc/start');
    const authorize = await starter.get(start.location);
    const victim = new Client();
    const callback = await victim.get(authorize.location);
    await assertRefused(victim, callback);
    assert.ok(await auditCount('auth.oidc_esuat') >= 1);
  });

  test('utilizator necunoscut nu se creează; emailul contează doar dacă e verificat', async () => {
    const users = await count('SELECT count(*)::int AS n FROM users');
    const unknown = new Client();
    await assertRefused(unknown, (await oidcFlow(unknown, { sub: 'sub-nou', username: 'nu.exista' })).callback);
    assert.equal(await count('SELECT count(*)::int AS n FROM users'), users);

    const unverified = new Client();
    await assertRefused(unverified, (await oidcFlow(unverified, { sub: 'sub-email', username: 'alt.nume', email: 'ion.popescu@ctp.test', emailVerified: false })).callback);

    const verified = new Client();
    const { callback } = await oidcFlow(verified, { sub: 'sub-email', username: 'alt.nume', email: 'ion.popescu@ctp.test', emailVerified: true });
    assert.equal(callback.location, '/panou');
    assert.equal((await verified.get('/api/auth/me')).body.user.username, 'ion.popescu');
  });

  test('contul se leagă de un singur sub; alt sub cu același nume este refuzat', async () => {
    const client = new Client();
    await assertRefused(client, (await oidcFlow(client, { sub: 'alt-sub', username: 'maria.ionescu' })).callback);
  });

  test('administratorul local nu se poate autentifica prin SSO', async () => {
    const client = new Client();
    await assertRefused(client, (await oidcFlow(client, { sub: 'sub-admin', username: 'admin.local' })).callback);
    assert.equal((await db.one(`SELECT oidc_subject FROM users WHERE id = $1`, [ids.adminLocal])).oidc_subject, null);
  });

  test('crearea automată funcționează doar când este configurată, cu rolul minim și fără parolă', async () => {
    const { OidcService } = await import('../src/oidc.js');
    const service = app.get(OidcService);
    service.config.autoCreate = true;
    try {
      const client = new Client();
      const { callback } = await oidcFlow(client, { sub: 'sub-creat', username: 'cont.nou', name: 'Cont Nou', email: 'nou@ctp.test', emailVerified: true });
      assert.equal(callback.location, '/panou');
      const row = await db.one(`SELECT role, auth_source, password_hash FROM users WHERE username = 'cont.nou'`);
      assert.deepEqual([row.role, row.auth_source], ['user', 'oidc']);
      assert.doesNotMatch(row.password_hash, /^scrypt/);
      assert.equal((await new Client().post('/api/auth/login', { username: 'cont.nou', password: 'extern$fara-parola-locala' })).status, 401);
      assert.equal((await client.post('/api/auth/password', { current: 'x', next: 'Alta-Parola-2026!' })).status, 409);
    } finally {
      service.config.autoCreate = false;
    }
  });

  test('MFA: doar amr/acr din token satisfac cerința; altfel se aplică regulile aplicației', async () => {
    const remote = { 'x-forwarded-for': REMOTE_IP };
    const plain = new Client(remote);
    assert.equal((await oidcFlow(plain, { sub: 'sub-maria', username: 'maria.ionescu', amr: ['pwd'] })).callback.location, '/panou');
    assert.equal((await plain.get('/api/auth/me')).body.state, 'mfa_enrol', 'din afara rețelei, fără dovadă de MFA');
    assert.equal((await plain.get('/api/documents')).status, 401);

    const proven = new Client(remote);
    await oidcFlow(proven, { sub: 'sub-maria', username: 'maria.ionescu', amr: ['pwd', 'mfa'] });
    assert.equal((await proven.get('/api/auth/me')).body.state, 'ok');
    assert.equal((await proven.get('/api/documents')).status, 200);

    const acr = new Client(remote);
    await oidcFlow(acr, { sub: 'sub-maria', username: 'maria.ionescu', acr: 'http://schemas.openid.net/pape/policies/2007/06/multi-factor' });
    assert.equal((await acr.get('/api/auth/me')).body.state, 'ok');

    const weakAcr = new Client(remote);
    await oidcFlow(weakAcr, { sub: 'sub-maria', username: 'maria.ionescu', acr: 'urn:mace:incommon:iap:bronze' });
    assert.equal((await weakAcr.get('/api/auth/me')).body.state, 'mfa_enrol');

    // Un cont cu MFA activ în aplicație primește pasul TOTP dacă furnizorul nu dovedește MFA, și din rețeaua internă.
    await db.query(`UPDATE users SET mfa_enabled = true, totp_secret = 'JBSWY3DPEHPK3PXP' WHERE username = 'maria.ionescu'`);
    const internal = new Client();
    await oidcFlow(internal, { sub: 'sub-maria', username: 'maria.ionescu' });
    assert.equal((await internal.get('/api/auth/me')).body.state, 'mfa');
    await db.query(`UPDATE users SET mfa_enabled = false, totp_secret = NULL WHERE username = 'maria.ionescu'`);
  });

  test('un cont inactiv sau blocat nu intră prin SSO', async () => {
    await db.query(`UPDATE users SET locked_until = now() + interval '1 hour' WHERE username = 'maria.ionescu'`);
    const locked = new Client();
    await assertRefused(locked, (await oidcFlow(locked, { sub: 'sub-maria', username: 'maria.ionescu' })).callback);
    await db.query(`UPDATE users SET locked_until = NULL, active = false WHERE username = 'maria.ionescu'`);
    const inactive = new Client();
    await assertRefused(inactive, (await oidcFlow(inactive, { sub: 'sub-maria', username: 'maria.ionescu' })).callback);
    await db.query(`UPDATE users SET active = true WHERE username = 'maria.ionescu'`);
  });

  test('un furnizor oprit trimite înapoi la autentificare, fără eroare de server', async () => {
    const { OidcService } = await import('../src/oidc.js');
    const service = app.get(OidcService) as Json;
    const issuer = service.config.issuer;
    const discovered = service.discovered;
    service.config.issuer = new URL('http://127.0.0.1:1/realms/oprit');
    service.discovered = null;
    try {
      const r = await new Client().get('/api/auth/oidc/start');
      assert.equal(r.status, 302);
      assert.equal(r.location, '/autentificare?sso=indisponibil');
    } finally {
      service.config.issuer = issuer;
      service.discovered = discovered;
    }
  });

  test('adresa de revenire nu poate fi o redirecționare deschisă', async () => {
    for (const target of ['https://rau.example/', '//rau.example/', '/\\rau.example']) {
      const client = new Client();
      issuerState.tamper = { sub: 'sub-maria', username: 'maria.ionescu' };
      const start = await client.get(`/api/auth/oidc/start?returnTo=${encodeURIComponent(target)}`);
      const authorize = await client.get(start.location);
      assert.equal((await client.get(authorize.location)).location, '/panou');
    }
    const client = new Client();
    const start = await client.get(`/api/auth/oidc/start?returnTo=${encodeURIComponent('/documente/5')}`);
    const authorize = await client.get(start.location);
    assert.equal((await client.get(authorize.location)).location, '/documente/5');
  });
});

// ERP ----------------------------------------------------------------------------

describe('ERP: import', () => {
  const partnerMap = { externalId: 'Cod', name: 'Denumire', taxId: 'CUI' };
  const partnersCsv = '﻿Cod;Denumire;CUI;Oraș\r\nP1;Transport Iași SRL;RO123;Iași\r\nP2;"Papetărie; Birotică SA";RO456;Vaslui\r\nP3;Șantier Sud SRL;;Iași\r\n';
  const importCsv = (client: Client, csv: string | Buffer, kind: string, mapping: unknown, extra: Record<string, unknown> = {}) =>
    client.upload('/api/erp/import', { kind, mapping, ...extra }, { name: 'date.csv', data: Buffer.from(csv), type: 'text/csv' });

  test('previzualizarea arată coloanele, fără să importe', async () => {
    const r = await admin.upload('/api/erp/import/preview', {}, { name: 'p.csv', data: Buffer.from(partnersCsv) });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.columns, ['Cod', 'Denumire', 'CUI', 'Oraș']);
    assert.equal(r.body.totalRows, 3);
    assert.deepEqual(r.body.sample[1], ['P2', 'Papetărie; Birotică SA', 'RO456', 'Vaslui']);
    assert.ok(r.body.fields.partener.length);
    assert.equal(await count('SELECT count(*)::int AS n FROM erp_records'), 0);
  });

  test('importul cere users_admin', async () => {
    const user = await login('user.alpha');
    assert.equal((await importCsv(user, partnersCsv, 'partener', partnerMap)).status, 403);
    assert.equal((await user.upload('/api/erp/import/preview', {}, { name: 'p.csv', data: Buffer.from(partnersCsv) })).status, 403);
  });

  test('simularea raportează fără să scrie', async () => {
    const r = await importCsv(admin, partnersCsv, 'partener', partnerMap, { dryRun: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.created, 3);
    assert.equal(await count('SELECT count(*)::int AS n FROM erp_records'), 0);
    assert.equal(await auditCount('erp.import'), 0);
  });

  test('importul este idempotent după codul extern', async () => {
    const first = await importCsv(admin, partnersCsv, 'partener', partnerMap);
    assert.equal(first.status, 200, first.text);
    assert.deepEqual([first.body.created, first.body.updated, first.body.unchanged, first.body.rejected], [3, 0, 0, 0]);
    const second = await importCsv(admin, partnersCsv, 'partener', partnerMap);
    assert.deepEqual([second.body.created, second.body.updated, second.body.unchanged, second.body.rejected], [0, 0, 3, 0]);
    assert.equal(await count(`SELECT count(*)::int AS n FROM erp_records WHERE kind = 'partener'`), 3);
    const changed = await importCsv(admin, 'Cod;Denumire;CUI\nP1;Transport Iași SA;RO123\n', 'partener', partnerMap);
    assert.deepEqual([changed.body.created, changed.body.updated, changed.body.unchanged], [0, 1, 0]);
    const row = await db.one(`SELECT name, tax_id FROM erp_records WHERE external_id = 'P1'`);
    assert.deepEqual([row.name, row.tax_id], ['Transport Iași SA', 'RO123']);
    assert.equal(await auditCount('erp.import'), 3, 'o intrare de audit pe import, nu pe rând');
    assert.equal((await db.one(`SELECT tax_id FROM erp_records WHERE external_id = 'P3'`)).tax_id, null);
  });

  test('o celulă goală nu șterge o valoare existentă', async () => {
    await importCsv(admin, 'Cod;Denumire;CUI\nP2;Papetărie; Birotică SA;\n'.replace('Papetărie; Birotică SA', '"Papetărie; Birotică SA"'), 'partener', partnerMap);
    assert.equal((await db.one(`SELECT tax_id FROM erp_records WHERE external_id = 'P2'`)).tax_id, 'RO456');
  });

  test('rândurile deteriorate se raportează cu numărul liniei, iar restul se importă', async () => {
    const csv = [
      'Cod,Numar,Partener,Data,Scadenta,Valoare,Moneda',
      'F1,FV-001,P1,31.01.2024,2024-03-01,"1.234,56",RON',
      ',FV-002,P1,2024-02-01,,10,RON', // fără cod extern
      'F3,,P1,2024-02-01,,10,RON', // fără număr
      'F4,FV-004,P1,31.02.2024,,10,RON', // dată imposibilă
      'F5,FV-005,P1,2024-02-01,,zece,RON', // valoare invalidă
      'F6,FV-006,P1', // coloane lipsă
      'F7,FV-007,P1,2024-02-01,,10,RON,în plus', // coloane în plus
      'F1,FV-008,P1,2024-02-01,,10,RON', // cod duplicat în fișier
      'F9,FV-009,P9,2024-02-01,,"1,234.50",EUR', // partener necunoscut, dar valid
      'F10,FV-010,P2,2024-02-01,,99,RON',
      '"F11,FV-011,P2,2024-02-01,,10,RON', // ghilimele neînchise
    ].join('\n');
    const r = await importCsv(admin, csv, 'factura', { externalId: 'Cod', number: 'Numar', partnerExternalId: 'Partener', issueDate: 'Data', dueDate: 'Scadenta', amount: 'Valoare', currency: 'Moneda' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.created, 3);
    assert.equal(r.body.rejected, 8);
    assert.equal(r.body.unknownPartners, 1);
    const lines = r.body.errors.map((e: Json) => e.line);
    assert.deepEqual(lines, [3, 4, 5, 6, 7, 8, 9, 12]);
    assert.match(r.body.errors.find((e: Json) => e.line === 5).reason, /Dată invalidă/);
    assert.match(r.body.errors.find((e: Json) => e.line === 12).reason, /Ghilimele/);
    const f1 = await db.one(`SELECT number, issue_date::text AS d, due_date::text AS s, amount::text AS a FROM erp_records WHERE kind = 'factura' AND external_id = 'F1'`);
    assert.deepEqual([f1.number, f1.d, f1.s, f1.a], ['FV-001', '2024-01-31', '2024-03-01', '1234.56']);
    assert.equal((await db.one(`SELECT amount::text AS a FROM erp_records WHERE external_id = 'F9'`)).a, '1234.50');
  });

  test('o mapare greșită este refuzată, nu ghicită', async () => {
    assert.equal((await importCsv(admin, partnersCsv, 'partener', { externalId: 'Cod' })).status, 400, 'lipsește denumirea');
    assert.equal((await importCsv(admin, partnersCsv, 'partener', { externalId: 'Cod', name: 'NuExista' })).status, 400);
    assert.equal((await importCsv(admin, partnersCsv, 'partener', { externalId: 'Cod', name: 'Denumire', parola: 'CUI' })).status, 400);
    assert.equal((await importCsv(admin, partnersCsv, 'angajat', partnerMap)).status, 400);
    assert.equal((await importCsv(admin, Buffer.from([1, 2, 0, 3]), 'partener', partnerMap)).status, 400);
  });

  test('exporturile în Windows-1250 și formele cu sedilă ajung corecte', async () => {
    const csv = Buffer.concat([Buffer.from('Cod;Denumire\nP20;Fabric'), Buffer.from([0xe3]), Buffer.from(' de confec'), Buffer.from([0xfe]), Buffer.from('ii\n')]);
    const r = await importCsv(admin, csv, 'partener', { externalId: 'Cod', name: 'Denumire' });
    assert.equal(r.body.created, 1, r.text);
    assert.equal((await db.one(`SELECT name FROM erp_records WHERE external_id = 'P20'`)).name, 'Fabrică de confecții');
  });
});

describe('ERP: legături cu documente', () => {
  let docAlpha = 0;
  let docBeta = 0;
  let partner = 0;
  let invoice = 0;

  before(async () => {
    const managerAlpha = await login('manager.alpha');
    const managerBeta = await login('manager.beta');
    docAlpha = (await addDocument(managerAlpha, { title: 'Contract transport Alpha', departmentId: ids.alpha })).id;
    docBeta = (await addDocument(managerBeta, { title: 'Contract transport Beta', departmentId: ids.beta })).id;
    partner = (await db.one(`SELECT id FROM erp_records WHERE kind = 'partener' AND external_id = 'P1'`)).id;
    invoice = (await db.one(`SELECT id FROM erp_records WHERE kind = 'factura' AND external_id = 'F1'`)).id;
  });

  test('căutarea din selector găsește fără diacritice și după partener', async () => {
    const user = await login('user.alpha');
    const byName = await user.get(`/api/erp/records?kind=partener&q=${encodeURIComponent('transport iasi')}`);
    assert.equal(byName.status, 200, byName.text);
    assert.deepEqual(byName.body.items.map((r: Json) => r.externalId), ['P1']);
    const byPartner = await user.get(`/api/erp/records?kind=factura&q=${encodeURIComponent('transport')}`);
    assert.ok(byPartner.body.items.some((r: Json) => r.externalId === 'F1' && r.partnerName === 'Transport Iași SA'));
    const literal = await user.get(`/api/erp/records?q=${encodeURIComponent('%')}`);
    assert.equal(literal.body.total, 0, '% nu este metacaracter');
    assert.equal((await new Client().get('/api/erp/records')).status, 401);
  });

  test('legarea respectă vizibilitatea documentului și se auditează', async () => {
    const managerAlpha = await login('manager.alpha');
    const managerBeta = await login('manager.beta');
    const denied = await managerAlpha.post(`/api/documents/${docBeta}/erp-links`, { recordId: partner });
    assert.equal(denied.status, 404);
    const before_ = await auditCount('erp.legatura');
    const r = await managerAlpha.post(`/api/documents/${docAlpha}/erp-links`, { recordId: partner });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.map((x: Json) => x.externalId), ['P1']);
    assert.equal(await auditCount('erp.legatura'), before_ + 1);
    await managerAlpha.post(`/api/documents/${docAlpha}/erp-links`, { recordId: partner });
    assert.equal(await auditCount('erp.legatura'), before_ + 1, 'legătura existentă nu mai scrie în audit');
    assert.equal((await managerBeta.post(`/api/documents/${docBeta}/erp-links`, { recordId: invoice })).status, 200);
    assert.equal((await managerAlpha.post(`/api/documents/${docAlpha}/erp-links`, { recordId: 999999 })).status, 404);
    const audit = await db.one(`SELECT document_id, details FROM audit_log WHERE action = 'erp.legatura' ORDER BY seq DESC LIMIT 1`);
    assert.equal(audit.document_id, docBeta);
    assert.equal((await managerBeta.get(`/api/documents/${docAlpha}/erp-links`)).status, 404);
  });

  test('ecranul înregistrării listează doar documentele vizibile', async () => {
    const managerAlpha = await login('manager.alpha');
    const managerBeta = await login('manager.beta');
    const asAlpha = await managerAlpha.get(`/api/erp/records/${partner}`);
    assert.equal(asAlpha.status, 200, asAlpha.text);
    assert.deepEqual(asAlpha.body.documents.map((d: Json) => d.id), [docAlpha], 'documentul din Beta nu apare și nu se numără');
    assert.ok(!asAlpha.text.includes('Contract transport Beta'));
    const asBeta = await managerBeta.get(`/api/erp/records/${partner}`);
    assert.deepEqual(asBeta.body.documents.map((d: Json) => d.id), [docBeta], 'prin factura partenerului');
    const asAdmin = await admin.get(`/api/erp/records/${partner}`);
    assert.deepEqual(asAdmin.body.documents.map((d: Json) => d.id).sort(), [docAlpha, docBeta].sort());
    assert.ok(asAdmin.body.related.some((r: Json) => r.externalId === 'F1'));
  });

  test('căutarea documentelor după partener respectă vizibilitatea', async () => {
    const listIds = async (client: Client, query: string) => (await client.get(`/api/documents?${query}`)).body.items.map((d: Json) => d.id).sort();
    const user = await login('user.alpha');
    assert.deepEqual(await listIds(await login('manager.alpha'), `erpRecordId=${partner}`), [docAlpha]);
    assert.deepEqual(await listIds(await login('manager.beta'), `erpRecordId=${partner}`), [docBeta]);
    assert.deepEqual(await listIds(admin, `erpRecordId=${partner}`), [docAlpha, docBeta].sort());
    assert.deepEqual(await listIds(admin, `erpRecordId=${invoice}`), [docBeta], 'după factură, doar documentele ei');
    assert.deepEqual(await listIds(user, `erpRecordId=${partner}`), []);
    const paged = await (await login('manager.alpha')).get(`/api/documents?erpRecordId=${partner}`);
    assert.equal(paged.body.total, 1);
  });

  test('un document arhivat nu își schimbă legăturile; ștergerea se auditează', async () => {
    const managerAlpha = await login('manager.alpha');
    const extra = (await db.one(`SELECT id FROM erp_records WHERE external_id = 'P2'`)).id;
    await managerAlpha.post(`/api/documents/${docAlpha}/erp-links`, { recordId: extra });
    const removed = await managerAlpha.del(`/api/documents/${docAlpha}/erp-links/${extra}`);
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(removed.body.map((x: Json) => x.externalId), ['P1']);
    assert.ok(await auditCount('erp.legatura_stearsa') >= 1);
    const archived = await addDocument(managerAlpha, { title: 'Arhivat', departmentId: ids.alpha });
    await ocr.drain();
    await db.query(`UPDATE documents SET status = 'arhivat' WHERE id = $1`, [archived.id]);
    assert.equal((await managerAlpha.post(`/api/documents/${archived.id}/erp-links`, { recordId: partner })).status, 409);
  });
});

// Migrare ------------------------------------------------------------------------

describe('Migrare: comanda', () => {
  const year = new Date().toLocaleString('en', { timeZone: 'Europe/Bucharest', year: 'numeric' });
  const source = path.join(scratch, 'sursa');
  const outside = path.join(scratch, 'in-afara');
  const inventoryFile = path.join(scratch, 'inventar.csv');
  const mappingFile = path.join(scratch, 'mapare.yaml');
  const secretText = 'SECRET din afara arhivei care nu trebuie importat';
  const put = async (rel: string, data: Buffer | string) => {
    const abs = path.join(source, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    return sha(data);
  };
  const pdfFor = (title: string) => textPdf({ title, paragraphs: [`Text istoric pentru ${title}, cu suficient conținut ca să treacă de pragul de pagină și să se poată căuta.`] });
  const hashes: Record<string, string> = {};
  let firstRun = 0;

  before(async () => {
    hashes.c12 = await put(`contracte/${year}/00012_Contract alfa.pdf`, await pdfFor('Contract alfa'));
    hashes.c150 = await put(`contracte/${year}/00150_Contract beta.pdf`, await pdfFor('Contract beta'));
    hashes.c2019 = await put('contracte/2019/00007_Contract vechi.pdf', await pdfFor('Contract vechi'));
    hashes.note = await put('corespondenta/adresa primita.txt', 'Adresă istorică fără număr de registru, cu text simplu.');
    await put('sistem/Thumbs.db', Buffer.from([1, 2, 3]));
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.pdf'), await pdfFor(secretText));
    fs.symlinkSync(path.join(outside, 'secret.pdf'), path.join(source, 'contracte', 'legatura-afara.pdf'));
    fs.symlinkSync(outside, path.join(source, 'dosar-afara'));
    fs.symlinkSync(path.join(source, 'corespondenta', 'adresa primita.txt'), path.join(source, 'corespondenta', 'legatura-interna.txt'));
    fs.symlinkSync(path.join(scratch, 'nu-exista'), path.join(source, 'link-rupt'));
    fs.writeFileSync(mappingFile, `
source: arhiva-test
defaults:
  department: Alpha
rules:
  - match: { folder: "sistem/**" }
    skip: true
  - match:
      pattern: '^contracte/(?<an>\\d{4})/(?<numar>\\d+)_(?<titlu>.+)\\.pdf$'
    set:
      documentType: Contract
      register: RC
      regNumber: "{numar}"
      regYear: "{an}"
      regDate: "{an}-03-15"
      title: "{titlu}"
      direction: intrat
      metadata:
        partener: "{top}"
  - match: { folder: "corespondenta/**", ext: [txt] }
    set:
      documentType: Corespondență
      title: "{stem}"
      issuer: Registratura veche
`);
  });

  test('inventory numără, hash-uiește, refuză linkurile spre exterior și nu atinge baza de date', async () => {
    const before_ = await count('SELECT count(*)::int AS n FROM documents');
    // URL-ul greșit dovedește că inventarul nu deschide nicio conexiune.
    const r = await cli(['inventory', source, '--out', inventoryFile], { DATABASE_URL: 'postgres://nimeni@127.0.0.1:1/nu_exista' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Fișiere: 5/);
    assert.match(r.out, /\.pdf: 3 fișiere/);
    assert.match(r.err, /refuzat_symlink: contracte\/legatura-afara\.pdf/);
    const rows = readCsv(inventoryFile);
    const by = Object.fromEntries(rows.map((x) => [x.path, x]));
    assert.equal(by[`contracte/${year}/00012_Contract alfa.pdf`].sha256, hashes.c12);
    assert.equal(by[`contracte/${year}/00012_Contract alfa.pdf`].status, 'ok');
    assert.equal(by['corespondenta/adresa primita.txt'].sha256, hashes.note);
    for (const link of ['contracte/legatura-afara.pdf', 'dosar-afara']) {
      assert.equal(by[link].status, 'refuzat_symlink', link);
      assert.equal(by[link].sha256, '', 'nimic din afara sursei nu se citește');
    }
    assert.equal(by['link-rupt'].status, 'refuzat_symlink');
    assert.equal(by['corespondenta/legatura-interna.txt'].status, 'ignorat_symlink_intern');
    assert.ok(!rows.some((x) => x.path.includes('secret')), 'dosarul din afară nu se parcurge');
    assert.equal(await count('SELECT count(*)::int AS n FROM documents'), before_);
    assert.equal(await count('SELECT count(*)::int AS n FROM migration_runs'), 0);
    assert.equal(fs.existsSync(`${inventoryFile}.part`), false);
  });

  test('inventory reluat nu hash-uiește din nou ce nu s-a schimbat', async () => {
    const r = await cli(['inventory', source, '--out', inventoryFile], { DATABASE_URL: 'postgres://nimeni@127.0.0.1:1/nu_exista' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /5 preluate din rularea anterioară/);
  });

  test('inventory cu manifest preia câmpurile, semnalează ce lipsește și hash-urile diferite', async () => {
    const manifest = path.join(scratch, 'manifest.csv');
    const out = path.join(scratch, 'inventar-manifest.csv');
    fs.writeFileSync(manifest, [
      'cale;emitent;sha256',
      `contracte/${year}/00012_Contract alfa.pdf;Primăria Iași;${hashes.c12}`,
      `contracte/2019/00007_Contract vechi.pdf;Altcineva;${'0'.repeat(64)}`,
      'lipseste/de-pe-disc.pdf;Nimeni;',
    ].join('\n'));
    const r = await cli(['inventory', source, '--manifest', manifest, '--out', out]);
    assert.equal(r.code, 0, r.err);
    const by = Object.fromEntries(readCsv(out).map((x) => [x.path, x]));
    assert.deepEqual(JSON.parse(by[`contracte/${year}/00012_Contract alfa.pdf`].fields), { emitent: 'Primăria Iași' });
    assert.equal(by['contracte/2019/00007_Contract vechi.pdf'].status, 'hash_diferit_manifest');
    assert.equal(by['lipseste/de-pe-disc.pdf'].status, 'lipsa_pe_disc');
    assert.match(by['corespondenta/adresa primita.txt'].note, /Nu apare în manifest/);
  });

  test('inventarul nu se poate scrie în sursă, iar un fișier cu nume-formulă păstrează drumul înapoi', async () => {
    const r = await cli(['inventory', source, '--out', path.join(source, 'x.csv')]);
    assert.equal(r.code, 1);
    assert.match(r.err, /nu se scrie în dosarul sursă/);
    const dir = path.join(scratch, 'sursa-formula');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '=HYPERLINK(1).txt'), 'x');
    const out = path.join(scratch, 'inv-formula.csv');
    assert.equal((await cli(['inventory', dir, '--out', out])).code, 0);
    assert.match(fs.readFileSync(out, 'utf8'), /"'=HYPERLINK/, 'Excel nu o ia drept formulă');
    const again = await cli(['inventory', dir, '--out', out]);
    assert.match(again.out, /1 preluate/, 'citirea înapoi dă aceeași cale');
  });

  test('map raportează problemele și nu importă nimic', async () => {
    const before_ = await count('SELECT count(*)::int AS n FROM documents');
    const bad = path.join(scratch, 'mapare-rea.yaml');
    fs.writeFileSync(bad, `
source: rea
necunoscut: 1
rules:
  - match: { folder: "contracte/**" }
    set: { documentType: Inexistent, department: Alpha, campStrain: 1 }
  - match: { pattern: "(" }
    set: { documentType: Contract, department: Nicaieri }
`);
    const r = await cli(['map', bad]);
    assert.equal(r.code, 1);
    for (const expected of [/necunoscut/, /campStrain/, /expresie invalidă/, /tip de document inexistent: Inexistent/, /departament inexistent: Nicaieri/]) assert.match(r.err, expected);

    const json = path.join(scratch, 'mapare.json');
    fs.writeFileSync(json, JSON.stringify({ source: 'j', rules: [{ match: { folder: 'contracte/**' }, set: { documentType: 'Contract', department: 'Alpha', title: '{nuExista}' } }] }));
    const perFile = await cli(['map', json, '--inventory', inventoryFile]);
    assert.equal(perFile.code, 1);
    assert.match(perFile.err, /Câmp lipsă în sursă: \{nuExista\}/);
    assert.match(perFile.err, /nicio regulă nu se potrivește/);
    assert.match(perFile.err, /refuzat_symlink/);

    const ok = path.join(scratch, 'inventar-curat.csv');
    fs.writeFileSync(ok, fs.readFileSync(inventoryFile, 'utf8').split('\n').filter((l) => !l.includes('refuzat_symlink')).join('\n'));
    const good = await cli(['map', mappingFile, '--inventory', ok]);
    assert.equal(good.code, 0, good.err);
    assert.match(good.out, /Fișiere mapate: 4, excluse prin regulă: 1/);
    assert.match(good.out, /Maparea este validă/);
    assert.equal(await count('SELECT count(*)::int AS n FROM documents'), before_);
    assert.equal(await count('SELECT count(*)::int AS n FROM migration_runs'), 0);
  });

  test('import cere exact un mod', async () => {
    const r = await cli(['import', '--inventory', inventoryFile, '--mapping', mappingFile, '--root', source]);
    assert.equal(r.code, 1);
    assert.match(r.err, /--dry-run și --commit/);
    assert.equal((await cli(['import', '--inventory', inventoryFile, '--mapping', mappingFile, '--root', source, '--dry-run', '--commit'])).code, 1);
  });

  test('--dry-run nu scrie documente, fișiere sau contoare', async () => {
    const state = async () => [
      await count('SELECT count(*)::int AS n FROM documents'),
      await count('SELECT count(*)::int AS n FROM document_versions'),
      await count('SELECT count(*)::int AS n FROM register_counters'),
      await count(`SELECT count(*)::int AS n FROM users WHERE username = 'migrare.sistem'`),
      fs.readdirSync(storageDir).length,
    ];
    const before_ = await state();
    const r = await cli(['import', '--inventory', inventoryFile, '--mapping', mappingFile, '--root', source, '--dry-run']);
    assert.equal(r.code, 1, 'există intrări refuzate');
    assert.deepEqual(await state(), before_);
    const run = await db.one(`SELECT id, mode, status, counts FROM migration_runs ORDER BY id DESC LIMIT 1`);
    assert.equal(run.mode, 'simulare');
    assert.equal(run.status, 'finalizat');
    assert.equal(run.counts.simulat, 4);
    assert.equal(run.counts.refuzat, 3);
    assert.equal(run.counts.ignorat, 2);
    assert.equal(await auditCount('migrare.simulare'), 1);
    assert.equal(await auditCount('migrare.element_esuat'), 0, 'simularea nu înregistrează eșecuri reale');
    const report = await cli(['report', String(run.id)]);
    assert.equal(report.code, 1);
    assert.match(report.err, /simulare/);
  });

  test('--commit întrerupt se reia: ce s-a importat se sare, restul se importă o singură dată', async () => {
    const r = await cli(['import', '--inventory', inventoryFile, '--mapping', mappingFile, '--root', source, '--commit', '--limit', '2']);
    const run = await db.one(`SELECT id, status, counts FROM migration_runs ORDER BY id DESC LIMIT 1`);
    firstRun = run.id;
    assert.equal(run.status, 'intrerupt', r.err);
    assert.ok(run.counts.neprocesate > 0);
    const imported = await count(`SELECT count(*)::int AS n FROM migration_items WHERE run_id = $1 AND status = 'importat'`, [firstRun]);
    assert.equal(imported, 2);
    assert.equal(await count('SELECT count(*)::int AS n FROM documents WHERE owner_id = (SELECT id FROM users WHERE username = $1)', ['migrare.sistem']), imported);

    const resumed = await cli(['import', '--inventory', inventoryFile, '--mapping', mappingFile, '--root', source, '--commit']);
    const second = await db.one(`SELECT id, status, counts FROM migration_runs ORDER BY id DESC LIMIT 1`);
    assert.equal(second.status, 'finalizat', resumed.err);
    assert.equal(second.counts.sarit, imported);
    assert.equal(second.counts.importat, 4 - imported);
    assert.equal(await count('SELECT count(*)::int AS n FROM documents WHERE owner_id = (SELECT id FROM users WHERE username = $1)', ['migrare.sistem']), 4);

    const third = await cli(['import', '--inventory', inventoryFile, '--mapping', mappingFile, '--root', source, '--commit']);
    const last = await db.one(`SELECT id, counts FROM migration_runs ORDER BY id DESC LIMIT 1`);
    assert.equal(last.counts.sarit, 4, third.err);
    assert.equal(last.counts.importat ?? 0, 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM documents WHERE owner_id = (SELECT id FROM users WHERE username = $1)', ['migrare.sistem']), 4, 'a treia rulare nu dublează nimic');

    // Raportul unei reluări verifică și fișierele importate la rulările anterioare.
    const report = await cli(['report', String(last.id), '--out', path.join(scratch, 'rap-reluare')]);
    assert.match(report.out, /sărite: 4/);
    assert.match(report.out, /Hash-uri recalculate: 4; potrivite: 4; nepotrivite: 0/);
    assert.equal(report.code, 2, 'linkurile refuzate rămân de rezolvat');
    assert.match(report.err, /3 intrări refuzate/);
  });

  test('numerele și datele istorice se păstrează; cont tehnic inactiv; fișierele sunt criptate; OCR prin coada existentă', async () => {
    const doc = await db.one(
      `SELECT d.*, u.username, u.active AS owner_active, v.ocr_status, v.sha256, v.storage_key, v.created_by, d.reg_date AT TIME ZONE 'Europe/Bucharest' AS local_date
       FROM documents d JOIN users u ON u.id = d.owner_id JOIN document_versions v ON v.document_id = d.id WHERE d.reg_label = $1`, [`RC-00150/${year}`]);
    assert.equal(doc.reg_number, 150);
    assert.equal(doc.reg_year, Number(year));
    assert.equal(doc.title, 'Contract beta');
    assert.equal(doc.direction, 'intrat');
    assert.equal(new Date(doc.local_date).getMonth(), 2);
    assert.equal(new Date(doc.local_date).getDate(), 15);
    assert.deepEqual(doc.metadata, { partener: 'contracte' });
    assert.equal(doc.username, 'migrare.sistem');
    assert.equal(doc.owner_active, false);
    assert.equal(doc.sha256, hashes.c150);
    assert.equal(doc.ocr_status, 'in_asteptare', 'în coada OCR a serverului');
    const onDisk = fs.readFileSync(path.join(storageDir, doc.storage_key));
    assert.ok(!onDisk.includes(Buffer.from('%PDF')), 'pe disc fișierul este criptat');
    assert.equal(await count(`SELECT count(*)::int AS n FROM documents WHERE reg_label = 'RC-00007/2019'`), 1);
    assert.equal(await count(`SELECT count(*)::int AS n FROM documents WHERE title = $1`, [secretText]), 0);
    assert.equal((await new Client().post('/api/auth/login', { username: 'migrare.sistem', password: 'extern$fara-parola-locala' })).status, 401);

    await ocr.drain();
    assert.equal(await count(`SELECT count(*)::int AS n FROM document_versions v JOIN documents d ON d.id = v.document_id JOIN users u ON u.id = d.owner_id WHERE u.username = 'migrare.sistem' AND v.ocr_status <> 'finalizat'`), 0);
    const found = await admin.get(`/api/documents?q=${encodeURIComponent('Text istoric Contract beta')}`);
    assert.ok(found.body.items.some((x: Json) => x.regLabel === `RC-00150/${year}`), 'textul extras se poate căuta');
    const file = await admin.bytes(`/api/documents/${doc.id}/file?kind=original&download=1`);
    assert.equal(sha(file.data), hashes.c150);
    assert.equal(file.headers.get('content-type'), 'application/pdf');
  });

  test('contorul avansează peste numărul cel mai mare, iar numerele noi nu se ciocnesc', async () => {
    const counter = await db.one(`SELECT last_number FROM register_counters WHERE register_id = $1 AND year = $2`, [ids.register, Number(year)]);
    assert.equal(counter.last_number, 150);
    assert.equal((await db.one(`SELECT last_number FROM register_counters WHERE register_id = $1 AND year = 2019`, [ids.register])).last_number, 7);
    const managerAlpha = await login('manager.alpha');
    const created = await addDocument(managerAlpha, { title: 'Document nou după migrare', departmentId: ids.alpha, registerId: ids.register });
    assert.equal(created.regLabel, `RC-00151/${year}`);
  });

  test('o coliziune cu un număr existent se raportează, nu se renumerotează; contorul nu dă înapoi', async () => {
    const collSource = path.join(scratch, 'sursa-coliziune');
    fs.mkdirSync(path.join(collSource, 'c'), { recursive: true });
    // Numărul 151 a fost dat de aplicație în testul anterior. 151 apare și de două ori în aceeași sursă.
    fs.writeFileSync(path.join(collSource, 'c', '00151_ocupat.pdf'), await pdfFor('Ocupat'));
    fs.writeFileSync(path.join(collSource, 'c', '00200_a.pdf'), await pdfFor('Bun'));
    fs.mkdirSync(path.join(collSource, 'd'));
    fs.writeFileSync(path.join(collSource, 'd', '00200_dublu.pdf'), await pdfFor('Dublu în sursă'));
    const inv = path.join(scratch, 'inv-coliziune.csv');
    assert.equal((await cli(['inventory', collSource, '--out', inv])).code, 0);
    const map = path.join(scratch, 'map-coliziune.yaml');
    fs.writeFileSync(map, `
source: coliziuni
rules:
  - match: { pattern: '^[cd]/(?<numar>\\d+)_(?<titlu>.+)\\.pdf$' }
    set: { documentType: Contract, department: Alpha, register: RC, regNumber: "{numar}", regYear: "${year}", regDate: "${year}-01-10", title: "{titlu}" }
`);
    const preview = await cli(['map', map, '--inventory', inv]);
    assert.equal(preview.code, 1);
    assert.match(preview.err, new RegExp(`numărul RC-00151/${year} există deja`));
    assert.match(preview.err, new RegExp(`numărul RC-00200/${year} apare și la`));

    const failedBefore = await auditCount('migrare.element_esuat');
    const docsBefore = await count('SELECT count(*)::int AS n FROM documents');
    const r = await cli(['import', '--inventory', inv, '--mapping', map, '--root', collSource, '--commit']);
    assert.equal(r.code, 1);
    const run = await db.one(`SELECT id, counts FROM migration_runs ORDER BY id DESC LIMIT 1`);
    assert.equal(run.counts.importat, 1);
    assert.equal(run.counts.coliziune, 2);
    assert.equal(await count('SELECT count(*)::int AS n FROM documents'), docsBefore + 1);
    const collided = await db.one(`SELECT detail, reg_label, document_id FROM migration_items WHERE run_id = $1 AND rel_path = 'c/00151_ocupat.pdf'`, [run.id]);
    assert.match(collided.detail, /nu se renumerotează/);
    assert.equal(collided.document_id, null);
    assert.equal(await count(`SELECT count(*)::int AS n FROM documents WHERE title = 'ocupat'`), 0);
    assert.equal(await auditCount('migrare.element_esuat'), failedBefore + 2, 'câte o intrare pe fiecare eșec');
    assert.equal((await db.one(`SELECT last_number FROM register_counters WHERE register_id = $1 AND year = $2`, [ids.register, Number(year)])).last_number, 200);

    const report = await cli(['report', String(run.id), '--out', path.join(scratch, 'rap-coliziune')]);
    assert.equal(report.code, 2, 'coliziunile fac raportul neconform');
    assert.match(report.err, /RAPORT NECONFORM/);
    assert.match(report.err, /2 coliziuni/);
  });

  test('auditul are o intrare pe rulare și una pe eșec, nu pe fiecare succes', async () => {
    const runs = await count(`SELECT count(*)::int AS n FROM migration_runs WHERE mode = 'import'`);
    const imported = await count(`SELECT count(*)::int AS n FROM migration_items WHERE status = 'importat'`);
    assert.ok(imported >= 4);
    assert.equal(await auditCount('migrare.import'), runs);
    assert.ok((await auditCount('migrare.%')) < imported + runs + 10);
    assert.equal(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'document.inregistrat' AND username = 'migrare.sistem'`), 0);
    const failure = await db.one(`SELECT username, details FROM audit_log WHERE action = 'migrare.element_esuat' ORDER BY seq LIMIT 1`);
    assert.equal(failure.username, 'migrare.sistem');
    assert.ok(failure.details.cale && failure.details.rulare);
  });

  test('un inventar falsificat nu poate scoate fișiere din sursă, nici printr-un link, nici prin ..', async () => {
    const secretSha = sha(fs.readFileSync(path.join(outside, 'secret.pdf')));
    const line = (rel: string) => [rel, fs.statSync(path.join(outside, 'secret.pdf')).size, new Date().toISOString(), 'pdf', secretSha, 'ok', '', ''].map((v) => `"${v}"`).join(';');
    const forged = path.join(scratch, 'inv-falsificat.csv');
    fs.writeFileSync(forged, ['path;size_bytes;mtime;extension;sha256;status;note;fields', line('contracte/legatura-afara.pdf'), line('../in-afara/secret.pdf'), line('dosar-afara/secret.pdf')].join('\n'));
    const map = path.join(scratch, 'map-falsificat.yaml');
    fs.writeFileSync(map, 'source: falsificat\nrules:\n  - set: { documentType: Contract, department: Alpha }\n');
    const docsBefore = await count('SELECT count(*)::int AS n FROM documents');
    const r = await cli(['import', '--inventory', forged, '--mapping', map, '--root', source, '--commit']);
    assert.equal(r.code, 1);
    const run = await db.one(`SELECT id, counts FROM migration_runs ORDER BY id DESC LIMIT 1`);
    assert.equal(run.counts.esuat, 3, JSON.stringify(run.counts));
    assert.equal(run.counts.importat ?? 0, 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM documents'), docsBefore);
  });

  test('un fișier schimbat după inventar eșuează, iar unul schimbat după import nu suprascrie', async () => {
    const dir = path.join(scratch, 'sursa-schimbata');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'Conținut original al fișierului a.');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'Conținut original al fișierului b.');
    const inv = path.join(scratch, 'inv-schimbat.csv');
    assert.equal((await cli(['inventory', dir, '--out', inv])).code, 0);
    const map = path.join(scratch, 'map-schimbat.yaml');
    fs.writeFileSync(map, 'source: schimbat\nrules:\n  - set: { documentType: Corespondență, department: Alpha }\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'Conținut modificat după inventar.');
    const r = await cli(['import', '--inventory', inv, '--mapping', map, '--root', dir, '--commit']);
    assert.equal(r.code, 1);
    const run = await db.one(`SELECT id, counts FROM migration_runs ORDER BY id DESC LIMIT 1`);
    assert.equal(run.counts.importat, 1);
    assert.match((await db.one(`SELECT detail FROM migration_items WHERE run_id = $1 AND rel_path = 'b.txt'`, [run.id])).detail, /Hash diferit față de inventar/);

    fs.writeFileSync(path.join(dir, 'a.txt'), 'Conținut modificat după import.');
    assert.equal((await cli(['inventory', dir, '--out', inv])).code, 0);
    const again = await cli(['import', '--inventory', inv, '--mapping', map, '--root', dir, '--commit']);
    assert.equal(again.code, 1);
    const run2 = await db.one(`SELECT id FROM migration_runs ORDER BY id DESC LIMIT 1`);
    assert.match((await db.one(`SELECT detail FROM migration_items WHERE run_id = $1 AND rel_path = 'a.txt'`, [run2.id])).detail, /Conținut diferit față de importul din rularea/);
    assert.equal(await count(`SELECT count(*)::int AS n FROM document_versions WHERE filename = 'a.txt'`), 1);
  });

  describe('raportul de integritate', () => {
    let cleanRun = 0;
    let cleanDir = '';

    before(async () => {
      cleanDir = path.join(scratch, 'sursa-curata');
      fs.mkdirSync(path.join(cleanDir, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(cleanDir, 'unu.pdf'), await pdfFor('Raport unu'));
      fs.writeFileSync(path.join(cleanDir, 'sub', 'doi.txt'), 'Al doilea fișier din sursa curată.');
      const inv = path.join(scratch, 'inv-curat.csv');
      assert.equal((await cli(['inventory', cleanDir, '--out', inv])).code, 0);
      const map = path.join(scratch, 'map-curat.yaml');
      fs.writeFileSync(map, 'source: curata\nrules:\n  - set: { documentType: Corespondență, department: Alpha, title: "Sursă curată: {stem}" }\n');
      const r = await cli(['import', '--inventory', inv, '--mapping', map, '--root', cleanDir, '--commit']);
      assert.equal(r.code, 0, r.err);
      cleanRun = (await db.one(`SELECT id FROM migration_runs ORDER BY id DESC LIMIT 1`)).id;
    });

    const storedFile = async (rel: string) => {
      const row = await db.one(`SELECT v.storage_key FROM migration_items i JOIN document_versions v ON v.id = i.version_id WHERE i.run_id = $1 AND i.rel_path = $2`, [cleanRun, rel]);
      return path.join(storageDir, row.storage_key);
    };

    test('o rulare curată dă CSV și PDF conforme, cu ieșire 0', async () => {
      const out = path.join(scratch, 'rap-curat');
      const r = await cli(['report', String(cleanRun), '--out', out, '--recount']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Raport CONFORM/);
      assert.match(r.out, /Fișiere în sursă: 2; importate: 2/);
      assert.match(r.out, /Hash-uri recalculate: 2; potrivite: 2; nepotrivite: 0/);
      const rows = readCsv(path.join(out, `raport-migrare-${cleanRun}.csv`));
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row['SHA-256 inventar'], row['SHA-256 recalculat']);
        assert.equal(row.Verificare, 'ok');
      }
      const pdf = fs.readFileSync(path.join(out, `raport-migrare-${cleanRun}.pdf`));
      const text = (await pdfText(pdf)).join('\n');
      assert.match(text, /CONFORM/);
      assert.doesNotMatch(text, /NECONFORM/);
      assert.match(text, /Semnături la recepție/);
      assert.match(text, /Am predat/);
      assert.match(text, /Nu există erori/);
      assert.equal((await db.one(`SELECT report_ok FROM migration_runs WHERE id = $1`, [cleanRun])).report_ok, true);
    });

    test('un fișier stocat alterat dă NECONFORM, ieșire 2, în CSV, PDF și pe ecran', async () => {
      const file = await storedFile('unu.pdf');
      const original = fs.readFileSync(file);
      const damaged = Buffer.from(original);
      damaged[damaged.length - 5] ^= 0xff;
      fs.writeFileSync(file, damaged);
      try {
        const out = path.join(scratch, 'rap-alterat');
        const r = await cli(['report', String(cleanRun), '--out', out]);
        assert.equal(r.code, 2, r.out + r.err);
        assert.match(r.err, /\*\*\* RAPORT NECONFORM/);
        assert.match(r.err, /1 fișiere nu corespund inventarului/);
        assert.match(r.err, /unu\.pdf/);
        const rows = readCsv(path.join(out, `raport-migrare-${cleanRun}.csv`));
        const row = rows.find((x) => x.Cale === 'unu.pdf')!;
        assert.equal(row.Verificare, 'nepotrivire');
        assert.equal(row['SHA-256 recalculat'], '');
        assert.equal(rows.find((x) => x.Cale === 'sub/doi.txt')!.Verificare, 'ok');
        const text = (await pdfText(fs.readFileSync(path.join(out, `raport-migrare-${cleanRun}.pdf`)))).join('\n');
        assert.match(text, /NECONFORM/);
        assert.match(text, /unu\.pdf/);

        const screen = await admin.get(`/api/admin/migration/runs/${cleanRun}`);
        assert.equal(screen.body.reportOk, false);
        assert.equal(screen.body.report.mismatched, 1);
        assert.equal(screen.body.report.problems[0].path, 'unu.pdf');
        const items = await admin.get(`/api/admin/migration/runs/${cleanRun}/items`);
        assert.equal(items.body.total, 1);
        assert.equal(items.body.items[0].verifyStatus, 'nepotrivire');
      } finally {
        fs.writeFileSync(file, original);
      }
      assert.equal((await cli(['report', String(cleanRun), '--out', path.join(scratch, 'rap-refacut')])).code, 0, 'după refacere raportul e din nou conform');
    });

    test('un fișier lipsă din stocare și un hash schimbat în bază dau NECONFORM', async () => {
      const file = await storedFile('sub/doi.txt');
      const original = fs.readFileSync(file);
      fs.rmSync(file);
      const missing = await cli(['report', String(cleanRun), '--out', path.join(scratch, 'rap-lipsa')]);
      assert.equal(missing.code, 2);
      assert.match(missing.err, /nu se poate citi/);
      fs.writeFileSync(file, original);

      const row = await db.one(`SELECT version_id FROM migration_items WHERE run_id = $1 AND rel_path = 'unu.pdf'`, [cleanRun]);
      const version = await db.one(`SELECT sha256 FROM document_versions WHERE id = $1`, [row.version_id]);
      await db.query(`UPDATE document_versions SET sha256 = $2 WHERE id = $1`, [row.version_id, 'f'.repeat(64)]);
      const declared = await cli(['report', String(cleanRun), '--out', path.join(scratch, 'rap-hash')]);
      assert.equal(declared.code, 2);
      assert.match(declared.err, /Baza de date declară alt hash/);
      await db.query(`UPDATE document_versions SET sha256 = $2 WHERE id = $1`, [row.version_id, version.sha256]);
    });

    test('o sursă schimbată la renumărare și un inventar modificat dau NECONFORM', async () => {
      fs.writeFileSync(path.join(cleanDir, 'in-plus.txt'), 'x');
      const r = await cli(['report', String(cleanRun), '--out', path.join(scratch, 'rap-plus'), '--recount']);
      assert.equal(r.code, 2);
      assert.match(r.err, /Sursa are acum 3 fișiere, inventarul are 2/);
      fs.rmSync(path.join(cleanDir, 'in-plus.txt'));
      const inv = path.join(scratch, 'inv-curat.csv');
      const text = fs.readFileSync(inv, 'utf8');
      fs.appendFileSync(inv, '\n');
      const changed = await cli(['report', String(cleanRun), '--out', path.join(scratch, 'rap-inv')]);
      assert.equal(changed.code, 2);
      assert.match(changed.err, /inventar s-a schimbat/);
      fs.writeFileSync(inv, text);
      assert.equal((await cli(['report', String(cleanRun), '--out', path.join(scratch, 'rap-final')])).code, 0);
    });

    test('un import întrerupt nu poate primi raport conform', async () => {
      const r = await cli(['report', String(firstRun), '--out', path.join(scratch, 'rap-intrerupt')]);
      assert.equal(r.code, 2);
      assert.match(r.err, /neprocesate/);
    });

    test('ecranul de migrare este doar pentru administratori și doar citește', async () => {
      const user = await login('user.alpha');
      assert.equal((await user.get('/api/admin/migration/runs')).status, 403);
      assert.equal((await new Client().get('/api/admin/migration/runs')).status, 401);
      const list = await admin.get('/api/admin/migration/runs');
      assert.equal(list.status, 200, list.text);
      assert.ok(list.body.some((x: Json) => x.id === cleanRun && x.reportOk === true && x.hasPdf && x.mode === 'import'));
      assert.ok(list.body.some((x: Json) => x.mode === 'simulare'));
      assert.equal((await admin.post('/api/admin/migration/runs', {})).status, 404);
      const pdf = await admin.bytes(`/api/admin/migration/runs/${cleanRun}/report/pdf`);
      assert.equal(pdf.status, 200);
      assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF');
      assert.match((await pdfText(pdf.data)).join('\n'), /Raport de integritate/);
      const csv = await admin.get(`/api/admin/migration/runs/${cleanRun}/report/csv`);
      assert.equal(csv.status, 200);
      assert.match(csv.text, /SHA-256 recalculat/);
      assert.equal((await admin.get(`/api/admin/migration/runs/${firstRun + 100000}/report/pdf`)).status, 404);
      assert.equal((await user.get(`/api/admin/migration/runs/${cleanRun}/report/pdf`)).status, 403);
    });
  });

  test('lanțul de audit rămâne intact după toate rulările', async () => {
    const r = await admin.get('/api/audit/verify');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
  });
});
