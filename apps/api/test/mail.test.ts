// Teste de integrare: server HTTP real, PostgreSQL real, SMTP real (smtp-server) și IMAP real (hoodiecrow-imap, prin imapflow).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
// @ts-ignore: pachetul nu are declarații de tip.
import hoodiecrow from 'hoodiecrow-imap';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://seadoc@127.0.0.1:55432/seadoc_mail_test';
if (!/test/.test(new URL(databaseUrl).pathname)) throw new Error('Testele șterg baza de date: DATABASE_URL trebuie să indice o bază de test');
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seadoc-mail-test-'));
process.env.DATABASE_URL = databaseUrl;
process.env.STORAGE_DIR = storageDir;
process.env.OCR_POLL_MS = '86400000';
process.env.SCHEDULER_MS = '86400000';
process.env.COOKIE_SECURE = 'false';
process.env.TRUST_PROXY = '0';

const PASSWORD = 'Parola-Test-2026!';
const APP_URL = 'https://seadoc.exemplu.test';
const TEST_DIR = path.dirname(new URL(import.meta.url).pathname);

type Json = any;
interface Reply { status: number; body: Json; text: string; headers: Headers }

let base = '';
let app: Json;
let db: Json;
let worker: Json;
let notify: Json;
let engine: Json;
let ocr: Json;
let config: Json;
let passwordHash = '';
const ids: Record<string, number> = {};
const clients: Record<string, Client> = {};

class Client {
  cookie = '';

  private async send(method: string, url: string, body?: BodyInit, contentType?: string): Promise<Reply> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (contentType) headers['content-type'] = contentType;
    const res = await fetch(base + url, { method, headers, body });
    const set = res.headers.getSetCookie().find((c) => c.startsWith('seadoc_session='));
    if (set) this.cookie = set.split(';')[0];
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
    const parsed = (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : null;
    return { status: res.status, body: parsed, text, headers: res.headers };
  }

  get(url: string) { return this.send('GET', url); }
  del(url: string) { return this.send('DELETE', url); }
  post(url: string, body: Json = {}) { return this.send('POST', url, JSON.stringify(body), 'application/json'); }
  put(url: string, body: Json = {}) { return this.send('PUT', url, JSON.stringify(body), 'application/json'); }
  patch(url: string, body: Json = {}) { return this.send('PATCH', url, JSON.stringify(body), 'application/json'); }

  upload(url: string, fields: Record<string, unknown>, file: { name: string; data: Buffer; type?: string }) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) form.set(key, String(value));
    form.set('file', new Blob([new Uint8Array(file.data)], { type: file.type ?? 'application/octet-stream' }), file.name);
    return this.send('POST', url, form);
  }

  async bytes(url: string) {
    const res = await fetch(base + url, { headers: { cookie: this.cookie } });
    return { status: res.status, data: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  }
}

async function login(username: string) {
  const client = new Client();
  const r = await client.post('/api/auth/login', { username, password: PASSWORD });
  assert.equal(r.status, 200, `autentificare ${username}: ${r.text}`);
  return client;
}

