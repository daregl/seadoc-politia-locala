// Teste de integrare pe serverul HTTP real și pe PostgreSQL. Baza de test se golește la fiecare rulare.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import * as OTPAuth from 'otpauth';
import pg from 'pg';
import { scannedPdf, textPdf } from '../scripts/pdf-tools.js';
import { SCANNED_SAMPLE } from '../scripts/seed-documents.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://seadoc@127.0.0.1:55432/seadoc_test';
if (!/test/.test(new URL(databaseUrl).pathname)) throw new Error('Testele șterg baza de date: DATABASE_URL trebuie să indice o bază de test');
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seadoc-test-'));
process.env.DATABASE_URL = databaseUrl;
process.env.STORAGE_DIR = storageDir;
process.env.OCR_POLL_MS = '86400000';
process.env.SCHEDULER_MS = '86400000';
// Un proxy de încredere: X-Forwarded-For simulează conexiuni din afara rețelei interne.
process.env.TRUST_PROXY = '1';
process.env.COOKIE_SECURE = 'false';

const PASSWORD = 'Parola-Test-2026!';
const REMOTE_IP = '8.8.8.8';

type Json = any;
interface Reply { status: number; body: Json; text: string; headers: Headers }

let base = '';
let app: Json;
let db: Json;
let ocr: Json;
let pdfText: (data: Buffer) => Promise<string[]>;
let passwordHash = '';
const year = new Date().toLocaleString('en', { timeZone: 'Europe/Bucharest', year: 'numeric' });

class Client {
  cookie = '';
  constructor(readonly headers: Record<string, string> = {}) {}

  private async send(method: string, url: string, body?: BodyInit, contentType?: string): Promise<Reply> {
    const headers: Record<string, string> = { ...this.headers };
    if (this.cookie) headers.cookie = this.cookie;
    if (contentType) headers['content-type'] = contentType;
    const res = await fetch(base + url, { method, headers, body });
    const set = res.headers.getSetCookie().find((c) => c.startsWith('seadoc_session='));
    if (set) this.cookie = set.split(';')[0];
    const buffer = Buffer.from(await res.arrayBuffer());
    const text = buffer.toString('utf8');
    let parsed: Json = null;
    if ((res.headers.get('content-type') ?? '').includes('json')) parsed = JSON.parse(text);
    return { status: res.status, body: parsed, text, headers: res.headers };
  }

  get(url: string) { return this.send('GET', url); }
  del(url: string) { return this.send('DELETE', url); }
  post(url: string, body: Json = {}) { return this.send('POST', url, JSON.stringify(body), 'application/json'); }
  put(url: string, body: Json = {}) { return this.send('PUT', url, JSON.stringify(body), 'application/json'); }
  patch(url: string, body: Json = {}) { return this.send('PATCH', url, JSON.stringify(body), 'application/json'); }

  upload(url: string, fields: Record<string, unknown>, file?: { name: string; data: Buffer; type?: string }) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    if (file) form.set('file', new Blob([new Uint8Array(file.data)], { type: file.type ?? 'application/octet-stream' }), file.name);
    return this.send('POST', url, form);
  }

  async bytes(url: string): Promise<{ status: number; data: Buffer; headers: Headers }> {
    const res = await fetch(base + url, { headers: { ...this.headers, cookie: this.cookie } });
    return { status: res.status, data: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  }
}

async function login(username: string, password = PASSWORD, headers: Record<string, string> = {}) {
  const client = new Client(headers);
  const r = await client.post('/api/auth/login', { username, password });
  assert.equal(r.status, 200, `autentificare ${username}: ${r.text}`);
  return client;
}