async function addUser(username: string, role: string, departmentId: number | null, email: string | null = null): Promise<number> {
  return (await db.one(
    `INSERT INTO users (username, full_name, email, password_hash, role, department_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [username, `Test ${username}`, email, passwordHash, role, departmentId])).id;
}

// --- SMTP real ---------------------------------------------------------------

interface Received { from: string; to: string[]; raw: Buffer }
const sink = { mode: 'ok' as 'ok' | 'temp' | 'perm', received: [] as Received[], connections: 0 };
const smtpServer = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  logger: false,
  onConnect(_session, cb) { sink.connections++; cb(); },
  onRcptTo(_address, _session, cb) {
    if (sink.mode === 'ok') return cb();
    const err: Error & { responseCode?: number } = new Error(sink.mode === 'temp' ? 'Serviciu indisponibil temporar' : 'Căsuță inexistentă');
    err.responseCode = sink.mode === 'temp' ? 451 : 550;
    cb(err);
  },
  onData(stream, session, cb) {
    const parts: Buffer[] = [];
    stream.on('data', (d: Buffer) => parts.push(d));
    stream.on('end', () => {
      sink.received.push({
        from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
        to: session.envelope.rcptTo.map((r) => r.address),
        raw: Buffer.concat(parts),
      });
      cb();
    });
  },
});
let smtpPort = 0;

/** Un port pe care chiar nu ascultă nimeni: conexiunea este refuzată de sistem. */
function deadPort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const outboxFor = async (userId: number) => (await db.query('SELECT * FROM email_outbox WHERE user_id = $1 ORDER BY id', [userId])).rows;
const makeDue = (id: number) => db.query('UPDATE email_outbox SET next_attempt_at = now() WHERE id = $1', [id]);
const audited = async (action: string) => (await db.query('SELECT * FROM audit_log WHERE action = $1 ORDER BY seq', [action])).rows;
const auditedAfter = async (action: string, seq: number) => (await db.query('SELECT * FROM audit_log WHERE action = $1 AND seq > $2 ORDER BY seq', [action, seq])).rows;
const lastSeq = async () => Number((await db.one('SELECT coalesce(max(seq), 0) AS n FROM audit_log')).n);

// --- IMAP real ---------------------------------------------------------------

let imapServer: Json;
let imapPort = 0;

function rawMessage(opts: { messageId?: string | null; from?: string; subject?: string; date?: string; contentType?: string; body?: string; attachments?: { name: string; data: Buffer; type?: string }[] }): Buffer {
  const headers = [
    `From: ${opts.from ?? 'Ion Expeditor <ion.expeditor@furnizor.exemplu.ro>'}`,
    'To: registratura@ctp.exemplu.ro',
    `Subject: ${encodeHeader(opts.subject ?? 'Subiect test')}`,
    `Date: ${opts.date ?? 'Sun, 01 Nov 2026 10:00:00 +0200'}`,
    'MIME-Version: 1.0',
  ];
  if (opts.messageId !== null) headers.push(`Message-ID: ${opts.messageId ?? `<${crypto.randomUUID()}@furnizor.exemplu.ro>`}`);
  const text = opts.body ?? 'Bună ziua, vă transmitem documentul atașat.';
  const contentType = opts.contentType ?? 'text/plain; charset=utf-8';
  if (!opts.attachments?.length) {
    return Buffer.from([...headers, `Content-Type: ${contentType}`, 'Content-Transfer-Encoding: 8bit', '', text, ''].join('\r\n'));
  }
  const boundary = `b${crypto.randomUUID().replaceAll('-', '')}`;
  const lines = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, `Content-Type: ${contentType}`, 'Content-Transfer-Encoding: 8bit', '', text];
  for (const att of opts.attachments) {
    const encoded = encodeURIComponent(att.name);
    lines.push(`--${boundary}`, `Content-Type: ${att.type ?? 'application/octet-stream'}`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename*=UTF-8''${encoded}`, '', att.data.toString('base64').replace(/(.{76})/g, '$1\r\n'));
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n'));
}
const encodeHeader = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`);
const PDF = Buffer.from('%PDF-1.4\n% document de test primit pe email: MARCAJ-SECRET-PDF\n%%EOF\n');

async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({ host: '127.0.0.1', port: imapPort, secure: false, auth: { user: 'testuser', pass: 'testpass' }, logger: false });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}
const deliver = (raw: Buffer, flags: string[] = []) => withImap((c) => c.append('INBOX', raw, flags));
const poll = async () => {
  const r = await clients.registratura.post('/api/mail/inbox/poll');
  assert.equal(r.status, 200, r.text);
  return r.body as { imported: number; duplicates: number; refusedAttachments: number; remaining: boolean };
};
async function inboxBySubject(subject: string) {
  const list = await clients.registratura.get('/api/mail/inbox?limit=200');
  assert.equal(list.status, 200, list.text);
  return (list.body.items as Json[]).filter((m) => m.subject === subject);
}
async function onlyMessage(subject: string) {
  const found = await inboxBySubject(subject);
  assert.equal(found.length, 1, `mesaje cu subiectul ${subject}: ${found.length}`);
  const r = await clients.registratura.get(`/api/mail/inbox/${found[0].id}`);
  assert.equal(r.status, 200, r.text);
  return r.body;
}

// --- Pregătire ---------------------------------------------------------------

before(async () => {
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE');
  await admin.query('CREATE SCHEMA public');
  await admin.end();

  await new Promise<void>((resolve) => smtpServer.listen(0, '127.0.0.1', resolve));
  smtpPort = (smtpServer.server.address() as net.AddressInfo).port;

  imapServer = hoodiecrow({
    debug: false,
    storage: {
      INBOX: {
        messages: [
          // Mesajul citit deja, dinainte de instalare: prima rulare nu îl ia.
          { raw: rawMessage({ subject: 'Mesaj vechi deja citit' }).toString('binary'), flags: ['\\Seen'], internaldate: '01-Oct-2026 10:00:00 +0200' },
        ],
      },
    },
  });
  await new Promise<void>((resolve) => imapServer.listen(0, '127.0.0.1', resolve));
  imapPort = imapServer.address().port;

  Object.assign(process.env, {
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_SECURE: 'false', SMTP_FROM: 'SeaDoc <seadoc@ctp.exemplu.ro>', APP_URL,
    IMAP_HOST: '127.0.0.1', IMAP_PORT: String(imapPort), IMAP_SECURE: 'false', IMAP_USER: 'testuser', IMAP_PASS: 'testpass', IMAP_MAILBOX: 'INBOX',
  });
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;

  ({ config } = await import('../src/config.js'));
  config.webDist = path.join(storageDir, 'fara-web');
  const main = await import('../src/main.js');
  const { Db } = await import('../src/db.js');
  const { MailWorker } = await import('../src/mail.js');
  const { NotificationService } = await import('../src/notifications.js');
  const { WorkflowEngine } = await import('../src/workflow-engine.js');
  const { OcrService } = await import('../src/ocr.js');
  const { hashPassword } = await import('../src/auth.js');
  passwordHash = hashPassword(PASSWORD);
  app = await main.createApp({ logger: ['error'] });
  db = app.get(Db);
  worker = app.get(MailWorker);
  notify = app.get(NotificationService);
  engine = app.get(WorkflowEngine);
  ocr = app.get(OcrService);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;

  ids.alpha = (await db.one(`INSERT INTO departments (name) VALUES ('Alpha') RETURNING id`)).id;
  ids.beta = (await db.one(`INSERT INTO departments (name) VALUES ('Beta') RETURNING id`)).id;
  ids.type = (await db.one(`INSERT INTO document_types (name, nomenclator_code, retention_years) VALUES ('Tip test','T-1',5) RETURNING id`)).id;
  ids.register = (await db.one(`INSERT INTO registers (name, code) VALUES ('Registru email','EM') RETURNING id`)).id;

  ids.admin = await addUser('admin.test', 'admin', ids.alpha, 'admin@ctp.exemplu.ro');
  ids.registratura = await addUser('registratura.test', 'registratura', ids.alpha, 'registratura@ctp.exemplu.ro');
  ids.user = await addUser('user.alpha', 'user', ids.alpha, 'user.alpha@ctp.exemplu.ro');
  ids.noEmail = await addUser('fara.email', 'user', ids.alpha);
  ids.invalid = await addUser('demo.invalid', 'user', ids.alpha, 'demo@ctp-iasi.invalid');
  ids.managerB = await addUser('manager.beta', 'manager', ids.beta);
  ids.auditor = await addUser('auditor.beta', 'manager', ids.beta);
  await db.query(`INSERT INTO user_permissions (user_id, permission, allowed) VALUES ($1,'audit_all',true)`, [ids.auditor]);

  for (const [name, username] of Object.entries({ admin: 'admin.test', registratura: 'registratura.test', user: 'user.alpha', managerB: 'manager.beta', auditor: 'auditor.beta' })) {
    clients[name] = await login(username);
  }
});

after(async () => {
  await app?.close();
  await new Promise<void>((resolve) => smtpServer.close(() => resolve()));
  await new Promise<void>((resolve) => imapServer?.close(() => resolve()));
  fs.rmSync(storageDir, { recursive: true, force: true });
});

// --- Email de notificare -----------------------------------------------------

const bpmn = (key: string, assignee: string, due: string) => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:seadoc="http://seadoc.ro/schema/bpmn" id="Defs" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="${key}" isExecutable="false">
    <bpmn:startEvent id="Start"/>
    <bpmn:userTask id="T" name="Avizare" seadoc:assigneeType="utilizator" seadoc:assignee="${assignee}" seadoc:action="avizare" seadoc:dueHours="${due}"/>
    <bpmn:endEvent id="End"/>
    <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="T"/>
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="End"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Diagram"><bpmndi:BPMNPlane id="Plane" bpmnElement="${key}"/></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

async function addDocument(by: string, fields: Record<string, unknown>, content = 'Conținut de test.\n') {
  const r = await clients[by].upload('/api/documents', { documentTypeId: ids.type, departmentId: ids.alpha, ...fields }, { name: 'document.txt', data: Buffer.from(content), type: 'text/plain' });
  assert.equal(r.status, 201, r.text);
  return r.body as { id: number; regLabel: string | null };
}

test('emailul intră în coadă în tranzacția notificării și se anulează odată cu ea', async () => {
  await assert.rejects(db.tx(async (c: Json) => {
    await notify.send(ids.user, 'sarcina_noua', 'Titlu anulat', {}, c);
    // Vizibil pe conexiunea tranzacției, invizibil pentru oricine altcineva: aceeași tranzacție, necomisă.
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM email_outbox WHERE subject LIKE '%Titlu anulat%'`)).rows[0].n, 1);
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM email_outbox WHERE subject LIKE '%Titlu anulat%'`)).n, 0);
    throw new Error('anulare intenționată');
  }), /anulare intenționată/);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM email_outbox WHERE subject LIKE '%Titlu anulat%'`)).n, 0);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM notifications WHERE title = 'Titlu anulat'`)).n, 0);

  await db.tx((c: Json) => notify.send(ids.user, 'sarcina_noua', 'Titlu comis', {}, c));
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM email_outbox WHERE subject LIKE '%Titlu comis%'`)).n, 1);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM notifications WHERE title = 'Titlu comis'`)).n, 1);
  // Se livrează aici, ca rândul să nu intre în testele următoare.
  await worker.drain();
});

test('fără SMTP_HOST sau fără adresă nu se pune nimic în coadă, iar notificarea din aplicație rămâne', async () => {
  const before = (await db.one('SELECT count(*)::int AS n FROM email_outbox')).n;
  const host = process.env.SMTP_HOST;
  delete process.env.SMTP_HOST;
  try {
    await notify.send(ids.user, 'sarcina_noua', 'Fără SMTP');
    assert.deepEqual(await worker.drain(), { sent: 0, retried: 0, failed: 0, skipped: 0 });
  } finally {
    process.env.SMTP_HOST = host;
  }
  await notify.send(ids.noEmail, 'sarcina_noua', 'Fără adresă');
  assert.equal((await db.one('SELECT count(*)::int AS n FROM email_outbox')).n, before);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM notifications WHERE title IN ('Fără SMTP','Fără adresă')`)).n, 2);
});

test('sarcină nouă, termen apropiat și document respins ajung pe email doar cu titlul și linkul', async () => {
  sink.received.length = 0;
  const published = await clients.admin.post('/api/workflows', { key: 'flux-email', name: 'Flux email', xml: bpmn('flux_email', 'user.alpha', '12') });
  assert.equal(published.status, 201, published.text);
  const doc = await addDocument('registratura', { title: 'Contract de mentenanță', summary: 'REZUMAT-CONFIDENTIAL' }, 'CONTINUT-CONFIDENTIAL\n');
  const started = await clients.registratura.post('/api/workflows/flux-email/start', { documentId: doc.id });
  assert.equal(started.status, 201, started.text);

  const queued = (await outboxFor(ids.user)).filter((r: Json) => r.document_id === doc.id);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, 'sarcina_noua');
  assert.equal(queued[0].status, 'in_asteptare');
  // Fluxul nu așteaptă serverul de email: nimic nu s-a trimis până la rularea lucrătorului.
  assert.equal(sink.received.length, 0);

  assert.equal((await worker.drain()).sent, 1);
  assert.equal(sink.received.length, 1);
  assert.deepEqual(sink.received[0].to, ['user.alpha@ctp.exemplu.ro']);
  assert.equal(sink.received[0].from, 'seadoc@ctp.exemplu.ro');
  const mail = await simpleParser(sink.received[0].raw);
  assert.equal(mail.subject, '[SeaDoc] Sarcină nouă: Avizare (Contract de mentenanță)');
  assert.match(mail.text!, new RegExp(`${APP_URL}/documente/${doc.id}`));
  assert.equal(mail.html, false, 'emailul este doar text');
  assert.equal(mail.headers.get('auto-submitted'), 'auto-generated');
  assert.doesNotMatch(sink.received[0].raw.toString(), /CONFIDENTIAL/);
  const task = (await clients.user.get('/api/tasks?scope=open')).body.find((t: Json) => t.documentId === doc.id);
  assert.ok(task);

  // Termen apropiat, prin verificarea reală a termenelor.
  sink.received.length = 0;
  assert.equal((await engine.checkDeadlines()).reminded, 1);
  assert.equal((await worker.drain()).sent, 1);
  assert.equal((await simpleParser(sink.received[0].raw)).subject, '[SeaDoc] Termen apropiat: Avizare (Contract de mentenanță)');

  // Respingere: inițiatorul primește emailul, dar fără motivul scris în comentariu.
  sink.received.length = 0;
  const rejected = await clients.user.post(`/api/tasks/${task.id}/action`, { action: 'reject', comment: 'MOTIV-CONFIDENTIAL' });
  assert.equal(rejected.status, 200, rejected.text);
  assert.equal((await worker.drain()).sent, 1);
  assert.deepEqual(sink.received[0].to, ['registratura@ctp.exemplu.ro']);
  const refused = await simpleParser(sink.received[0].raw);
  assert.equal(refused.subject, '[SeaDoc] Documentul „Contract de mentenanță” a fost respins');
  assert.doesNotMatch(sink.received[0].raw.toString(), /CONFIDENTIAL/);
  assert.ok((await audited('email.trimis')).length >= 3);
});

test('un server SMTP oprit nu blochează fluxul; mesajul se reîncearcă cu întârziere crescătoare', async () => {
  sink.received.length = 0;
  process.env.SMTP_PORT = String(await deadPort());
  const doc = await addDocument('registratura', { title: 'Document în timpul penei' });
  const started = await clients.registratura.post('/api/workflows/flux-email/start', { documentId: doc.id });
  assert.equal(started.status, 201, started.text);

  const row = (await outboxFor(ids.user)).find((r: Json) => r.document_id === doc.id);
  const first = await worker.drain();
  assert.equal(first.retried, 1);
  let current = (await outboxFor(ids.user)).find((r: Json) => r.id === row.id);
  assert.equal(current.status, 'in_asteptare');
  assert.equal(current.attempts, 1);
  assert.match(current.last_error, /ECONNREFUSED|connect/i);
  const delay1 = new Date(current.next_attempt_at).getTime() - Date.now();
  assert.ok(delay1 > 30_000 && delay1 <= 60_000, `prima întârziere: ${delay1}`);

  // Încă nu e scadent: serverul a revenit, dar lucrătorul respectă întârzierea.
  process.env.SMTP_PORT = String(smtpPort);
  assert.equal((await worker.drain()).sent, 0);
  assert.equal(sink.received.length, 0);

  // Refuz temporar la RCPT (451): se reîncearcă, cu întârziere dublă.
  await makeDue(row.id);
  sink.mode = 'temp';
  assert.equal((await worker.drain()).retried, 1);
  current = (await outboxFor(ids.user)).find((r: Json) => r.id === row.id);
  assert.equal(current.attempts, 2);
  assert.match(current.last_error, /451|temporar/i);
  const delay2 = new Date(current.next_attempt_at).getTime() - Date.now();
  assert.ok(delay2 > 90_000 && delay2 <= 120_000, `a doua întârziere: ${delay2}`);

  await makeDue(row.id);
  sink.mode = 'ok';
  assert.equal((await worker.drain()).sent, 1);
  current = (await outboxFor(ids.user)).find((r: Json) => r.id === row.id);
  assert.equal(current.status, 'trimis');
  assert.equal(current.attempts, 3);
  assert.equal(current.last_error, null);
  assert.ok(current.sent_at);
  assert.equal(sink.received.length, 1);
});

test('eșecul definitiv rămâne vizibil pentru administrator și se poate retrimite', async () => {
  sink.received.length = 0;
  const seq = await lastSeq();
  await notify.send(ids.user, 'sarcina_noua', 'Destinatar refuzat');
  sink.mode = 'perm';
  assert.equal((await worker.drain()).failed, 1, '550 nu se reîncearcă');
  sink.mode = 'ok';

  const failed = await clients.admin.get('/api/mail/outbox?status=esuat');
  assert.equal(failed.status, 200, failed.text);
  const row = failed.body.items.find((r: Json) => r.subject.includes('Destinatar refuzat'));
  assert.equal(row.status, 'esuat');
  assert.equal(row.attempts, 1);
  assert.match(row.lastError, /550|inexistent/i);
  assert.equal((await auditedAfter('email.esuat', seq)).length, 1);
  assert.equal((await clients.admin.get('/api/mail/status')).body.counts.esuat, 1);
  assert.doesNotMatch((await clients.admin.get('/api/mail/status')).text, /testpass/);

  assert.equal((await clients.user.get('/api/mail/outbox')).status, 403);
  assert.equal((await clients.registratura.post(`/api/mail/outbox/${row.id}/retry`)).status, 403);
  assert.equal((await clients.admin.post(`/api/mail/outbox/${row.id}/retry`)).status, 200);
  assert.equal((await worker.drain()).sent, 1);
  assert.equal(sink.received.length, 1);
  assert.equal((await clients.admin.post(`/api/mail/outbox/${row.id}/retry`)).status, 409);

  // Reîncercările temporare au și ele un capăt.
  const { MAX_ATTEMPTS } = await import('../src/mail.js');
  await notify.send(ids.user, 'sarcina_noua', 'Ultima încercare');
  const last = (await outboxFor(ids.user)).at(-1);
  await db.query('UPDATE email_outbox SET attempts = $2 WHERE id = $1', [last.id, MAX_ATTEMPTS - 1]);
  sink.mode = 'temp';
  assert.equal((await worker.drain()).failed, 1);
  sink.mode = 'ok';
  assert.equal((await outboxFor(ids.user)).at(-1).status, 'esuat');
});