async function addUser(username: string, role: string, departmentId: number | null, extra: { jobTitle?: string } = {}): Promise<number> {
  return (await db.one(
    `INSERT INTO users (username, full_name, password_hash, role, department_id, job_title) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [username, `Test ${username}`, passwordHash, role, departmentId, extra.jobTitle ?? null])).id;
}

const ids: Record<string, number> = {};
const clients: Record<string, Client> = {};
let seq = 0;

async function pdf(title: string, paragraphs: string[], createdAt?: Date) {
  return textPdf({ title, paragraphs, createdAt });
}

/** Înregistrează un document printr-un POST real și întoarce răspunsul. */
async function addDocument(by: string, fields: Record<string, unknown>, data?: Buffer, name = 'document.pdf') {
  const title = String(fields.title ?? `Document ${++seq}`);
  const buffer = data ?? (await pdf(title, [`Conținut de test numărul ${++seq} pentru documentul ${title}, cu suficient text ca să treacă de pragul de pagină.`]));
  const r = await clients[by].upload('/api/documents', { title, documentTypeId: ids.type, departmentId: ids.alpha, ...fields }, { name, data: buffer, type: 'application/pdf' });
  assert.equal(r.status, 201, r.text);
  return r.body as { id: number; regLabel: string | null; versionId: number };
}

const listIds = async (client: Client, query = '') => {
  const r = await client.get(`/api/documents?limit=200${query}`);
  assert.equal(r.status, 200, r.text);
  return (r.body.items as { id: number }[]).map((d) => d.id);
};
const search = (client: Client, q: string) => listIds(client, `&q=${encodeURIComponent(q)}`);

/** Așază direct în arhivă, cu termenul expirat: singura cale de a obține un termen din trecut. */
async function archivedExpired(by = 'manager') {
  const doc = await addDocument(by, { title: `Document expirat ${++seq}` });
  await ocr.drain();
  await db.query(
    `UPDATE documents SET status = 'arhivat', archived_at = now() - interval '6 years', closed_at = now() - interval '6 years', retention_until = current_date - 30 WHERE id = $1`, [doc.id]);
  return doc;
}

before(async () => {
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE');
  await admin.query('CREATE SCHEMA public');
  await admin.end();

  // Testele nu depind de existența unui build al aplicației web.
  const { config } = await import('../src/config.js');
  config.webDist = path.join(storageDir, 'fara-web');
  const main = await import('../src/main.js');
  const { Db } = await import('../src/db.js');
  const { OcrService, pdfText: extract } = await import('../src/ocr.js');
  const { hashPassword } = await import('../src/auth.js');
  pdfText = extract;
  passwordHash = hashPassword(PASSWORD);
  app = await main.createApp({ logger: ['error'] });
  db = app.get(Db);
  ocr = app.get(OcrService);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;

  ids.alpha = (await db.one(`INSERT INTO departments (name) VALUES ('Alpha') RETURNING id`)).id;
  ids.beta = (await db.one(`INSERT INTO departments (name) VALUES ('Beta') RETURNING id`)).id;
  ids.type = (await db.one(
    `INSERT INTO document_types (name, nomenclator_code, retention_years, fields) VALUES ('Tip test','T-1',5,$1) RETURNING id`,
    [JSON.stringify([{ key: 'categorie', label: 'Categorie', type: 'text', required: false }])])).id;
  ids.permanent = (await db.one(`INSERT INTO document_types (name, nomenclator_code, retention_years) VALUES ('Tip permanent','T-2',NULL) RETURNING id`)).id;
  ids.register = (await db.one(`INSERT INTO registers (name, code) VALUES ('Registru test','RT') RETURNING id`)).id;

  ids.admin = await addUser('admin.test', 'admin', ids.alpha);
  ids.admin2 = await addUser('admin.doi', 'admin', ids.beta);
  ids.manager = await addUser('manager.alpha', 'manager', ids.alpha);
  ids.managerB = await addUser('manager.beta', 'manager', ids.beta);
  ids.user = await addUser('user.alpha', 'user', ids.alpha);
  ids.outsider = await addUser('user.beta', 'user', ids.beta);
  ids.registratura = await addUser('registratura.test', 'registratura', ids.alpha);
  ids.arhivar = await addUser('arhivar.test', 'arhivar', ids.beta);
  await db.query('UPDATE departments SET manager_id = $2 WHERE id = $1', [ids.alpha, ids.manager]);

  clients.admin = await login('admin.test');
  clients.admin2 = await login('admin.doi');
  clients.manager = await login('manager.alpha');
  clients.managerB = await login('manager.beta');
  clients.user = await login('user.alpha');
  clients.outsider = await login('user.beta');
  clients.registratura = await login('registratura.test');
  clients.arhivar = await login('arhivar.test');
});

after(async () => {
  await app?.close();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('autentificare', () => {
  test('autentificare reușită și eșuată, cu erori în română', async () => {
    const ok = new Client();
    const r = await ok.post('/api/auth/login', { username: 'ADMIN.test', password: PASSWORD });
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'ok');
    assert.equal(r.body.user.username, 'admin.test');
    assert.ok(r.body.user.permissions.includes('users_admin'));
    assert.equal((await ok.get('/api/auth/me')).body.user.username, 'admin.test');
    assert.equal((await ok.post('/api/auth/logout')).status, 200);
    assert.equal((await ok.get('/api/auth/me')).status, 401);

    const bad = await new Client().post('/api/auth/login', { username: 'admin.test', password: 'gresit' });
    assert.equal(bad.status, 401);
    assert.deepEqual(bad.body, { message: 'Utilizator sau parolă incorecte' });
    assert.equal((await new Client().post('/api/auth/login', { username: 'nu.exista', password: 'x' })).status, 401);
    assert.equal((await new Client().get('/api/documents')).status, 401);
  });

  test('cererea fără conținut nu produce eroare de server', async () => {
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST' });
    assert.equal(res.status, 401);
  });

  test('contul se blochează după încercări eșuate, chiar și cu parola corectă', async () => {
    await addUser('blocat.test', 'user', ids.alpha);
    for (let i = 0; i < 5; i++) {
      assert.equal((await new Client().post('/api/auth/login', { username: 'blocat.test', password: 'gresit' })).status, 401);
    }
    const locked = await new Client().post('/api/auth/login', { username: 'blocat.test', password: PASSWORD });
    assert.equal(locked.status, 423);
    assert.match(locked.body.message, /blocat/);
    const actions = (await db.query(`SELECT action FROM audit_log WHERE username = 'blocat.test' ORDER BY seq`)).rows.map((r: Json) => r.action);
    assert.ok(actions.includes('auth.cont_blocat'));
    assert.ok(actions.includes('auth.login_blocat'));
  });

  test('accesul din afara rețelei cere MFA; codul TOTP real se acceptă o singură dată', async () => {
    await addUser('remote.test', 'user', ids.alpha);
    const remote = { 'x-forwarded-for': REMOTE_IP };

    const first = new Client(remote);
    const r = await first.post('/api/auth/login', { username: 'remote.test', password: PASSWORD });
    assert.equal(r.body.state, 'mfa_enrol');
    assert.equal(r.body.user, undefined);
    assert.equal((await first.get('/api/documents')).status, 401);

    const enrol = await first.post('/api/auth/mfa/enrol');
    assert.equal(enrol.status, 200);
    assert.match(enrol.body.qr, /^data:image\/png/);
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(enrol.body.secret), digits: 6, period: 30 });
    assert.equal((await first.post('/api/auth/mfa/verify', { code: '000000' === totp.generate() ? '111111' : '000000' })).status, 401);
    const code = totp.generate();
    const verified = await first.post('/api/auth/mfa/verify', { code });
    assert.equal(verified.status, 200, verified.text);
    assert.equal(verified.body.state, 'ok');
    assert.equal((await first.get('/api/documents')).status, 200);
    assert.equal((await first.post('/api/auth/mfa/enrol')).status, 409);

    // Același cod, în altă sesiune: respins.
    const second = new Client(remote);
    assert.equal((await second.post('/api/auth/login', { username: 'remote.test', password: PASSWORD })).body.state, 'mfa');
    assert.equal((await second.get('/api/documents')).status, 401);
    assert.equal((await second.post('/api/auth/mfa/verify', { code })).status, 401);
    assert.equal((await second.get('/api/documents')).status, 401);

    // Codul următor trece, iar reluarea lui nu.
    const next = totp.generate({ timestamp: Date.now() + 30_000 });
    assert.equal((await second.post('/api/auth/mfa/verify', { code: next })).status, 200);
    assert.equal((await second.get('/api/documents')).status, 200);
    const third = new Client(remote);
    await third.post('/api/auth/login', { username: 'remote.test', password: PASSWORD });
    assert.equal((await third.post('/api/auth/mfa/verify', { code: next })).status, 401);

    // Cu MFA activ, și din rețeaua internă se cere al doilea pas.
    const internal = new Client();
    assert.equal((await internal.post('/api/auth/login', { username: 'remote.test', password: PASSWORD })).body.state, 'mfa');
  });

  test('două cereri simultane cu același cod TOTP: una singură reușește', async () => {
    await addUser('simultan.test', 'user', ids.alpha);
    const remote = { 'x-forwarded-for': REMOTE_IP };
    const [a, b] = [new Client(remote), new Client(remote)];
    await a.post('/api/auth/login', { username: 'simultan.test', password: PASSWORD });
    await b.post('/api/auth/login', { username: 'simultan.test', password: PASSWORD });
    const { secret } = (await a.post('/api/auth/mfa/enrol')).body;
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
    const replies = await Promise.all([a, b].map((c) => c.post('/api/auth/mfa/verify', { code })));
    assert.deepEqual(replies.map((r) => r.status).sort(), [200, 401]);
  });

  test('parola dată de administrator este temporară', async () => {
    const created = await clients.admin.post('/api/admin/users', { username: 'nou.angajat', fullName: 'Angajat Nou', password: PASSWORD, role: 'user', departmentId: ids.alpha });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.mustChangePassword, true);
    const client = new Client();
    assert.equal((await client.post('/api/auth/login', { username: 'nou.angajat', password: PASSWORD })).body.state, 'change_password');
    assert.equal((await client.get('/api/documents')).status, 403);
    assert.equal((await client.post('/api/auth/password', { current: PASSWORD, next: 'scurta' })).status, 400);
    const changed = await client.post('/api/auth/password', { current: PASSWORD, next: 'Parola-Noua-2027!' });
    assert.equal(changed.body.state, 'ok');
    assert.equal((await client.get('/api/documents')).status, 200);
  });
});

describe('erori și anteturi', () => {
  test('anteturile de securitate apar pe toate răspunsurile', async () => {
    for (const res of [await fetch(`${base}/api/auth/me`), await fetch(`${base}/api/ruta-inexistenta`)]) {
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
      assert.equal(res.headers.get('referrer-policy'), 'same-origin');
      const csp = res.headers.get('content-security-policy')!;
      assert.match(csp, /style-src 'self' 'unsafe-inline'/);
      assert.match(csp, /img-src 'self' data:/);
      assert.match(csp, /frame-src 'self'/);
      assert.match(csp, /object-src 'self'/);
    }
  });

  test('erorile cadrului au forma { message } în română', async () => {
    const missing = await clients.admin.get('/api/ruta-inexistenta');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { message: 'Resursa nu a fost găsită' });
    const malformed = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nu e json' });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { message: 'Cerere invalidă' });
    const badDate = await clients.admin.get('/api/documents?from=nu-e-data');
    assert.equal(badDate.status, 400);
  });

  test('JSON peste 5 MB și fișier peste limită: 413 cu mesaj în română', async () => {
    const big = await clients.admin.post('/api/workflows/validate', { xml: 'x'.repeat(6 * 1024 * 1024) });
    assert.equal(big.status, 413);
    assert.match(big.body.message, /depășește/);
    // BPMN de până la 5 MB încape.
    assert.equal((await clients.admin.post('/api/workflows/validate', { xml: 'x'.repeat(4 * 1024 * 1024) })).status, 200);

    const { config } = await import('../src/config.js');
    const huge = Buffer.alloc(config.maxUploadBytes + 1024);
    huge.write('%PDF');
    const r = await clients.manager.upload('/api/documents', { title: 'Prea mare', documentTypeId: ids.type }, { name: 'mare.pdf', data: huge });
    assert.equal(r.status, 413);
    assert.match(r.body.message, /Fișierul depășește/);
  });
});

describe('aplicația web', () => {
  test('în afara /api: fără build web, 404 JSON cu anteturi de securitate', async () => {
    const res = await fetch(`${base}/documente/5`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { message: 'Resursa nu a fost găsită' });
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(res.headers.get('content-security-policy')!, /default-src 'self'/);
  });

  test('cu build web: fișiere statice și index.html pentru rutele SPA, fără să acopere /api', async () => {
    const { config } = await import('../src/config.js');
    const { createApp } = await import('../src/main.js');
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'seadoc-web-'));
    fs.mkdirSync(path.join(dist, 'assets'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>SeaDoc SPA</title>');
    fs.writeFileSync(path.join(dist, 'assets/app.js'), 'console.log(1)');
    const original = config.webDist;
    config.webDist = dist;
    const web = await createApp({ logger: ['error'] });
    config.webDist = original;
    try {
      await web.listen(0, '127.0.0.1');
      const url = `http://127.0.0.1:${(web.getHttpServer().address() as { port: number }).port}`;
      for (const route of ['/', '/documente/5', '/admin/utilizatori']) {
        const res = await fetch(url + route);
        assert.equal(res.status, 200, route);
        assert.match(await res.text(), /SeaDoc SPA/);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.match(res.headers.get('content-security-policy')!, /style-src 'self' 'unsafe-inline'/);
      }
      const asset = await fetch(`${url}/assets/app.js`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get('content-type')!, /javascript/);
      assert.equal((await fetch(`${url}/assets/lipsa.js`)).status, 404);
      assert.equal((await fetch(`${url}/documente/5`, { method: 'POST' })).status, 404);
      const api = await fetch(`${url}/api/nu-exista`);
      assert.equal(api.status, 404);
      assert.deepEqual(await api.json(), { message: 'Resursa nu a fost găsită' });
      assert.equal((await fetch(`${url}/api/documents`)).status, 401);
      assert.equal((await fetch(`${url}/api`)).status, 404);
    } finally {
      await web.close();
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe('înregistrare și numerotare', () => {
  test('numere consecutive în registru și contor anual', async () => {
    const a = await addDocument('registratura', { title: 'Primul din registru', registerId: ids.register });
    const b = await addDocument('registratura', { title: 'Al doilea din registru', registerId: ids.register });
    const parse = (label: string | null) => label!.match(/^RT-(\d{5})\/(\d{4})$/)!;
    assert.equal(parse(a.regLabel)[2], year);
    assert.equal(Number(parse(b.regLabel)[1]), Number(parse(a.regLabel)[1]) + 1);

    // Contorul de anul trecut nu influențează numerotarea din anul curent.
    const other = (await db.one(`INSERT INTO registers (name, code) VALUES ('Registru anual','RA') RETURNING id`)).id;
    await db.query('INSERT INTO register_counters (register_id, year, last_number) VALUES ($1,$2,500)', [other, Number(year) - 1]);
    assert.equal((await addDocument('registratura', { title: 'Primul din an', registerId: other })).regLabel, `RA-00001/${year}`);
    assert.equal((await addDocument('registratura', { title: 'Al doilea din an', registerId: other })).regLabel, `RA-00002/${year}`);
    const counters = (await db.query('SELECT year, last_number FROM register_counters WHERE register_id = $1 ORDER BY year', [other])).rows;
    assert.deepEqual(counters, [{ year: Number(year) - 1, last_number: 500 }, { year: Number(year), last_number: 2 }]);
  });

  test('10 înregistrări simultane primesc numere unice și consecutive', async () => {
    const register = (await db.one(`INSERT INTO registers (name, code) VALUES ('Registru concurent','RC') RETURNING id`)).id;
    const data = await pdf('Concurență', ['Document folosit pentru a verifica numerotarea în paralel, fără duplicate.']);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      clients.registratura.upload('/api/documents', { title: `Paralel ${i}`, documentTypeId: ids.type, registerId: register }, { name: 'p.pdf', data })));
    assert.deepEqual(results.map((r) => r.status), Array(10).fill(201));
    const labels = results.map((r) => r.body.regLabel).sort();
    assert.deepEqual(labels, Array.from({ length: 10 }, (_, i) => `RC-${String(i + 1).padStart(5, '0')}/${year}`));
  });

  test('metadatele se validează după tipul documentului, iar utilizatorul simplu nu înregistrează', async () => {
    const required = (await clients.admin.post('/api/admin/document-types', {
      name: 'Tip validat', nomenclatorCode: 'V-1', retentionYears: 1,
      fields: [{ key: 'nr', label: 'Număr', type: 'number', required: true }, { key: 'zi', label: 'Zi', type: 'date', required: false }],
    })).body;
    const data = await pdf('Validare', ['Text suficient pentru validarea metadatelor documentului de test.']);
    const post = (metadata: Json) => clients.manager.upload('/api/documents', { title: 'Validare', documentTypeId: required.id, metadata }, { name: 'v.pdf', data });
    assert.match((await post({})).body.message, /Câmp obligatoriu: Număr/);
    assert.equal((await post({ nr: 'abc' })).status, 400);
    assert.equal((await post({ nr: '3', zi: 'mâine' })).status, 400);
    assert.equal((await post({ nr: '3', zi: '2026-01-02', necunoscut: 'x' })).status, 201);
    assert.equal((await clients.user.upload('/api/documents', { title: 'Interzis', documentTypeId: ids.type }, { name: 'u.pdf', data })).status, 403);
  });

  test('numele de fișier cu diacritice se păstrează', async () => {
    const doc = await addDocument('manager', { title: 'Fișier cu diacritice' }, undefined, 'Instrucțiune șă.pdf');
    assert.equal((await clients.manager.get(`/api/documents/${doc.id}`)).body.versions[0].filename, 'Instrucțiune șă.pdf');
  });

  test('tipurile de fișier periculoase sau false sunt respinse', async () => {
    const attempts: [string, Buffer, string][] = [
      ['virus.exe', Buffer.from('MZ\x90\x00 executabil'), 'application/pdf'],
      ['pagina.html', Buffer.from('<script>alert(1)</script>'), 'text/plain'],
      ['imagine.svg', Buffer.from('<svg onload="alert(1)"/>'), 'image/png'],
      ['fals.pdf', Buffer.from('<html>nu sunt pdf</html>'), 'application/pdf'],
      ['fals.png', Buffer.from('nu sunt png'), 'image/png'],
      ['fals.docx', Buffer.from('nu sunt zip'), 'application/msword'],
      ['fara-extensie', Buffer.from('%PDF-1.4'), 'application/pdf'],
      ['binar.txt', Buffer.from([0x41, 0x00, 0x42]), 'text/plain'],
    ];
    for (const [name, data, type] of attempts) {
      const r = await clients.manager.upload('/api/documents', { title: 'Malițios', documentTypeId: ids.type }, { name, data, type });
      assert.equal(r.status, 400, `${name}: ${r.text}`);
      assert.ok(r.body.message, name);
    }
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM documents WHERE title = 'Malițios'`)).n, 0);
  });

  test('fișierul stă criptat pe disc și se întoarce intact', async () => {
    const secret = 'Confidențial-Plan-Salarii-Unic';
    const data = await pdf(secret, [`${secret}. Un text care nu trebuie să apară niciodată în clar pe disc.`]);
    const doc = await addDocument('manager', { title: 'Criptat' }, data);
    const key = (await db.one('SELECT storage_key FROM document_versions WHERE id = $1', [doc.versionId])).storage_key;
    const raw = fs.readFileSync(path.join(storageDir, key));
    assert.ok(!raw.includes('%PDF'));
    assert.ok(!raw.includes(secret));
    assert.ok(!raw.equals(data));
    assert.equal(raw.length, data.length + 28);
    assert.equal(fs.statSync(path.join(storageDir, key)).mode & 0o077, 0);
    const back = await clients.manager.bytes(`/api/documents/${doc.id}/file?kind=original`);
    assert.equal(back.status, 200);
    assert.ok(back.data.equals(data));
    assert.equal(back.headers.get('content-type'), 'application/pdf');
    // O alterare de pe disc nu trece de autentificarea AES-GCM.
    const tampered = Buffer.from(raw);
    tampered[tampered.length - 1] ^= 0xff;
    fs.writeFileSync(path.join(storageDir, key), tampered);
    assert.equal((await clients.manager.get(`/api/documents/${doc.id}/file?kind=original`)).status, 500);
    fs.writeFileSync(path.join(storageDir, key), raw);
  });
});

describe('permisiuni', () => {
  test('aceeași listă diferă după rol, iar fără acces detaliul și fișierul dau 404', async () => {
    const word = 'zambilaunica';
    const alpha = await addDocument('manager', { title: `Matrice alpha ${word}`, departmentId: ids.alpha });
    const beta = await addDocument('managerB', { title: `Matrice beta ${word}`, departmentId: ids.beta });
    await ocr.drain();
    const found = (ids_: number[]) => [alpha.id, beta.id].filter((id) => ids_.includes(id));
    assert.deepEqual(found(await search(clients.admin, word)), [alpha.id, beta.id]);
    assert.deepEqual(found(await search(clients.manager, word)), [alpha.id]);
    assert.deepEqual(found(await search(clients.managerB, word)), [beta.id]);
    assert.deepEqual(found(await search(clients.user, word)), []);
    assert.deepEqual(found(await listIds(clients.user)), []);

    const adminTotal = (await clients.admin.get('/api/documents')).body.total;
    const managerTotal = (await clients.manager.get('/api/documents')).body.total;
    assert.ok(adminTotal > managerTotal);
    assert.equal((await clients.user.get('/api/documents')).body.total, 0);

    for (const client of [clients.user, clients.managerB, clients.outsider]) {
      assert.equal((await client.get(`/api/documents/${alpha.id}`)).status, 404);
      assert.equal((await client.get(`/api/documents/${alpha.id}/file`)).status, 404);
      assert.equal((await client.get(`/api/documents/${alpha.id}/text`)).status, 404);
      assert.equal((await client.get(`/api/documents/${alpha.id}/status`)).status, 404);
    }
    assert.equal((await clients.manager.get(`/api/documents/${alpha.id}`)).status, 200);
    assert.equal((await clients.admin.get(`/api/documents/${alpha.id}/file`)).status, 200);

    // Accesul controlat îl face vizibil, iar revocarea îl ascunde la loc.
    const grant = await clients.admin.post('/api/admin/grants', { userId: ids.user, scope: 'document', targetId: alpha.id });
    assert.equal(grant.status, 201, grant.text);
    assert.equal((await clients.admin.post('/api/admin/grants', { userId: ids.user, scope: 'document', targetId: alpha.id })).status, 409);
    assert.equal((await clients.user.get(`/api/documents/${alpha.id}`)).status, 200);
    assert.deepEqual(found(await search(clients.user, word)), [alpha.id]);
    assert.equal((await clients.admin.get(`/api/admin/grants?userId=${ids.user}`)).body[0].targetName.includes('Matrice'), true);
    assert.equal((await clients.admin.del(`/api/admin/grants/${grant.body.id}`)).status, 200);
    assert.equal((await clients.user.get(`/api/documents/${alpha.id}`)).status, 404);
    assert.deepEqual(found(await search(clients.user, word)), []);
  });

  test('un cont neadministrator este oprit la /admin', async () => {
    for (const client of [clients.manager, clients.user, clients.registratura, clients.arhivar]) {
      for (const url of ['/api/admin/users', '/api/admin/settings', '/api/admin/grants']) assert.equal((await client.get(url)).status, 403, url);
      assert.equal((await client.post('/api/admin/users', { username: 'x.y', fullName: 'X', password: PASSWORD, role: 'admin' })).status, 403);
      assert.equal((await client.patch(`/api/admin/users/${ids.user}`, { role: 'admin' })).status, 403);
    }
    assert.equal((await new Client().get('/api/admin/users')).status, 401);
    const users = await clients.admin.get('/api/admin/users');
    assert.equal(users.status, 200);
    const text = JSON.stringify(users.body);
    assert.ok(!text.includes('scrypt'));
    assert.ok(!/password_hash|totp_secret|totpSecret/.test(text));
  });
});

describe('căutare', () => {
  let modern: number;
  let legacy: number;
  let control: number;

  before(async () => {
    modern = (await addDocument('manager', { title: 'Regulament modern' }, await pdf('Regulament modern', [
      'Reguli privind sănătatea și securitatea lucrătorilor. Toți șoferii respectă aceste instrucțiuni la ieșirea din țară.',
    ]))).id;
    legacy = (await addDocument('manager', { title: 'Regulament vechi' }, await pdf('Regulament vechi', [
      'Document scris cu sedile, așa cum exportau sistemele vechi: şoferii respectă instrucţiuni noi privind ţara şi sănătatea.',
    ]))).id;
    control = (await addDocument('manager', { title: 'Alt document' }, await pdf('Alt document', [
      'Un document fără legătură cu subiectul celorlalte, despre bilete, abonamente, stații și orarul liniilor.',
    ]))).id;
    await ocr.drain();
  });

  const expectBoth = async (q: string) => {
    const found = await search(clients.manager, q);
    assert.ok(found.includes(modern), `„${q}” găsește documentul modern`);
    assert.ok(found.includes(legacy), `„${q}” găsește documentul cu sedile`);
    assert.ok(!found.includes(control), `„${q}” nu găsește documentul martor`);
  };

  test('cu și fără diacritice, în ambele sensuri', async () => {
    for (const q of ['sănătate', 'sanatate', 'SĂNĂTATEA', 'sanatatea']) await expectBoth(q);
  });

  test('ș și ț cu virgulă, ş și ţ cu sedilă, și forma fără diacritice', async () => {
    for (const q of ['șoferii', 'şoferii', 'soferii', 'instrucțiuni', 'instrucţiuni', 'instructiuni', 'șofer', 'sofer']) await expectBoth(q);
  });

  test('rezultatul are fragmentul evidențiat și numărul total corect', async () => {
    const r = await clients.manager.get(`/api/documents?q=${encodeURIComponent('sanatate')}`);
    const item = r.body.items.find((d: Json) => d.id === modern);
    assert.match(item.snippet, /<mark>[^<]*<\/mark>/);
    assert.ok(r.body.total >= 2);
    assert.ok(!(await search(clients.manager, 'cuvantinexistentxyz')).length);
  });

  test('căutare după număr de registru, metadate și filtre', async () => {
    const doc = await addDocument('manager', { title: 'Cu metadate', registerId: ids.register, metadata: { categorie: 'Fără discriminare' } });
    const label = (await clients.manager.get(`/api/documents/${doc.id}`)).body.regLabel;
    assert.ok((await search(clients.manager, label)).includes(doc.id));
    assert.ok((await listIds(clients.manager, `&number=${encodeURIComponent(label)}`)).includes(doc.id));
    assert.ok((await listIds(clients.manager, `&meta.categorie=${encodeURIComponent('fara discriminare')}`)).includes(doc.id));
    assert.ok(!(await listIds(clients.manager, '&direction=iesit')).includes(doc.id));
    await clients.manager.put(`/api/documents/${doc.id}/favorite`);
    assert.deepEqual(await listIds(clients.manager, '&favorites=1'), [doc.id]);
    await clients.manager.del(`/api/documents/${doc.id}/favorite`);
    assert.deepEqual(await listIds(clients.manager, '&favorites=1'), []);
  });
});

describe('OCR', () => {
  test('PDF scanat: OCR real, căutabil după un cuvânt românesc, cu strat de text în rezultat', { timeout: 240_000 }, async () => {
    const scan = await scannedPdf(SCANNED_SAMPLE);
    assert.ok((await pdfText(scan)).join('').trim().length === 0, 'PDF-ul de intrare nu are text');
    const doc = await addDocument('manager', { title: 'Scanare fără text în titlu' }, scan, 'scan.pdf');
    assert.equal((await clients.manager.get(`/api/documents/${doc.id}/status`)).body.versions[0].ocrStatus, 'in_asteptare');
    assert.ok(!(await search(clients.manager, 'hamul')).includes(doc.id));

    await ocr.drain();

    const status = (await clients.manager.get(`/api/documents/${doc.id}/status`)).body.versions[0];
    assert.equal(status.ocrStatus, 'finalizat');
    assert.equal(status.ocrUsed, true);
    assert.equal(status.hasSearchable, true);
    const text = (await clients.manager.get(`/api/documents/${doc.id}/text`)).body.text;
    assert.match(text, /hamul de siguranță/);

    for (const q of ['hamul', 'răspunderea', 'raspunderea', 'platformă', 'platforma']) {
      assert.ok((await search(clients.manager, q)).includes(doc.id), `caută „${q}”`);
    }

    const searchable = await clients.manager.bytes(`/api/documents/${doc.id}/file?kind=searchable`);
    assert.equal(searchable.status, 200);
    assert.match(decodeURIComponent(searchable.headers.get('content-disposition')!), /scan-cautabil\.pdf/);
    const layer = (await pdfText(searchable.data)).join(' ');
    assert.match(layer, /hamul de siguranță/);
    assert.match(layer, /tramvaiului/);
    const original = await clients.manager.bytes(`/api/documents/${doc.id}/file?kind=original`);
    assert.ok(original.data.equals(scan));

    const audit = await db.one(`SELECT details FROM audit_log WHERE action = 'document.ocr' AND document_id = $1`, [doc.id]);
    assert.ok(audit.details.caractere > 100);
  });
});

describe('duplicate', () => {
  const longText = [
    'Registrul de evidență a echipamentelor de protecție cuprinde toate bunurile distribuite lucrătorilor din ateliere, cu data predării și semnătura de primire.',
    'Înlocuirea se face la expirarea duratei normate sau la deteriorare, pe baza unui referat aprobat de șeful de compartiment și a predării echipamentului uzat.',
    'Gestionarul magaziei actualizează lunar stocul, iar inventarul anual se finalizează printr-un proces-verbal semnat de comisia desemnată de conducere.',
  ];

  test('același fișier este semnalat după amprentă', async () => {
    const data = await pdf('Fișier identic', ['Un fișier încărcat de două ori, cu exact aceiași octeți, trebuie semnalat după amprenta SHA-256.']);
    const a = await addDocument('manager', { title: 'Copie fișier unu' }, data);
    const b = await addDocument('manager', { title: 'Încărcare a doua, alt nume' }, data);
    await ocr.drain();
    const dup = (await clients.manager.get(`/api/documents/${b.id}`)).body.duplicates;
    assert.ok(dup.some((d: Json) => d.kind === 'amprenta' && d.id === a.id && d.score === 1), JSON.stringify(dup));
    const audit = await db.query(`SELECT 1 FROM audit_log WHERE action = 'document.duplicat_detectat' AND document_id = $1`, [b.id]);
    assert.equal(audit.rowCount, 1);
  });

  test('același conținut în fișiere diferite este semnalat după text; fără acces apare doar avertismentul', async () => {
    const a = await addDocument('manager', { title: 'Evidența echipamentelor de protecție' }, await pdf('Evidența echipamentelor', longText, new Date('2025-01-01T00:00:00Z')));
    await ocr.drain();
    const near = [longText[0], longText[1], longText[2].replace('anual', 'de la sfârșitul anului')];
    const b = await addDocument('managerB', { title: 'Registru lucrători ateliere', departmentId: ids.beta }, await pdf('Evidența echipamentelor', near, new Date('2025-06-01T00:00:00Z')));
    await ocr.drain();
    const shaA = (await db.one('SELECT sha256 FROM document_versions WHERE id = $1', [a.versionId])).sha256;
    const shaB = (await db.one('SELECT sha256 FROM document_versions WHERE id = $1', [b.versionId])).sha256;
    assert.notEqual(shaA, shaB);
    const asAdmin = (await clients.admin.get(`/api/documents/${b.id}`)).body.duplicates;
    assert.ok(asAdmin.some((d: Json) => d.kind === 'text' && d.id === a.id && d.score > 0.7), JSON.stringify(asAdmin));
    const asOwner = (await clients.managerB.get(`/api/documents/${b.id}`)).body.duplicates;
    const hidden = asOwner.find((d: Json) => d.kind === 'text');
    assert.equal(hidden.restricted, true);
    assert.equal(hidden.id, undefined);
    assert.equal(hidden.title, undefined);
  });
});

describe('arhivă', () => {
  test('arhivarea face documentul imuabil, iar consultarea se jurnalizează', async () => {
    const doc = await addDocument('manager', { title: 'De arhivat', registerId: ids.register });
    assert.equal((await clients.manager.post(`/api/documents/${doc.id}/archive`)).status, 409, 'OCR în așteptare');
    await ocr.drain();
    assert.equal((await clients.user.post(`/api/documents/${doc.id}/archive`)).status, 404);
    assert.equal((await clients.managerB.post(`/api/documents/${doc.id}/archive`)).status, 404);

    const r = await clients.manager.post(`/api/documents/${doc.id}/archive`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, 'arhivat');
    const expected = new Date();
    expected.setFullYear(expected.getFullYear() + 5);
    assert.equal(r.body.retentionUntil.slice(0, 4), String(expected.getFullYear()));
    assert.equal((await clients.manager.post(`/api/documents/${doc.id}/archive`)).status, 409);

    const data = await pdf('Versiune nouă', ['Încercare de a adăuga o versiune nouă unui document deja arhivat, ceea ce nu este permis.']);
    assert.equal((await clients.manager.upload(`/api/documents/${doc.id}/versions`, {}, { name: 'v2.pdf', data })).status, 409);
    await assert.rejects(db.query(`UPDATE documents SET title = 'schimbat' WHERE id = $1`, [doc.id]), /nu se mai poate modifica/);
    await assert.rejects(db.query(`UPDATE documents SET status = 'aprobat' WHERE id = $1`, [doc.id]), /nu se mai poate modifica/);
    await assert.rejects(
      db.query(`INSERT INTO document_versions (document_id, version_no, filename, mime, size_bytes, sha256, created_by) VALUES ($1, 9, 'x', 'x', 1, 'x', $2)`, [doc.id, ids.manager]),
      /nu acceptă versiuni/);

    const count = async () => (await db.one(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'arhiva.consultare' AND document_id = $1`, [doc.id])).n;
    assert.equal(await count(), 0);
    const detail = await clients.arhivar.get(`/api/documents/${doc.id}`);
    assert.equal(detail.status, 200, 'arhivarul vede documentele arhivate');
    assert.equal(detail.body.canArchive, false);
    assert.equal(detail.body.canEdit, false);
    assert.equal(await count(), 1);
    assert.equal((await clients.arhivar.get(`/api/documents/${doc.id}/file`)).status, 200);
    assert.equal(await count(), 2);
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'arhiva.arhivare' AND document_id = $1`, [doc.id])).n, 1);
  });

  test('tipul permanent nu are termen, iar fluxul activ blochează arhivarea', async () => {
    const permanent = await addDocument('manager', { title: 'Permanent', documentTypeId: ids.permanent });
    const active = await addDocument('manager', { title: 'În flux' });
    await ocr.drain();
    const def = (await db.one(`INSERT INTO workflow_definitions (key, version, name, xml) VALUES ('test-arhiva', 1, 'T', '<x/>') RETURNING id`)).id;
    const instance = (await db.one(`INSERT INTO workflow_instances (definition_id, document_id, started_by) VALUES ($1,$2,$3) RETURNING id`, [def, active.id, ids.manager])).id;
    assert.equal((await clients.manager.post(`/api/documents/${active.id}/archive`)).status, 409);
    await db.query(`UPDATE workflow_instances SET status = 'aprobat', finished_at = now() WHERE id = $1`, [instance]);
    assert.equal((await clients.manager.post(`/api/documents/${active.id}/archive`)).status, 200);

    const r = await clients.arhivar.post(`/api/documents/${permanent.id}/archive`);
    assert.equal(r.status, 200, 'arhivarul arhivează și în afara departamentului');
    assert.equal(r.body.retentionUntil, null);
    assert.equal((await clients.arhivar.post('/api/archive/proposals', { documentId: permanent.id })).status, 409);
  });

  test('lista arhivei cere dreptul potrivit și filtrează după expirare', async () => {
    const expired = await archivedExpired();
    assert.equal((await clients.manager.get('/api/archive')).status, 403);
    assert.equal((await clients.user.get('/api/archive/proposals')).status, 403);
    const all = await clients.arhivar.get('/api/archive?limit=200');
    assert.equal(all.status, 200);
    const item = all.body.items.find((d: Json) => d.id === expired.id);
    assert.equal(item.expired, true);
    assert.equal(item.proposalStatus, null);
    assert.equal(item.typeName, 'Tip test');
    assert.equal(item.nomenclatorCode, 'T-1');
    const only = await clients.arhivar.get('/api/archive?expired=1&limit=200');
    assert.ok(only.body.items.every((d: Json) => d.expired));
    assert.ok(only.body.total < all.body.total);
  });

  test('eliminarea respectă regula celor patru ochi și păstrează doar metadatele', async () => {
    const word = 'cuvantdeeliminat';
    const secretWord = 'mesajsecretarhivat';
    const data = await pdf(`Dosar ${word}`, [`Conținutul documentului include ${secretWord}, care trebuie să dispară din căutare după eliminare.`]);
    const doc = await addDocument('manager', { title: `Dosar ${word}`, metadata: { categorie: 'Rămâne' } }, data);
    await ocr.drain();
    const version = await db.one('SELECT storage_key, sha256 FROM document_versions WHERE id = $1', [doc.versionId]);
    // Un fișier căutabil, ca să se verifice și ștergerea lui.
    const searchableKey = await (await import('../src/storage.js')).StorageService.prototype.put.call(app.get((await import('../src/storage.js')).StorageService), Buffer.from('copie cautabila'));
    await db.query('UPDATE document_versions SET searchable_key = $2 WHERE id = $1', [doc.versionId, searchableKey]);

    const notExpired = await addDocument('manager', { title: 'Încă în termen' });
    await ocr.drain();
    await clients.manager.post(`/api/documents/${notExpired.id}/archive`);
    const early = await clients.arhivar.post('/api/archive/proposals', { documentId: notExpired.id });
    assert.equal(early.status, 409);
    assert.match(early.body.message, /nu a expirat/);

    assert.equal((await clients.arhivar.post('/api/archive/proposals', { documentId: doc.id })).status, 409, 'documentul nu este arhivat încă');
    await db.query(`UPDATE documents SET status = 'arhivat', archived_at = now(), retention_until = current_date - 1 WHERE id = $1`, [doc.id]);

    assert.equal((await clients.manager.post('/api/archive/proposals', { documentId: doc.id })).status, 403);
    const proposal = await clients.arhivar.post('/api/archive/proposals', { documentId: doc.id, reason: 'Termen depășit' });
    assert.equal(proposal.status, 201, proposal.text);
    assert.equal((await clients.admin.post('/api/archive/proposals', { documentId: doc.id })).status, 409, 'o singură propunere deschisă');
    const id = proposal.body.id;

    const self = await clients.arhivar.post(`/api/archive/proposals/${id}/decide`, { approve: true });
    assert.equal(self.status, 403);
    assert.match(self.body.message, /altă persoană/);
    assert.equal((await clients.manager.post(`/api/archive/proposals/${id}/decide`, { approve: true })).status, 403);
    assert.equal((await clients.admin.post(`/api/archive/proposals/${id}/decide`, {})).status, 400);
    assert.ok(fs.existsSync(path.join(storageDir, version.storage_key)), 'fișierul rămâne până la aprobare');

    const listed = (await clients.admin.get('/api/archive/proposals')).body.find((p: Json) => p.id === id);
    assert.equal(listed.status, 'propusa');
    assert.equal(listed.reason, 'Termen depășit');
    assert.equal(listed.proposedBy, 'Test arhivar.test');

    const decided = await clients.admin.post(`/api/archive/proposals/${id}/decide`, { approve: true });
    assert.equal(decided.status, 200, decided.text);
    assert.equal(decided.body.status, 'aprobata');
    assert.equal((await clients.admin2.post(`/api/archive/proposals/${id}/decide`, { approve: false })).status, 409);

    assert.ok(!fs.existsSync(path.join(storageDir, version.storage_key)), 'originalul a fost șters');
    assert.ok(!fs.existsSync(path.join(storageDir, searchableKey)), 'copia căutabilă a fost ștearsă');
    const row = await db.one(`SELECT d.status, d.content_text, d.title, d.metadata, v.storage_key, v.searchable_key, v.sha256, v.text_content
      FROM documents d JOIN document_versions v ON v.document_id = d.id WHERE d.id = $1`, [doc.id]);
    assert.equal(row.status, 'eliminat');
    assert.equal(row.content_text, '');
    assert.equal(row.text_content, '');
    assert.equal(row.storage_key, null);
    assert.equal(row.searchable_key, null);
    assert.equal(row.sha256, version.sha256);
    assert.equal(row.metadata.categorie, 'Rămâne');

    assert.equal((await clients.admin.get(`/api/documents/${doc.id}/file`)).status, 410);
    const detail = (await clients.admin.get(`/api/documents/${doc.id}`)).body;
    assert.equal(detail.status, 'eliminat');
    assert.equal(detail.versions[0].hasFile, false);
    assert.equal(detail.versions[0].sha256, version.sha256);
    assert.equal((await clients.admin.get(`/api/documents/${doc.id}/text`)).body.text, '');
    assert.ok(!(await search(clients.admin, secretWord)).includes(doc.id), 'textul nu se mai găsește');
    assert.ok((await search(clients.admin, word)).includes(doc.id), 'metadatele rămân căutabile');
    await assert.rejects(db.query(`UPDATE documents SET title = 'x' WHERE id = $1`, [doc.id]), /eliminat/);

    const after = (await clients.arhivar.get('/api/archive?limit=200')).body.items.find((d: Json) => d.id === doc.id);
    assert.equal(after.status, 'eliminat');
    assert.equal(after.expired, false);
    assert.equal(after.proposalStatus, 'aprobata');
    const actions = (await db.query(`SELECT action, username FROM audit_log WHERE document_id = $1 AND action LIKE 'arhiva.%' ORDER BY seq`, [doc.id])).rows;
    assert.deepEqual(actions.map((a: Json) => a.action).filter((a: string) => a !== 'arhiva.cautare'), ['arhiva.propunere_eliminare', 'arhiva.eliminare']);
    assert.equal(actions[1].username, 'admin.test');
  });

  test('o propunere respinsă nu atinge documentul și se poate propune din nou', async () => {
    const doc = await archivedExpired();
    const id = (await clients.arhivar.post('/api/archive/proposals', { documentId: doc.id })).body.id;
    const r = await clients.admin.post(`/api/archive/proposals/${id}/decide`, { approve: false });
    assert.equal(r.body.status, 'respinsa');
    const row = await db.one(`SELECT d.status, v.storage_key FROM documents d JOIN document_versions v ON v.document_id = d.id WHERE d.id = $1`, [doc.id]);
    assert.equal(row.status, 'arhivat');
    assert.ok(row.storage_key);
    assert.ok(fs.existsSync(path.join(storageDir, row.storage_key)));
    assert.equal((await clients.arhivar.post('/api/archive/proposals', { documentId: doc.id })).status, 201);
  });
});

describe('audit', () => {
  test('rândurile de audit nu pot fi modificate sau șterse', async () => {
    await assert.rejects(db.query(`UPDATE audit_log SET action = 'falsificat' WHERE seq = 1`), /Jurnalul de audit nu poate fi modificat/);
    await assert.rejects(db.query('DELETE FROM audit_log WHERE seq = 1'), /Jurnalul de audit nu poate fi modificat/);
    await assert.rejects(db.query('TRUNCATE audit_log'), /Jurnalul de audit nu poate fi modificat/);
    const verify = await clients.admin.get('/api/audit/verify');
    assert.equal(verify.status, 200);
    assert.equal(verify.body.ok, true);
    assert.ok(verify.body.checked > 0);
  });

  test('verificarea lanțului detectează alterarea, chiar cu declanșatoarele oprite', async () => {
    const row = await db.one(`SELECT seq, details FROM audit_log WHERE seq = (SELECT min(seq) + 3 FROM audit_log)`);
    await db.query('ALTER TABLE audit_log DISABLE TRIGGER USER');
    try {
      await db.query(`UPDATE audit_log SET details = '{"falsificat":true}' WHERE seq = $1`, [row.seq]);
      const broken = await clients.admin.get('/api/audit/verify');
      assert.equal(broken.body.ok, false);
      assert.equal(broken.body.brokenAt, Number(row.seq));
      await db.query('UPDATE audit_log SET details = $2 WHERE seq = $1', [row.seq, JSON.stringify(row.details)]);
      assert.equal((await clients.admin.get('/api/audit/verify')).body.ok, true);
      // Ștergerea unui rând rupe și ea lanțul.
      const removed = await db.one('SELECT *, at::text AS at_text FROM audit_log WHERE seq = $1', [row.seq]);
      await db.query('DELETE FROM audit_log WHERE seq = $1', [row.seq]);
      assert.equal((await clients.admin.get('/api/audit/verify')).body.brokenAt, Number(row.seq) + 1);
      await db.query(
        'INSERT INTO audit_log (seq, at, user_id, username, action, document_id, ip, details, prev_hash, hash) VALUES ($1,$2::timestamptz,$3,$4,$5,$6,$7,$8,$9,$10)',
        [removed.seq, removed.at_text, removed.user_id, removed.username, removed.action, removed.document_id, removed.ip, JSON.stringify(removed.details), removed.prev_hash, removed.hash]);
    } finally {
      await db.query('ALTER TABLE audit_log ENABLE TRIGGER USER');
    }
    assert.equal((await clients.admin.get('/api/audit/verify')).body.ok, true);
  });

  test('administratorul vede tot, arhivarul doar jurnalul arhivei, ceilalți nimic', async () => {
    const all = await clients.admin.get('/api/audit?limit=500');
    assert.equal(all.status, 200);
    assert.ok(all.body.items.some((i: Json) => i.action.startsWith('auth.')));
    assert.equal(typeof all.body.items[0].seq, 'number');
    assert.ok(all.body.items[0].hash);
    const filtered = await clients.admin.get(`/api/audit?action=auth.login_esuat&userId=${ids.admin}`);
    assert.ok(filtered.body.items.every((i: Json) => i.action === 'auth.login_esuat' && i.username === 'admin.test'));
    assert.ok(filtered.body.total >= 1);
    assert.equal((await clients.admin.get('/api/audit?from=2000-01-01&to=2000-01-02')).body.total, 0);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok((await clients.admin.get(`/api/audit?from=${today}&limit=1`)).body.items.length === 1);
    assert.equal((await clients.admin.get('/api/audit?from=nu-e-data')).status, 400);
    const group = await clients.admin.get('/api/audit?action=arhiva&limit=500');
    assert.ok(group.body.total > 0 && group.body.items.every((i: Json) => i.action.startsWith('arhiva.')));

    const journal = await clients.arhivar.get('/api/audit?limit=500');
    assert.equal(journal.status, 200);
    assert.ok(journal.body.total > 0);
    assert.ok(journal.body.items.every((i: Json) => i.action.startsWith('arhiva.')));
    const trying = await clients.arhivar.get('/api/audit?action=auth.login&limit=500');
    assert.equal(trying.body.total, 0, 'arhivarul nu poate cere alte acțiuni');
    const journalCsv = await clients.arhivar.get('/api/audit/export');
    assert.ok(!journalCsv.text.includes('auth.login'));
    assert.equal((await clients.arhivar.get('/api/audit/verify')).status, 403);

    for (const client of [clients.manager, clients.user, clients.registratura]) {
      assert.equal((await client.get('/api/audit')).status, 403);
      assert.equal((await client.get('/api/audit/export')).status, 403);
      assert.equal((await client.get('/api/gdpr/access-log')).status, 403);
    }
    assert.equal((await clients.arhivar.get('/api/gdpr/access-log')).status, 403);
  });

  test('accesul la date personale apare în jurnalul GDPR', async () => {
    const doc = await addDocument('manager', { title: 'Dosar personal', personalData: true });
    await ocr.drain();
    await clients.manager.get(`/api/documents/${doc.id}`);
    await clients.manager.get(`/api/documents/${doc.id}/file`);
    await clients.manager.get(`/api/documents/${doc.id}/text`);
    const log = await clients.admin.get(`/api/gdpr/access-log?documentId=${doc.id}`);
    assert.equal(log.status, 200);
    assert.equal(log.body.total, 3);
    assert.ok(log.body.items.every((i: Json) => i.action === 'gdpr.acces_date_personale' && i.username === 'manager.alpha'));
    const ordinary = await addDocument('manager', { title: 'Fără date personale' });
    await clients.manager.get(`/api/documents/${ordinary.id}`);
    assert.equal((await clients.admin.get(`/api/gdpr/access-log?documentId=${ordinary.id}`)).body.total, 0);
  });

  test('exportul CSV are BOM, separator ; și neutralizează formulele', async () => {
    await db.query(`INSERT INTO audit_log (seq, at, username, action, details, prev_hash, hash) VALUES (0, now(), '=cmd|calc', 'test.formula', '{}', '', '')`);
    const r = await clients.admin.get('/api/audit/export?action=test.formula');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type')!, /text\/csv/);
    assert.match(r.headers.get('content-disposition')!, /attachment/);
    assert.equal(r.text.charCodeAt(0), 0xFEFF);
    const [header, row] = r.text.slice(1).split('\r\n');
    assert.ok(header.includes(';'));
    assert.ok(header.includes('"Acțiune"'));
    assert.ok(row.includes(`"'=cmd|calc"`), row);
    assert.ok(!row.includes(`"=cmd`));
    assert.ok((await db.one(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'audit.export' AND username = 'admin.test'`)).n >= 1);

    await addDocument('registratura', { title: '=HYPERLINK("http://rau.example","clic")', issuer: '+40123', recipient: '@sum(A1)', registerId: ids.register });
    const csv = await clients.registratura.get(`/api/documents/export/register?registerId=${ids.register}&year=${year}`);
    assert.equal(csv.status, 200);
    assert.ok(csv.text.includes(`"'=HYPERLINK(""http://rau.example"",""clic"")"`), 'titlul');
    assert.ok(csv.text.includes(`"'+40123"`));
    assert.ok(csv.text.includes(`"'@sum(A1)"`));
  });
});

describe('administrare', () => {
  test('/meta este disponibil oricărui utilizator autentificat, fără date sensibile', async () => {
    assert.equal((await new Client().get('/api/meta')).status, 401);
    const r = await clients.user.get('/api/meta');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['departments', 'documentTypes', 'folders', 'registers', 'users']);
    const alpha = r.body.departments.find((d: Json) => d.id === ids.alpha);
    assert.equal(alpha.managerId, ids.manager);
    assert.equal(alpha.managerName, 'Test manager.alpha');
    assert.deepEqual(Object.keys(r.body.users[0]).sort(), ['departmentName', 'fullName', 'id', 'jobTitle']);
    const type = r.body.documentTypes.find((t: Json) => t.id === ids.type);
    assert.equal(type.retentionYears, 5);
    assert.equal(type.fields[0].key, 'categorie');
  });

  test('tipuri, registre, dosare și departamente, cu audit', async () => {
    const admin = clients.admin;
    const type = await admin.post('/api/admin/document-types', { name: 'Tip nou', nomenclatorCode: 'N-1', retentionYears: null, fields: [{ key: 'camp_a', label: 'Câmp', type: 'date', required: true }] });
    assert.equal(type.status, 201, type.text);
    assert.equal(type.body.retentionYears, null);
    assert.equal((await admin.post('/api/admin/document-types', { name: 'Tip nou', nomenclatorCode: 'N-1' })).status, 409);
    assert.equal((await admin.post('/api/admin/document-types', { name: 'Fără câmpuri bune', nomenclatorCode: 'N', fields: [{ key: 'Spatiu rau', label: 'x' }] })).status, 400);
    assert.equal((await admin.post('/api/admin/document-types', { name: 'Tip rău', nomenclatorCode: 'N', fields: [{ key: 'a', label: 'x', type: 'imagine' }] })).status, 400);
    const patched = await admin.patch(`/api/admin/document-types/${type.body.id}`, { retentionYears: 7 });
    assert.equal(patched.body.retentionYears, 7);
    assert.equal(patched.body.name, 'Tip nou');
    assert.equal((await admin.patch('/api/admin/document-types/999999', { retentionYears: 7 })).status, 404);

    const register = await admin.post('/api/admin/registers', { name: 'Registru nou', code: 'RN', departmentId: ids.alpha, documentTypeId: type.body.id });
    assert.equal(register.status, 201, register.text);
    assert.equal(register.body.active, true);
    assert.equal((await admin.post('/api/admin/registers', { name: 'Alt nume', code: 'RN' })).status, 409);
    assert.equal((await admin.post('/api/admin/registers', { name: 'Departament inexistent', code: 'DI', departmentId: 999999 })).status, 400);
    const closed = await admin.patch(`/api/admin/registers/${register.body.id}`, { active: false });
    assert.equal(closed.body.active, false);
    assert.equal((await clients.manager.upload('/api/documents', { title: 'Registru închis', documentTypeId: ids.type, registerId: register.body.id }, { name: 'r.pdf', data: await pdf('Registru închis', ['Text.']) })).status, 400);

    const folder = await admin.post('/api/admin/folders', { name: 'Dosar', departmentId: ids.alpha });
    assert.equal(folder.status, 201);
    assert.equal((await admin.post('/api/admin/folders', { name: 'Dosar' })).status, 409, 'dublură la rădăcină');
    assert.equal((await admin.post('/api/admin/folders', { name: 'Dosar', parentId: folder.body.id })).status, 201);

    const parent = await admin.post('/api/admin/departments', { name: 'Părinte', managerId: ids.manager });
    assert.equal(parent.status, 201);
    const child = await admin.post('/api/admin/departments', { name: 'Copil', parentId: parent.body.id });
    assert.equal((await admin.patch(`/api/admin/departments/${parent.body.id}`, { parentId: child.body.id })).status, 400, 'fără cicluri');
    assert.equal((await admin.patch(`/api/admin/departments/${parent.body.id}`, { parentId: parent.body.id })).status, 400);
    assert.equal((await admin.patch(`/api/admin/departments/${child.body.id}`, { name: 'Copil redenumit', managerId: ids.user })).body.managerId, ids.user);
    assert.equal((await admin.patch(`/api/admin/departments/${child.body.id}`, { managerId: null })).body.managerId, null);

    const actions = new Set((await db.query(`SELECT DISTINCT action FROM audit_log WHERE action LIKE 'admin.%' AND username = 'admin.test'`)).rows.map((r: Json) => r.action));
    for (const a of ['admin.tip_document_creat', 'admin.tip_document_modificat', 'admin.registru_creat', 'admin.registru_modificat', 'admin.dosar_creat', 'admin.departament_creat', 'admin.departament_modificat']) {
      assert.ok(actions.has(a), a);
    }
  });

  test('politica de parole se aplică la creare și resetare, iar secretul nu ajunge în audit', async () => {
    const admin = clients.admin;
    const weak = await admin.post('/api/admin/users', { username: 'slab.test', fullName: 'Slab', password: 'scurta', role: 'user' });
    assert.equal(weak.status, 400);
    assert.match(weak.body.message, /cel puțin/);
    assert.equal((await admin.post('/api/admin/users', { username: 'slab.test', fullName: 'Slab', password: 'faracomplexitate1', role: 'user' })).status, 400);
    assert.equal((await admin.post('/api/admin/users', { username: 'rol.gresit', fullName: 'X', password: PASSWORD, role: 'zeu' })).status, 400);
    assert.equal((await admin.post('/api/admin/users', { username: 'cu spatiu', fullName: 'X', password: PASSWORD, role: 'user' })).status, 400);
    assert.equal((await admin.post('/api/admin/users', { username: 'ADMIN.TEST', fullName: 'X', password: PASSWORD, role: 'user' })).status, 409);

    const target = await addUser('resetat.test', 'user', ids.alpha);
    const session = await login('resetat.test');
    assert.equal((await admin.patch(`/api/admin/users/${target}`, { password: 'slaba' })).status, 400);
    const secret = 'Resetata-Parola-55!';
    const reset = await admin.patch(`/api/admin/users/${target}`, { password: secret, fullName: 'Nume Schimbat' });
    assert.equal(reset.status, 200, reset.text);
    assert.equal(reset.body.fullName, 'Nume Schimbat');
    assert.equal(reset.body.mustChangePassword, true);
    assert.equal((await session.get('/api/auth/me')).status, 401, 'sesiunile vechi se închid');
    assert.equal((await new Client().post('/api/auth/login', { username: 'resetat.test', password: PASSWORD })).status, 401);
    assert.equal((await new Client().post('/api/auth/login', { username: 'resetat.test', password: secret })).body.state, 'change_password');
    const audit = await db.query(`SELECT details::text AS d FROM audit_log WHERE action LIKE 'admin.utilizator%'`);
    assert.ok(audit.rows.length > 0);
    assert.ok(audit.rows.every((r: Json) => !r.d.includes(secret) && !r.d.includes('scrypt') && !r.d.includes(PASSWORD)));

    assert.equal((await admin.patch(`/api/admin/users/${ids.admin}`, { password: secret })).status, 400, 'parola proprie are alt traseu');
  });

  test('administratorul nu se poate dezactiva, iar ultimul administrator activ nu poate fi retrogradat', async () => {
    const admin = clients.admin;
    const self = await admin.patch(`/api/admin/users/${ids.admin}`, { active: false });
    assert.equal(self.status, 409);
    assert.match(self.body.message, /propriul cont/);
    assert.equal((await db.one('SELECT active FROM users WHERE id = $1', [ids.admin])).active, true);

    // Rămâne un singur administrator, deci nici el, nici alt administrator nu mai pot scădea numărul.
    assert.equal((await admin.patch(`/api/admin/users/${ids.admin2}`, { role: 'manager' })).status, 200);
    const last = await admin.patch(`/api/admin/users/${ids.admin}`, { role: 'user' });
    assert.equal(last.status, 409);
    assert.match(last.body.message, /cel puțin un administrator/);
    assert.equal((await db.one('SELECT role FROM users WHERE id = $1', [ids.admin])).role, 'admin');
    const stripped = await admin.patch(`/api/admin/users/${ids.admin}`, { permissions: { users_admin: false } });
    assert.equal(stripped.status, 409);
    assert.equal((await db.one('SELECT count(*)::int AS n FROM user_permissions WHERE user_id = $1', [ids.admin])).n, 0);

    assert.equal((await admin.patch(`/api/admin/users/${ids.admin2}`, { role: 'admin' })).status, 200);
    assert.equal((await admin.patch(`/api/admin/users/${ids.admin}`, { role: 'admin', fullName: 'Test admin.test' })).status, 200);

    const toLeave = await addUser('plecat.test', 'admin', ids.alpha);
    const session = await login('plecat.test');
    assert.equal((await admin.patch(`/api/admin/users/${toLeave}`, { active: false })).status, 200);
    assert.equal((await session.get('/api/documents')).status, 401, 'contul dezactivat își pierde sesiunea');
    assert.equal((await new Client().post('/api/auth/login', { username: 'plecat.test', password: PASSWORD })).status, 401);
  });

  test('permisiuni individuale și înlocuitor', async () => {
    const admin = clients.admin;
    const target = await addUser('ajustat.test', 'user', ids.alpha);
    const session = await login('ajustat.test');
    assert.equal((await session.get('/api/archive')).status, 403);
    assert.equal((await admin.patch(`/api/admin/users/${target}`, { permissions: { zbor: true } })).status, 400);
    assert.equal((await admin.patch(`/api/admin/users/${target}`, { permissions: { archive: 'da' } })).status, 400);
    const granted = await admin.patch(`/api/admin/users/${target}`, { permissions: { archive: true, approve: false } });
    assert.deepEqual(granted.body.permissions, { archive: true, approve: false });
    assert.equal((await session.get('/api/archive')).status, 200);
    const perms = (await session.get('/api/auth/me')).body.user.permissions;
    assert.ok(perms.includes('archive') && !perms.includes('approve'));
    assert.deepEqual((await admin.patch(`/api/admin/users/${target}`, { permissions: { archive: null } })).body.permissions, { approve: false });
    assert.equal((await session.get('/api/archive')).status, 403);

    assert.equal((await admin.patch(`/api/admin/users/${target}`, { substituteId: target })).status, 400);
    assert.equal((await admin.patch(`/api/admin/users/${target}`, { substituteUntil: 'mâine' })).status, 400);
    const sub = await admin.patch(`/api/admin/users/${target}`, { substituteId: ids.user, substituteUntil: '2030-05-01' });
    assert.equal(sub.body.substituteId, ids.user);
    assert.equal(sub.body.substituteUntil, '2030-05-01');
    assert.equal(sub.body.substituteName, 'Test user.alpha');
    assert.equal((await admin.patch(`/api/admin/users/${target}`, { substituteId: null, substituteUntil: null })).body.substituteId, null);
    assert.equal((await admin.patch('/api/admin/users/999999', { fullName: 'Nimeni' })).status, 404);
  });

  test('setările se validează; o rețea greșită nu poate bloca autentificarea', async () => {
    const admin = clients.admin;
    const initial = (await admin.get('/api/admin/settings')).body;
    assert.equal(initial.passwordPolicy.minLength, 10);
    assert.ok(initial.internalNetworks.includes('127.0.0.0/8'));

    assert.equal((await admin.put('/api/admin/settings/password-policy', { minLength: 3 })).status, 400);
    assert.equal((await admin.put('/api/admin/settings/password-policy', { maxFailedAttempts: 0 })).status, 400);
    assert.equal((await admin.put('/api/admin/settings/password-policy', { requireComplexity: 'nu' })).status, 400);
    const policy = await admin.put('/api/admin/settings/password-policy', { minLength: 12 });
    assert.equal(policy.status, 200, policy.text);
    assert.equal(policy.body.minLength, 12);
    assert.equal(policy.body.lockMinutes, 15);
    assert.equal((await admin.post('/api/admin/users', { username: 'scurt.doi', fullName: 'S', password: 'Abcdef-1234', role: 'user' })).status, 400);
    await admin.put('/api/admin/settings/password-policy', { minLength: 10 });

    for (const networks of [['nu-e-retea'], ['10.0.0.0'], ['10.0.0.0/99'], ['::1/200'], [5], 'text']) {
      assert.equal((await admin.put('/api/admin/settings/internal-networks', { networks })).status, 400, JSON.stringify(networks));
    }
    const saved = await admin.put('/api/admin/settings/internal-networks', { networks: ['127.0.0.0/8', ' 172.16.0.0/12 ', 'fd00::/8'] });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.body.networks, ['127.0.0.0/8', '172.16.0.0/12', 'fd00::/8']);
    assert.equal((await new Client({ 'x-forwarded-for': '172.16.4.4' }).post('/api/auth/login', { username: 'user.alpha', password: PASSWORD })).body.state, 'ok');
    assert.equal((await new Client({ 'x-forwarded-for': '10.1.1.1' }).post('/api/auth/login', { username: 'user.alpha', password: PASSWORD })).body.state, 'mfa_enrol');
    await admin.put('/api/admin/settings/internal-networks', { networks: initial.internalNetworks });
    const changes = (await db.query(`SELECT action FROM audit_log WHERE action IN ('admin.politica_parole_modificata','admin.retele_interne_modificate')`)).rows;
    assert.ok(changes.length >= 4);
  });
});

describe('rapoarte', () => {
  test('sumarul: managerul e limitat la departamentul propriu, oricare ar fi interogarea', async () => {
    // Departamente proprii, ca mediile să nu includă instanțele altor teste.
    const gamma = (await db.one(`INSERT INTO departments (name) VALUES ('Gamma') RETURNING id`)).id;
    const delta = (await db.one(`INSERT INTO departments (name) VALUES ('Delta') RETURNING id`)).id;
    const managerGamma = await addUser('manager.gamma', 'manager', gamma);
    const managerDelta = await addUser('manager.delta', 'manager', delta);
    clients.managerGamma = await login('manager.gamma');
    clients.managerDelta = await login('manager.delta');
    const def = (await db.one(`INSERT INTO workflow_definitions (key, version, name, xml) VALUES ('test-raport', 1, 'R', '<x/>') RETURNING id`)).id;
    const alphaDoc = await addDocument('managerGamma', { title: 'Raport gamma', departmentId: gamma });
    const betaDoc = await addDocument('managerDelta', { title: 'Raport delta', departmentId: delta });
    for (const [doc, by, hours] of [[alphaDoc.id, managerGamma, 8], [alphaDoc.id, managerGamma, 12], [betaDoc.id, managerDelta, 5]]) {
      await db.query(
        `INSERT INTO workflow_instances (definition_id, document_id, status, started_by, started_at, finished_at)
         VALUES ($1,$2,'aprobat',$3, now() - make_interval(hours => $4), now())`, [def, doc, by, hours]);
    }
    const instance = (await db.one(
      `INSERT INTO workflow_instances (definition_id, document_id, started_by) VALUES ($1,$2,$3) RETURNING id`, [def, betaDoc.id, managerDelta])).id;
    const step = (await db.one(`INSERT INTO workflow_steps (instance_id, element_id, element_type) VALUES ($1,'T','userTask') RETURNING id`, [instance])).id;
    const task = (await db.one(
      `INSERT INTO tasks (step_id, instance_id, document_id, assignee_id, kind, name, due_at) VALUES ($1,$2,$3,$4,'avizare','Întârziată', now() - interval '1 day') RETURNING id`,
      [step, instance, betaDoc.id, ids.outsider])).id;
    await db.query(`INSERT INTO tasks (step_id, instance_id, document_id, assignee_id, kind, name, due_at) VALUES ($1,$2,$3,$4,'avizare','În termen', now() + interval '1 day')`, [step, instance, betaDoc.id, ids.outsider]);

    const resolutionOf = (body: Json, name: string) => body.resolution.find((r: Json) => r.departmentName === name);

    const manager = await clients.managerGamma.get(`/api/reports/summary?departmentId=${delta}`);
    assert.equal(manager.status, 200);
    assert.deepEqual(manager.body.byStatus, [{ departmentName: 'Gamma', status: 'inregistrat', count: 1 }]);
    assert.deepEqual(manager.body.resolution, [{ departmentName: 'Gamma', avgHours: 10, count: 2 }]);
    assert.deepEqual(manager.body.overdue, []);
    const noQuery = await clients.managerDelta.get('/api/reports/summary');
    assert.equal(noQuery.body.overdue.length, 1);
    assert.equal(noQuery.body.overdue[0].taskId, task);

    const all = (await clients.admin.get('/api/reports/summary')).body;
    assert.equal(resolutionOf(all, 'Delta').avgHours, 5);
    assert.equal(resolutionOf(all, 'Gamma').avgHours, 10);
    const overdue = all.overdue.filter((o: Json) => o.documentId === betaDoc.id);
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0].taskId, task);
    assert.equal(overdue[0].title, 'Raport delta');
    assert.equal(overdue[0].assignee, 'Test user.beta');
    assert.ok(new Set(all.byStatus.map((r: Json) => r.departmentName)).size >= 4);

    const onlyDelta = (await clients.admin.get(`/api/reports/summary?departmentId=${delta}`)).body;
    assert.deepEqual(onlyDelta.byStatus, [{ departmentName: 'Delta', status: 'inregistrat', count: 1 }]);

    assert.equal((await clients.user.get('/api/reports/summary')).status, 403);
    assert.equal((await clients.arhivar.get('/api/reports/summary')).status, 403);
    assert.equal((await clients.registratura.get('/api/reports/summary')).status, 403);
  });
});