test('domeniile .invalid și adresele cu mai mulți destinatari nu ajung niciodată la serverul SMTP', async () => {
  sink.received.length = 0;
  const connections = sink.connections;
  await notify.send(ids.invalid, 'sarcina_noua', 'Către demo');
  const skipped = await outboxFor(ids.invalid);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].status, 'ignorat');
  assert.match(skipped[0].last_error, /\.invalid/);

  for (const address of ['Demo@CTP.INVALID', 'demo@ctp.invalid.', 'demo@invalid', 'victima@gmail.exemplu.ro, demo@x.invalid', 'demo@x.invalid, victima@gmail.exemplu.ro', 'a@b.ro\r\nBcc: c@d.ro', 'Nume <a@b.ro>']) {
    await db.query('UPDATE users SET email = $2 WHERE id = $1', [ids.invalid, address]);
    await notify.send(ids.invalid, 'sarcina_noua', 'Variantă');
  }
  const rows = await outboxFor(ids.invalid);
  assert.ok(rows.every((r: Json) => r.status === 'ignorat'), JSON.stringify(rows.map((r: Json) => [r.to_address, r.status])));

  // Un rând ajuns în așteptare pe altă cale este oprit și de lucrător, chiar înainte de trimitere.
  await db.query(`INSERT INTO email_outbox (user_id, to_address, subject, body, kind) VALUES ($1,'x@ceva.invalid','s','b','test')`, [ids.invalid]);
  const result = await worker.drain();
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(sink.received.length, 0);
  assert.equal(sink.connections, connections, 'nicio conexiune la serverul SMTP');
  assert.equal((await db.one(`SELECT status FROM email_outbox WHERE to_address = 'x@ceva.invalid'`)).status, 'ignorat');
  await db.query('UPDATE users SET email = $2 WHERE id = $1', [ids.invalid, 'demo@ctp-iasi.invalid']);
});

test('un titlu cu CRLF nu poate adăuga antete sau destinatari', async () => {
  sink.received.length = 0;
  await notify.send(ids.user, 'sarcina_noua', 'Titlu\r\nBcc: atacator@rau.exemplu.ro\r\nX-Injectat: da\r\n\r\nCorp fals');
  assert.equal((await worker.drain()).sent, 1);
  assert.deepEqual(sink.received[0].to, ['user.alpha@ctp.exemplu.ro']);
  const raw = sink.received[0].raw.toString();
  const [head] = raw.split('\r\n\r\n');
  assert.doesNotMatch(head, /^Bcc:/mi);
  assert.doesNotMatch(head, /^X-Injectat:/mi);
  const mail = await simpleParser(sink.received[0].raw);
  assert.equal(mail.bcc, undefined);
  assert.equal(mail.subject, '[SeaDoc] Titlu Bcc: atacator@rau.exemplu.ro X-Injectat: da Corp fals');
  assert.equal(mail.headers.get('x-injectat'), undefined);
});

// --- IMAP --------------------------------------------------------------------

test('IMAP: prima rulare ia necititele, marchează doar Seen și nu șterge nimic', async () => {
  await deliver(rawMessage({
    subject: 'Cerere de ofertă ședință',
    messageId: '<cerere-1@furnizor.exemplu.ro>',
    attachments: [
      { name: 'cerere ședință.pdf', data: PDF, type: 'application/pdf' },
      { name: 'virus.exe', data: Buffer.from('MZ-executabil'), type: 'application/octet-stream' },
      { name: 'fals.pdf', data: Buffer.from('nu sunt pdf'), type: 'application/pdf' },
      { name: 'pagina.html', data: Buffer.from('<script>alert(1)</script>'), type: 'text/html' },
    ],
  }));
  await deliver(rawMessage({
    subject: 'Mesaj doar HTML',
    messageId: '<html-1@furnizor.exemplu.ro>',
    contentType: 'text/html; charset=utf-8',
    body: '<html><head><style>p{color:red}</style></head><body onload="x()"><script>alert("xss")</script><p>Bună <b>ziua</b></p><img src="http://urmarire.exemplu.ro/pixel.gif"></body></html>',
  }));

  const result = await poll();
  assert.equal(result.imported, 2);
  assert.equal(result.duplicates, 0);
  assert.equal(result.refusedAttachments, 3);
  assert.equal((await inboxBySubject('Mesaj vechi deja citit')).length, 0, 'istoricul citit nu se importă');

  const flags = await withImap(async (c) => {
    const lock = await c.getMailboxLock('INBOX');
    try {
      assert.equal((c.mailbox as Json).exists, 3, 'niciun mesaj nu a dispărut de pe server');
      return (await c.fetchAll('1:*', { uid: true, flags: true, envelope: true })).map((m) => ({ subject: m.envelope?.subject, flags: [...(m.flags ?? [])] }));
    } finally {
      lock.release();
    }
  });
  for (const m of flags) {
    assert.ok(m.flags.includes('\\Seen'), `${m.subject}: ${m.flags}`);
    assert.ok(!m.flags.includes('\\Deleted'), `${m.subject}: ${m.flags}`);
  }
  assert.equal((await audited('email.importat')).length, 2);
});

test('IMAP: repornirea, același Message-ID și același mesaj fără Message-ID nu se importă de două ori', async () => {
  assert.equal((await poll()).imported, 0, 'poziția din bază supraviețuiește repornirii');

  // Aceeași scrisoare, livrată din nou cu alt UID.
  await deliver(rawMessage({ subject: 'Cerere de ofertă ședință', messageId: '<cerere-1@furnizor.exemplu.ro>' }));
  let result = await poll();
  assert.equal(result.imported, 0);
  assert.equal(result.duplicates, 1);
  assert.equal((await inboxBySubject('Cerere de ofertă ședință')).length, 1);

  // Fără Message-ID: amprenta conținutului.
  const noId = rawMessage({ subject: 'Fără identificator', messageId: null });
  await deliver(noId);
  await deliver(noId);
  result = await poll();
  assert.equal(result.imported, 1);
  assert.equal(result.duplicates, 1);
  assert.equal((await inboxBySubject('Fără identificator')).length, 1);

  // Poziția pierdută și mesajele din nou necitite: rămân doar cheile din bază.
  await db.query('DELETE FROM email_imap_state');
  await withImap(async (c) => {
    const lock = await c.getMailboxLock('INBOX');
    try {
      await c.messageFlagsRemove('1:*', ['\\Seen']);
    } finally {
      lock.release();
    }
  });
  result = await poll();
  assert.equal(result.imported, 1, 'doar mesajul vechi, necitit acum, este nou');
  assert.ok(result.duplicates >= 4, JSON.stringify(result));
  assert.equal((await inboxBySubject('Cerere de ofertă ședință')).length, 1);
  assert.equal((await inboxBySubject('Fără identificator')).length, 1);
  assert.equal((await inboxBySubject('Mesaj vechi deja citit')).length, 1);
  await poll();
});

test('IMAP: antetele ieșite din tipar nu blochează preluarea', async () => {
  const longId = `<${'x'.repeat(5000)}@furnizor.exemplu.ro>`;
  await deliver(rawMessage({ subject: 'Message-ID foarte lung', messageId: longId }));
  await deliver(rawMessage({ subject: 'Dată imposibilă', date: 'Mon, 01 Jan 275760 10:00:00 +0200' }));
  await deliver(rawMessage({ subject: 'Dată nevalidă', date: 'nu este o dată' }));
  // Codat în antet: serverul IMAP refuză, pe bună dreptate, octeți NUL direct în mesaj.
  await deliver(rawMessage({ subject: 'Subiect\u0000 cu NUL' }));
  const result = await poll();
  assert.equal(result.imported, 4, JSON.stringify(result));
  assert.equal((await inboxBySubject('Dată nevalidă')).length, 1);
  assert.equal((await inboxBySubject('Subiect cu NUL')).length, 1);
  assert.equal((await onlyMessage('Dată imposibilă')).sentAt, null);
  await deliver(rawMessage({ subject: 'Message-ID foarte lung', messageId: longId }));
  assert.equal((await poll()).duplicates, 1);
});

test('atașamentele neacceptate sunt refuzate cu motiv și fără conținut stocat', async () => {
  const message = await onlyMessage('Cerere de ofertă ședință');
  const by = Object.fromEntries(message.attachments.map((a: Json) => [a.filename, a]));
  assert.equal(by['cerere ședință.pdf'].refusedReason, null);
  assert.equal(by['cerere ședință.pdf'].mime, 'application/pdf');
  assert.equal(by['cerere ședință.pdf'].available, true);
  assert.match(by['virus.exe'].refusedReason, /Tip de fișier neacceptat: exe/);
  assert.match(by['fals.pdf'].refusedReason, /nu este un PDF valid/);
  assert.match(by['pagina.html'].refusedReason, /Tip de fișier neacceptat: html/);
  for (const name of ['virus.exe', 'fals.pdf', 'pagina.html']) {
    assert.equal(by[name].available, false);
    assert.equal((await db.one('SELECT storage_key FROM email_inbox_attachments WHERE id = $1', [by[name].id])).storage_key, null);
    assert.equal((await clients.registratura.get(`/api/mail/inbox/${message.id}/attachments/${by[name].id}`)).status, 409);
    const refused = await clients.registratura.post(`/api/mail/inbox/${message.id}/register`, { attachmentId: by[name].id, title: 'x', documentTypeId: ids.type });
    assert.equal(refused.status, 400, refused.text);
  }
  assert.ok((await audited('email.atasament_refuzat')).length >= 3);

  // Fișierul acceptat stă criptat pe disc, iar descărcarea nu se deschide în browser.
  const key = (await db.one('SELECT storage_key FROM email_inbox_attachments WHERE id = $1', [by['cerere ședință.pdf'].id])).storage_key;
  assert.ok(!fs.readFileSync(path.join(storageDir, key)).includes('MARCAJ-SECRET-PDF'));
  const file = await clients.registratura.bytes(`/api/mail/inbox/${message.id}/attachments/${by['cerere ședință.pdf'].id}`);
  assert.equal(file.status, 200);
  assert.ok(file.data.equals(PDF));
  assert.match(file.headers.get('content-disposition')!, /^attachment;/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
});

test('limita de dimensiune: atașamentul peste limită se refuză, mesajul uriaș nu se descarcă', async () => {
  const limit = config.maxUploadBytes;
  config.maxUploadBytes = 1024;
  try {
    await deliver(rawMessage({
      subject: 'Atașament prea mare',
      attachments: [{ name: 'mare.pdf', data: Buffer.concat([PDF, Buffer.alloc(4096, 0x20)]), type: 'application/pdf' }, { name: 'mic.pdf', data: PDF, type: 'application/pdf' }],
    }));
    assert.equal((await poll()).imported, 1);
  } finally {
    config.maxUploadBytes = limit;
  }
  const big = await onlyMessage('Atașament prea mare');
  assert.match(big.attachments.find((a: Json) => a.filename === 'mare.pdf').refusedReason, /Depășește limita/);
  assert.equal(big.attachments.find((a: Json) => a.filename === 'mic.pdf').refusedReason, null);

  process.env.IMAP_MAX_MESSAGE_BYTES = '200';
  try {
    await deliver(rawMessage({ subject: 'Mesaj uriaș', attachments: [{ name: 'a.pdf', data: PDF, type: 'application/pdf' }] }));
    assert.equal((await poll()).imported, 1);
  } finally {
    delete process.env.IMAP_MAX_MESSAGE_BYTES;
  }
  const huge = await onlyMessage('Mesaj uriaș');
  assert.match(huge.importNote, /peste limita de preluare/);
  assert.equal(huge.attachments.length, 0);
  assert.equal(huge.fromAddress, 'ion.expeditor@furnizor.exemplu.ro');
});

test('HTML-ul din email nu se păstrează și nu se întoarce ca HTML', async () => {
  const r = await clients.registratura.get(`/api/mail/inbox/${(await inboxBySubject('Mesaj doar HTML'))[0].id}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type')!, /^application\/json/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.body.bodyText, /Bună ziua/);
  for (const forbidden of [/<script/i, /<p>/i, /<b>/i, /onload/i, /alert\(/, /color:red/, /<img/i]) assert.doesNotMatch(r.text, forbidden);
  assert.ok(!('html' in r.body) && !('bodyHtml' in r.body));
  const columns = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'email_inbox'`)).rows.map((c: Json) => c.column_name);
  assert.ok(!columns.some((c: string) => /html/.test(c)), 'nicio coloană pentru HTML');

  // Marcajele scrise ca text rămân text și se afișează escapate de React.
  await deliver(rawMessage({ subject: 'Text cu marcaje', body: 'Aveți <script>alert(2)</script> aici' }));
  await poll();
  const literal = await onlyMessage('Text cu marcaje');
  assert.match(literal.bodyText, /<script>alert\(2\)<\/script>/);
  for (const file of ['EmailMessage.tsx', 'EmailInbox.tsx']) {
    const source = fs.readFileSync(path.resolve(TEST_DIR, '../../../web/src/pages', file), 'utf8');
    assert.ok(!source.includes('dangerouslySetInnerHTML'), file);
    assert.ok(!source.includes('innerHTML'), file);
  }
});

test('înregistrarea din email, de la mesaj până la documentul cu număr', async () => {
  const client = clients.registratura;
  const message = await onlyMessage('Cerere de ofertă ședință');
  assert.equal(message.status, 'nou');
  assert.equal(message.fromName, 'Ion Expeditor');
  assert.equal(message.fromAddress, 'ion.expeditor@furnizor.exemplu.ro');
  assert.match(message.bodyText, /vă transmitem documentul/);
  const attachment = message.attachments.find((a: Json) => a.filename === 'cerere ședință.pdf');

  const missingTitle = await client.post(`/api/mail/inbox/${message.id}/register`, { attachmentId: attachment.id, documentTypeId: ids.type });
  assert.equal(missingTitle.status, 400, 'aceleași validări ca formularul');
  assert.equal((await db.one('SELECT status FROM email_inbox WHERE id = $1', [message.id])).status, 'nou');

  const r = await client.post(`/api/mail/inbox/${message.id}/register`, {
    attachmentId: attachment.id,
    title: message.subject,
    issuer: `${message.fromName} <${message.fromAddress}>`,
    documentTypeId: ids.type,
    departmentId: ids.alpha,
    registerId: ids.register,
    metadata: '{}',
    personalData: 'false',
  });
  assert.equal(r.status, 201, r.text);
  assert.match(r.body.regLabel, /^EM-00001\//);

  const doc = await client.get(`/api/documents/${r.body.id}`);
  assert.equal(doc.status, 200, doc.text);
  assert.equal(doc.body.title, 'Cerere de ofertă ședință');
  assert.equal(doc.body.direction, 'intrat');
  assert.equal(doc.body.issuer, 'Ion Expeditor <ion.expeditor@furnizor.exemplu.ro>');
  assert.equal(doc.body.versions[0].filename, 'cerere ședință.pdf');
  assert.equal(doc.body.versions[0].sha256, crypto.createHash('sha256').update(PDF).digest('hex'));
  const stored = await client.bytes(`/api/documents/${r.body.id}/file?kind=original&download=1`);
  assert.ok(stored.data.equals(PDF));

  const linked = await onlyMessage('Cerere de ofertă ședință');
  assert.equal(linked.status, 'inregistrat');
  assert.equal(linked.documentId, r.body.id);
  assert.equal(linked.regLabel, r.body.regLabel);
  assert.equal(linked.attachmentId, attachment.id);
  const trail = (await audited('email.inregistrat')).at(-1);
  assert.equal(trail.document_id, r.body.id);
  assert.equal(trail.username, 'registratura.test');
  assert.doesNotMatch(JSON.stringify(trail.details), /ion\.expeditor|ședință/);

  // A doua înregistrare și renunțarea sunt refuzate; numărul de registru nu se consumă.
  assert.equal((await client.post(`/api/mail/inbox/${message.id}/register`, { attachmentId: attachment.id, title: 'alt', documentTypeId: ids.type, registerId: ids.register })).status, 409);
  assert.equal((await client.post(`/api/mail/inbox/${message.id}/discard`)).status, 409);
  const next = await addDocument('registratura', { title: 'Următorul din registru', registerId: ids.register });
  assert.match(next.regLabel!, /^EM-00002\//);
});

test('două înregistrări simultane ale aceluiași mesaj produc un singur document și niciun număr pierdut', async () => {
  const message = await onlyMessage('Atașament prea mare');
  const attachment = message.attachments.find((a: Json) => a.filename === 'mic.pdf');
  const payload = { attachmentId: attachment.id, title: 'Înregistrare simultană', documentTypeId: ids.type, departmentId: ids.alpha, registerId: ids.register };
  const results = await Promise.all([1, 2].map(() => clients.registratura.post(`/api/mail/inbox/${message.id}/register`, payload)));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM documents WHERE title = 'Înregistrare simultană'`)).n, 1);
  assert.match(results.find((r) => r.status === 201)!.body.regLabel, /^EM-00003\//);
  const next = await addDocument('registratura', { title: 'După simultan', registerId: ids.register });
  assert.match(next.regLabel!, /^EM-00004\//);
});

test('renunțarea șterge copia locală a atașamentelor, iar mesajul rămâne în listă cu starea lui', async () => {
  await deliver(rawMessage({ subject: 'De renunțat', attachments: [{ name: 'x.pdf', data: PDF, type: 'application/pdf' }] }));
  await poll();
  const message = await onlyMessage('De renunțat');
  const key = (await db.one('SELECT storage_key FROM email_inbox_attachments WHERE inbox_id = $1', [message.id])).storage_key;
  assert.ok(fs.existsSync(path.join(storageDir, key)));
  const r = await clients.registratura.post(`/api/mail/inbox/${message.id}/discard`, { reason: 'Reclamă' });
  assert.equal(r.status, 200, r.text);
  assert.ok(!fs.existsSync(path.join(storageDir, key)));
  const after = await onlyMessage('De renunțat');
  assert.equal(after.status, 'renuntat');
  assert.equal(after.discardReason, 'Reclamă');
  assert.equal(after.attachments[0].available, false);
  assert.equal((await clients.registratura.post(`/api/mail/inbox/${message.id}/register`, { attachmentId: after.attachments[0].id, title: 'x', documentTypeId: ids.type })).status, 409);
  assert.ok((await audited('email.renuntat')).length >= 1);
  assert.ok((await audited('email.vizualizare')).length >= 1);
  const filtered = await clients.registratura.get('/api/mail/inbox?status=renuntat');
  assert.deepEqual(filtered.body.items.map((m: Json) => m.subject), ['De renunțat']);
});

test('fără dreptul de înregistrare: 403 pe toate rutele Email primit', async () => {
  const id = (await inboxBySubject('Mesaj doar HTML'))[0].id;
  for (const client of [clients.user]) {
    assert.equal((await client.get('/api/mail/inbox')).status, 403);
    assert.equal((await client.get(`/api/mail/inbox/${id}`)).status, 403);
    assert.equal((await client.get(`/api/mail/inbox/${id}/attachments/1`)).status, 403);
    assert.equal((await client.post('/api/mail/inbox/poll')).status, 403);
    assert.equal((await client.post(`/api/mail/inbox/${id}/register`, { attachmentId: 1, title: 'x' })).status, 403);
    assert.equal((await client.post(`/api/mail/inbox/${id}/discard`)).status, 403);
  }
  assert.equal((await new Client().get('/api/mail/inbox')).status, 401);
  assert.equal((await db.one('SELECT status FROM email_inbox WHERE id = $1', [id])).status, 'nou');
});

test('legătura către document nu apare celui fără acces la document', async () => {
  // Registratura altui departament are dreptul de înregistrare, dar nu vede documentul din Alpha.
  await addUser('registratura.beta', 'registratura', ids.beta);
  const other = await login('registratura.beta');
  const id = (await inboxBySubject('Cerere de ofertă ședință'))[0].id;
  const r = await other.get(`/api/mail/inbox/${id}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.registered, true);
  assert.equal(r.body.documentId, null);
  assert.equal(r.body.regLabel, null);
});

test('IMAP oprit: eroarea e vizibilă, se auditează o singură dată, iar serviciul revine', async () => {
  const seq = await lastSeq();
  process.env.IMAP_PORT = String(await deadPort());
  try {
    assert.equal((await clients.registratura.post('/api/mail/inbox/poll')).status, 502);
    assert.equal((await clients.registratura.post('/api/mail/inbox/poll')).status, 502);
    const list = await clients.registratura.get('/api/mail/inbox');
    assert.equal(list.status, 200);
    assert.ok(list.body.imap.lastError);
    assert.equal((await auditedAfter('email.import_esuat', seq)).length, 1);
  } finally {
    process.env.IMAP_PORT = String(imapPort);
  }
  await poll();
  const list = await clients.registratura.get('/api/mail/inbox');
  assert.equal(list.body.imap.lastError, null);
  assert.ok(list.body.imap.lastSuccessAt);

  const host = process.env.IMAP_HOST;
  delete process.env.IMAP_HOST;
  try {
    assert.equal((await clients.registratura.post('/api/mail/inbox/poll')).status, 409);
    assert.equal((await clients.registratura.get('/api/mail/inbox')).body.imap.enabled, false);
  } finally {
    process.env.IMAP_HOST = host;
  }
});

test('createApp nu pornește lucrătorii; după start, emailul și preluarea IMAP merg singure', async () => {
  const { ImapImporter } = await import('../src/mail-inbox.js');
  sink.received.length = 0;
  await notify.send(ids.user, 'sarcina_noua', 'Automat prin lucrător');
  await deliver(rawMessage({ subject: 'Preluat automat' }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sink.received.length, 0, 'fără start, nimic nu rulează în fundal');
  assert.equal((await inboxBySubject('Preluat automat')).length, 0);

  process.env.MAIL_POLL_MS = '100';
  process.env.IMAP_POLL_MS = '100';
  worker.start();
  app.get(ImapImporter).start();
  const deadline = Date.now() + 15_000;
  const delivered = () => sink.received.length as number;
  while (Date.now() < deadline && !(delivered() === 1 && (await inboxBySubject('Preluat automat')).length === 1)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(sink.received.length, 1);
  assert.equal((await inboxBySubject('Preluat automat')).length, 1);
  await worker.onModuleDestroy();
  await app.get(ImapImporter).onModuleDestroy();
});

// --- Cereri GDPR -------------------------------------------------------------

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const requestFields = { type: 'acces', subjectName: 'Gheorghe Vasilescu', subjectIdentifier: '1800101223344' };

test('GDPR: termenul legal de 30 de zile se calculează din data primirii, iar depășirea e semnalată', async () => {
  const fixed = await clients.admin.post('/api/gdpr/requests', { ...requestFields, receivedOn: '2026-01-15' });
  assert.equal(fixed.status, 201, fixed.text);
  assert.equal(fixed.body.dueOn, '2026-02-14');
  assert.equal(fixed.body.status, 'inregistrata');

  const late = await clients.admin.post('/api/gdpr/requests', { ...requestFields, receivedOn: daysAgo(40) });
  assert.equal(late.body.overdue, true);
  assert.ok(late.body.daysLeft < 0);
  const fresh = await clients.admin.post('/api/gdpr/requests', { ...requestFields, receivedOn: daysAgo(5) });
  assert.equal(fresh.body.overdue, false);
  assert.ok(fresh.body.daysLeft >= 24 && fresh.body.daysLeft <= 26, String(fresh.body.daysLeft));

  for (const bad of [
    { ...requestFields, type: 'necunoscut', receivedOn: daysAgo(1) },
    { ...requestFields, subjectName: '  ', receivedOn: daysAgo(1) },
    { ...requestFields, receivedOn: 'ieri' },
    { ...requestFields, receivedOn: '2026-02-31' },
    { ...requestFields, receivedOn: daysAgo(-3) },
    { ...requestFields, receivedOn: daysAgo(1), assigneeId: ids.user },
  ]) {
    const r = await clients.admin.post('/api/gdpr/requests', bad);
    assert.equal(r.status, 400, `${JSON.stringify(bad)} → ${r.text}`);
  }

  const list = await clients.admin.get('/api/gdpr/requests');
  assert.equal(list.status, 200);
  assert.equal(list.body.items[0].overdue, true, 'cele depășite sunt primele');
  const overdue = await clients.admin.get('/api/gdpr/requests?overdue=1');
  assert.ok(overdue.body.items.every((r: Json) => r.overdue));
  assert.equal(overdue.body.overdue, overdue.body.total);

  // Cererea soluționată nu mai este depășită; închiderea cere soluția.
  assert.equal((await clients.admin.patch(`/api/gdpr/requests/${late.body.id}`, { status: 'solutionata' })).status, 400);
  const closed = await clients.admin.patch(`/api/gdpr/requests/${late.body.id}`, { status: 'solutionata', resolutionNote: 'Răspuns trimis.', assigneeId: ids.auditor });
  assert.equal(closed.status, 200, closed.text);
  assert.equal(closed.body.overdue, false);
  assert.ok(closed.body.closedAt);
  assert.equal(closed.body.assigneeId, ids.auditor);
  const reopened = await clients.admin.patch(`/api/gdpr/requests/${late.body.id}`, { status: 'in_lucru' });
  assert.equal(reopened.body.closedAt, null);
  assert.equal(reopened.body.overdue, true);
  await clients.admin.patch(`/api/gdpr/requests/${late.body.id}`, { status: 'solutionata' });
});

test('GDPR: doar audit_all are acces', async () => {
  for (const name of ['registratura', 'user', 'managerB']) {
    assert.equal((await clients[name].get('/api/gdpr/requests')).status, 403, name);
    assert.equal((await clients[name].post('/api/gdpr/requests', { ...requestFields, receivedOn: daysAgo(1) })).status, 403, name);
    assert.equal((await clients[name].get('/api/gdpr/requests/1/search')).status, 403, name);
    assert.equal((await clients[name].get('/api/gdpr/requests/1/export')).status, 403, name);
  }
  assert.equal((await clients.auditor.get('/api/gdpr/requests')).status, 200);
  assert.equal((await new Client().get('/api/gdpr/requests')).status, 401);
  const assignees = await clients.admin.get('/api/gdpr/requests/assignees');
  assert.deepEqual(assignees.body.map((u: Json) => u.id).sort(), [ids.admin, ids.auditor].sort());
});

let requestId = 0;
const docs: Record<string, number> = {};

test('GDPR: căutarea respectă domeniul, fără diacritice și fără a depăși accesul utilizatorului', async () => {
  docs.personal = (await addDocument('registratura', { title: 'Dosar de personal', summary: 'Angajat: Gheorghe Vasilescu', personalData: 'true' })).id;
  docs.general = (await addDocument('registratura', { title: 'Proces verbal', summary: 'Prezent: Vasilescu Gheorghe' })).id;
  docs.other = (await addDocument('registratura', { title: 'Alt dosar', summary: 'Angajat: Ion Popa', personalData: 'true' })).id;
  docs.byIdentifier = (await addDocument('registratura', { title: 'Adeverință', summary: 'CNP 1800101223344', personalData: 'true' })).id;
  docs.byContent = (await addDocument('registratura', { title: 'Scrisoare', personalData: 'true' }, 'Subsemnatul Gheorghe Vasilescu solicit eliberarea unei adeverințe.\n')).id;
  docs.beta = (await addDocument('admin', { title: 'Dosar Beta', summary: 'Gheorghe Vasilescu', departmentId: ids.beta, personalData: 'true' })).id;
  docs.formula = (await addDocument('registratura', { title: '=HYPERLINK("http://rau.exemplu.ro")', summary: 'Gheorghe Vasilescu', personalData: 'true' })).id;
  await ocr.drain();

  const created = await clients.admin.post('/api/gdpr/requests', { type: 'stergere', subjectName: 'Gheorghe Vasilescu', subjectIdentifier: '1800101223344', receivedOn: daysAgo(2) });
  requestId = created.body.id;

  const personal = await clients.admin.get(`/api/gdpr/requests/${requestId}/search`);
  assert.equal(personal.status, 200, personal.text);
  assert.equal(personal.body.scope, 'personal');
  const personalIds = personal.body.items.map((d: Json) => d.id);
  for (const id of [docs.personal, docs.byIdentifier, docs.byContent, docs.beta]) assert.ok(personalIds.includes(id), `lipsește ${id}`);
  assert.ok(!personalIds.includes(docs.general), 'documentul fără date personale nu apare implicit');
  assert.ok(!personalIds.includes(docs.other), 'documentul fără mențiune nu apare');
  assert.equal(personal.body.notVisible, 0);

  const all = await clients.admin.get(`/api/gdpr/requests/${requestId}/search?scope=all`);
  assert.equal(all.body.scope, 'all');
  const allIds = all.body.items.map((d: Json) => d.id);
  assert.ok(allIds.includes(docs.general));
  assert.ok(!allIds.includes(docs.other));
  assert.equal(all.body.items.find((d: Json) => d.id === docs.general).personalData, false);

  // Fără diacritice și cu sedilă: aceeași căutare ca lista de documente.
  const plain = await clients.admin.post('/api/gdpr/requests', { type: 'acces', subjectName: 'ADEVERINTELE', receivedOn: daysAgo(1) });
  const plainIds = (await clients.admin.get(`/api/gdpr/requests/${plain.body.id}/search`)).body.items.map((d: Json) => d.id);
  assert.ok(plainIds.includes(docs.byContent), 'găsește și prin textul extras din fișier');

  // Auditorul din Beta nu vede documentele din Alpha, dar află câte i-au rămas ascunse.
  const limited = await clients.auditor.get(`/api/gdpr/requests/${requestId}/search`);
  assert.equal(limited.status, 200);
  assert.deepEqual(limited.body.items.map((d: Json) => d.id), [docs.beta]);
  assert.equal(limited.body.notVisible, personal.body.total - 1);
  assert.doesNotMatch(limited.text, /Dosar de personal/);
});

test('GDPR: exportul CSV conține lista găsită și jurnalul de acces al acelor documente', async () => {
  // O consultare reală a documentului: apare apoi în jurnal.
  assert.equal((await clients.registratura.get(`/api/documents/${docs.personal}`)).status, 200);
  assert.equal((await clients.registratura.get(`/api/documents/${docs.general}`)).status, 200);

  const csv = await clients.admin.get(`/api/gdpr/requests/${requestId}/export`);
  assert.equal(csv.status, 200, csv.text);
  assert.match(csv.headers.get('content-type')!, /^text\/csv/);
  assert.equal(csv.headers.get('content-disposition'), `attachment; filename="cerere-gdpr-${requestId}.csv"`);
  assert.equal(csv.text.charCodeAt(0), 0xfeff);
  const lines = csv.text.slice(1).split('\r\n');
  const documentsAt = lines.indexOf('"Documente găsite"');
  const logAt = lines.indexOf('"Jurnal de acces"');
  assert.ok(documentsAt > 0 && logAt > documentsAt, csv.text);
  const docRows = lines.slice(documentsAt + 2, logAt - 1);
  const logRows = lines.slice(logAt + 2);
  assert.ok(docRows.some((l) => l.startsWith(`"${docs.personal}";`) && l.includes('Dosar de personal')));
  assert.ok(!docRows.some((l) => l.startsWith(`"${docs.general}";`)), 'domeniul implicit exclude documentele fără date personale');
  assert.ok(logRows.some((l) => l.includes('gdpr.acces_date_personale') && l.includes('registratura.test') && l.includes(`"${docs.personal}"`)), csv.text);
  assert.ok(!logRows.some((l) => l.includes(`"${docs.general}"`)));
  assert.ok(lines.some((l) => l.includes(`'=HYPERLINK`)), 'celula cu formulă este neutralizată');
  assert.ok(!lines.some((l) => l.startsWith('"=') || l.includes(';"=HYPERLINK')));

  const wide = await clients.admin.get(`/api/gdpr/requests/${requestId}/export?scope=all`);
  assert.ok(wide.text.includes('Proces verbal'));
  assert.ok(wide.text.split('"Jurnal de acces"')[1].includes(`"${docs.general}"`));

  const limited = await clients.auditor.get(`/api/gdpr/requests/${requestId}/export`);
  assert.equal(limited.status, 200);
  assert.ok(!limited.text.includes('Dosar de personal'));
  assert.ok(!limited.text.split('"Jurnal de acces"')[1].includes(`"${docs.personal}"`));
});

test('GDPR: pentru ștergere se consemnează decizia; documentul sub retenție rămâne neatins', async () => {
  const before = await clients.admin.get(`/api/documents/${docs.personal}`);
  const file = await clients.admin.bytes(`/api/documents/${docs.personal}/file?kind=original&download=1`);

  assert.equal((await clients.admin.put(`/api/gdpr/requests/${requestId}/decisions/${docs.personal}`, { decision: 'sterge_acum' })).status, 400);
  assert.equal((await clients.admin.put(`/api/gdpr/requests/${requestId}/decisions/${docs.personal}`, { decision: 'alta' })).status, 400, 'cere notă');
  const r = await clients.admin.put(`/api/gdpr/requests/${requestId}/decisions/${docs.personal}`, { decision: 'pastrare_retentie', note: 'Termen de păstrare legal în curs.' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.documentStatus, before.body.status);

  const after = await clients.admin.get(`/api/documents/${docs.personal}`);
  assert.equal(after.status, 200);
  assert.equal(after.body.status, before.body.status);
  assert.ok((await clients.admin.bytes(`/api/documents/${docs.personal}/file?kind=original&download=1`)).data.equals(file.data));
  assert.ok((await clients.admin.del(`/api/gdpr/requests/${requestId}/decisions/${docs.personal}`)).status >= 404, 'nu există rută de ștergere');
  assert.ok((await clients.admin.del(`/api/gdpr/requests/${requestId}`)).status >= 404);

  const search = await clients.admin.get(`/api/gdpr/requests/${requestId}/search`);
  const found = search.body.items.find((d: Json) => d.id === docs.personal);
  assert.equal(found.decision, 'pastrare_retentie');
  assert.equal(found.retentionActive, true);
  const detail = await clients.admin.get(`/api/gdpr/requests/${requestId}`);
  assert.equal(detail.body.decisions.length, 1);
  assert.equal(detail.body.decisions[0].note, 'Termen de păstrare legal în curs.');
  const csv = await clients.admin.get(`/api/gdpr/requests/${requestId}/export`);
  assert.ok(csv.text.includes('pastrare_retentie'));

  // Fără acces la document, nu se poate consemna nimic despre el.
  assert.equal((await clients.auditor.put(`/api/gdpr/requests/${requestId}/decisions/${docs.personal}`, { decision: 'pastrare_retentie' })).status, 404);

  // Pe o cerere închisă, decizia nu se mai schimbă.
  await clients.admin.patch(`/api/gdpr/requests/${requestId}`, { status: 'solutionata', resolutionNote: 'Documentele se păstrează până la expirarea termenului.' });
  assert.equal((await clients.admin.put(`/api/gdpr/requests/${requestId}/decisions/${docs.personal}`, { decision: 'fara_legatura' })).status, 409);
});

test('GDPR: fiecare pas se auditează, fără numele sau identificatorul persoanei în jurnalul imuabil', async () => {
  for (const action of ['gdpr.cerere_creata', 'gdpr.cerere_modificata', 'gdpr.cerere_consultata', 'gdpr.cerere_cautare', 'gdpr.cerere_export', 'gdpr.cerere_decizie']) {
    assert.ok((await audited(action)).length >= 1, action);
  }
  const rows = (await db.query(`SELECT action, details::text AS details FROM audit_log WHERE action LIKE 'gdpr.cerere_%' OR action LIKE 'email.%'`)).rows;
  for (const row of rows) {
    assert.doesNotMatch(row.details, /Vasilescu|1800101223344|ion\.expeditor/, row.action);
  }
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'cautare' AND details::text LIKE '%Vasilescu%'`)).n, 0);
  const verify = await clients.admin.get('/api/audit/verify');
  assert.equal(verify.body.ok, true);
});
