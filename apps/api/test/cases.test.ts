// Lucrări (petiții, 544, contravenții, controale), anulare, expediere, Intranet și tokenuri API, pe PostgreSQL real.
import 'reflect-metadata';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://seadoc@127.0.0.1:55432/seadoc_cases_test';
if (!/test/.test(new URL(databaseUrl).pathname)) throw new Error('Testele șterg baza de date: DATABASE_URL trebuie să indice o bază de test');
process.env.DATABASE_URL = databaseUrl;
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'seadoc-cases-'));
process.env.OCR_POLL_MS = '86400000';
process.env.SCHEDULER_MS = '86400000';

const { after, before, beforeEach, test } = await import('node:test');
const { AuditService } = await import('../src/audit.js');
const { AuthService, COOKIE, hashPassword } = await import('../src/auth.js');
const { CasesController, CasesService, DispatchController, TemplatesController } = await import('../src/cases.js');
const { Db } = await import('../src/db.js');
const { DocumentsController, DocumentsService } = await import('../src/documents.js');
const { ApiTokensController, IntranetController } = await import('../src/intranet.js');
const { NotificationController, NotificationService } = await import('../src/notifications.js');
const { OcrService } = await import('../src/ocr.js');
const { StorageService } = await import('../src/storage.js');
const { textPdf } = await import('../scripts/pdf-tools.js');
const { ApiExceptionFilter } = await import('../src/main.js');

@Module({
  controllers: [DocumentsController, CasesController, DispatchController, TemplatesController, IntranetController, ApiTokensController, NotificationController],
  providers: [Db, AuditService, NotificationService, StorageService, OcrService, DocumentsService, AuthService, CasesService],
})
class TestModule {}

const PASSWORD_HASH = hashPassword('Parola-Test-123!');
type Name = 'admin' | 'reg' | 'sef' | 'agent' | 'agent2' | 'sef2' | 'strain';
const ids = {} as Record<Name, number>;
const tokens = {} as Record<Name, string>;
let app: INestApplication;
let db: InstanceType<typeof Db>;
let cases: InstanceType<typeof CasesService>;
let base: string;
let dep1: number;
let dep2: number;
let typeId: number;
let registerId: number;
let templates: any[] = [];

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest' }).format(new Date());
const daysAgo = (n: number) => { const d = new Date(`${today()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const plusDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const plusMonths = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

before(async () => {
  app = await NestFactory.create(TestModule, { logger: false });
  app.use(cookieParser());
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  db = app.get(Db);
  cases = app.get(CasesService);
  await db.migrate();
  // TRUNCATE ... CASCADE pe registre golește și șabloanele; se pun la loc înaintea fiecărui test.
  templates = (await db.query('SELECT * FROM document_templates ORDER BY id')).rows;
});

after(async () => { await app.close(); });

beforeEach(async () => {
  await db.query(`TRUNCATE api_tokens, intranet_reads, intranet_posts, dispatches, case_contraventions, case_photos, case_events, case_documents,
    case_objects, cases, case_counters, notifications, email_outbox, signatures, duplicate_matches, document_links, document_access, favorites,
    access_grants, document_versions, documents, registers, register_counters, folders, sessions, user_permissions, users, departments CASCADE`);
  await db.query('TRUNCATE document_templates');
  await db.query('DELETE FROM document_types');
  for (const t of templates) {
    await db.query(`INSERT INTO document_templates (id, code, name, case_kind, case_role, title, body, active) VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
      [t.id, t.code, t.name, t.case_kind, t.case_role, t.title, t.body]);
  }
  dep1 = (await db.one(`INSERT INTO departments (name) VALUES ('Ordine publică') RETURNING id`))!.id;
  dep2 = (await db.one(`INSERT INTO departments (name) VALUES ('Disciplina în construcții') RETURNING id`))!.id;
  typeId = (await db.one(`INSERT INTO document_types (name, nomenclator_code) VALUES ('Corespondență', 'C1') RETURNING id`))!.id;
  registerId = (await db.one(`INSERT INTO registers (name, code) VALUES ('Registru general', 'RG') RETURNING id`))!.id;
  const people: [Name, string, number][] = [
    ['admin', 'admin', dep1], ['reg', 'registratura', dep1], ['sef', 'manager', dep1], ['agent', 'user', dep1],
    ['agent2', 'user', dep1], ['sef2', 'manager', dep2], ['strain', 'user', dep2],
  ];
  for (const [name, role, department] of people) {
    ids[name] = (await db.one(
      `INSERT INTO users (username, full_name, password_hash, role, department_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, `Nume ${name}`, PASSWORD_HASH, role, department]))!.id;
    tokens[name] = crypto.randomBytes(16).toString('hex');
    await db.query(`INSERT INTO sessions (token_hash, user_id, mfa_ok, expires_at) VALUES ($1,$2,true, now() + interval '1 hour')`,
      [crypto.createHash('sha256').update(tokens[name]).digest('hex'), ids[name]]);
  }
  await db.query('UPDATE departments SET manager_id = $1 WHERE id = $2', [ids.sef, dep1]);
  await db.query('UPDATE departments SET manager_id = $1 WHERE id = $2', [ids.sef2, dep2]);
});

async function api(as: Name | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(as ? { cookie: `${COOKIE}=${tokens[as]}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  if ((res.headers.get('content-type') ?? '').includes('json')) parsed = JSON.parse(text);
  return { status: res.status, body: parsed, text, headers: res.headers };
}
async function must(as: Name, method: string, url: string, body?: unknown) {
  const r = await api(as, method, url, body);
  assert.ok(r.status < 300, `${method} ${url} → ${r.status} ${r.text}`);
  return r.body;
}
async function upload(as: Name, url: string, fields: Record<string, unknown>, file?: { name: string; data: Buffer; type: string }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (file) form.set('file', new Blob([new Uint8Array(file.data)], { type: file.type }), file.name);
  const res = await fetch(`${base}${url}`, { method: 'POST', headers: { cookie: `${COOKIE}=${tokens[as]}` }, body: form });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
async function registerDoc(as: Name = 'reg', extra: Record<string, unknown> = {}) {
  const pdf = await textPdf({ title: 'Test', paragraphs: ['Petiție privind parcarea de pe strada Lăpușneanu'] });
  const r = await upload(as, '/documents', { title: 'Petiție parcare', direction: 'intrat', registerId, documentTypeId: typeId, departmentId: dep1, issuer: 'Ion Ionescu', ...extra },
    { name: 'petitie.pdf', data: pdf, type: 'application/pdf' });
  assert.equal(r.status, 201, r.text);
  return r.body as { id: number; regLabel: string };
}
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(200)]);

// Registratură -----------------------------------------------------------------

test('anularea păstrează numărul, cere motiv și blochează documentul', async () => {
  const doc = await registerDoc();
  assert.equal((await api('reg', 'POST', `/documents/${doc.id}/cancel`, { reason: '' })).status, 400);
  assert.equal((await api('agent', 'POST', `/documents/${doc.id}/cancel`, { reason: 'Înregistrat din greșeală' })).status, 403);
  await must('reg', 'POST', `/documents/${doc.id}/cancel`, { reason: 'Înregistrat de două ori' });
  const d = await must('reg', 'GET', `/documents/${doc.id}`);
  assert.equal(d.status, 'anulat');
  assert.equal(d.regLabel, doc.regLabel);
  assert.equal(d.cancelReason, 'Înregistrat de două ori');
  assert.equal(d.canCancel, false);
  assert.equal((await api('reg', 'POST', `/documents/${doc.id}/cancel`, { reason: 'Din nou, a doua oară' })).status, 409);
  const v = await upload('reg', `/documents/${doc.id}/versions`, {}, { name: 'v2.pdf', data: await textPdf({ title: 'Test', paragraphs: ['v2'] }), type: 'application/pdf' });
  assert.equal(v.status, 409);
  const csv = await api('reg', 'GET', `/documents/export/register?registerId=${registerId}`);
  assert.match(csv.text, /anulat.*Înregistrat de două ori/);
  const next = await registerDoc();
  assert.notEqual(next.regLabel, doc.regLabel, 'numărul anulat nu se refolosește');
  assert.equal(Number((await db.one(`SELECT count(*) AS n FROM audit_log WHERE action = 'document.anulat' AND document_id = $1`, [doc.id]))!.n), 1);
});

test('documentele conexe și documentele confidențiale', async () => {
  const a = await registerDoc();
  const b = await registerDoc();
  await must('reg', 'POST', `/documents/${a.id}/links`, { toId: b.id, kind: 'conex' });
  assert.equal((await must('reg', 'GET', `/documents/${a.id}`)).links[0].kind, 'conex');

  const secret = await registerDoc('reg', { confidential: 'true' });
  // Șeful vede documentele departamentului, dar nu și pe cele confidențiale.
  assert.equal((await api('sef', 'GET', `/documents/${a.id}`)).status, 200);
  assert.equal((await api('sef', 'GET', `/documents/${secret.id}`)).status, 404);
  await db.query(`INSERT INTO access_grants (user_id, scope, target_id) VALUES ($1, 'department', $2)`, [ids.strain, dep1]);
  assert.equal((await api('strain', 'GET', `/documents/${secret.id}`)).status, 404);
  await db.query(`INSERT INTO access_grants (user_id, scope, target_id) VALUES ($1, 'document', $2)`, [ids.strain, secret.id]);
  assert.equal((await api('strain', 'GET', `/documents/${secret.id}`)).status, 200);
  assert.equal((await api('admin', 'GET', `/documents/${secret.id}`)).status, 200);
});

// Petiții ---------------------------------------------------------------------------

test('petiția: termen de 30 de zile, prelungire cu cel mult 15, obiecte multiple, închidere și redeschidere', async () => {
  const doc = await registerDoc();
  assert.equal((await api('agent', 'POST', '/cases', { kind: 'petitie', subject: 'x', applicantName: 'Ion' })).status, 403);
  const p = await must('reg', 'POST', '/cases', {
    kind: 'petitie', subject: 'Parcare neregulamentară și iluminat', applicantName: 'Ion Ionescu', applicantAddress: 'Str. Lăpușneanu 10, Iași',
    location: 'Strada Lăpușneanu 10', documentId: doc.id, channel: 'scris', departmentId: dep1, assigneeId: ids.agent,
    objects: [{ text: 'Mașini parcate pe trotuar' }, { text: 'Iluminat defect', departmentId: dep2 }],
  });
  assert.match(p.regLabel, /^P-00001\/\d{4}$/);
  assert.equal(p.dueOn, plusDays(today(), 30));
  assert.equal(p.daysLeft, 30);
  assert.ok(await db.one(`SELECT 1 AS x FROM notifications WHERE user_id = $1 AND link = $2`, [ids.agent, `/lucrari/${p.id}`]));

  // Vizibilitate: agentul repartizat, șeful compartimentului, șeful celuilalt compartiment (are un obiect), nu și un străin.
  assert.equal((await api('agent', 'GET', `/cases/${p.id}`)).status, 200);
  assert.equal((await api('sef', 'GET', `/cases/${p.id}`)).status, 200);
  assert.equal((await api('sef2', 'GET', `/cases/${p.id}`)).status, 200);
  assert.equal((await api('strain', 'GET', `/cases/${p.id}`)).status, 404);

  assert.equal((await api('agent', 'POST', `/cases/${p.id}/extend`, { days: 16, reason: 'Verificări' })).status, 400);
  const ext = await must('agent', 'POST', `/cases/${p.id}/extend`, { days: 15, reason: 'Verificări la fața locului' });
  assert.equal(ext.dueOn, plusDays(today(), 45));
  assert.equal((await api('agent', 'POST', `/cases/${p.id}/extend`, { days: 1, reason: 'Încă o dată' })).status, 409);

  const closeEarly = await api('agent', 'POST', `/cases/${p.id}/close`, { outcome: 'favorabil', note: 'Rezolvat' });
  assert.equal(closeEarly.status, 409);
  const detail = await must('agent', 'GET', `/cases/${p.id}`);
  assert.equal(detail.objects.length, 2);
  assert.equal(detail.documents[0].role, 'principal');
  assert.equal((await api('agent', 'PATCH', `/cases/${p.id}/objects/${detail.objects[0].id}`, { status: 'solutionat' })).status, 400);
  for (const o of detail.objects) await must('agent', 'PATCH', `/cases/${p.id}/objects/${o.id}`, { status: 'solutionat', answer: 'S-au luat măsuri' });
  const closed = await must('agent', 'POST', `/cases/${p.id}/close`, { outcome: 'favorabil', note: 'Au fost aplicate 3 sancțiuni.' });
  assert.equal(closed.status, 'inchisa');
  assert.equal((await api('agent', 'PATCH', `/cases/${p.id}`, { subject: 'Alt obiect' })).status, 409);
  const reopened = await must('sef', 'POST', `/cases/${p.id}/reopen`, { reason: 'Petentul revine cu fotografii' });
  assert.equal(reopened.status, 'deschisa');
  assert.equal(reopened.outcome, null);
  const events = (await must('sef', 'GET', `/cases/${p.id}`)).events.map((e: any) => e.kind);
  for (const k of ['inregistrare', 'prelungire', 'obiect_solutionat', 'inchidere', 'redeschidere']) assert.ok(events.includes(k), k);
  const audit = (await db.query(`SELECT action FROM audit_log WHERE action LIKE 'lucrare.%'`)).rows.map((r: any) => r.action);
  for (const a of ['lucrare.inregistrata', 'lucrare.termen_prelungit', 'lucrare.inchisa', 'lucrare.redeschisa']) assert.ok(audit.includes(a), a);
});

test('redirecționarea generează adresele din șablon, ca documente înregistrate', async () => {
  const p = await must('reg', 'POST', '/cases', { kind: 'petitie', subject: 'Groapă în carosabil', applicantName: 'Maria Pop', applicantAddress: 'Str. Florilor 2', departmentId: dep1 });
  assert.equal((await api('reg', 'POST', `/cases/${p.id}/close`, { outcome: 'redirectionata', note: 'Nu e de competența noastră' })).status, 400);
  await must('reg', 'POST', `/cases/${p.id}/close`, { outcome: 'redirectionata', note: 'Competența aparține administratorului drumurilor', redirectedTo: 'Primăria Municipiului Iași' });
  const detail = await must('reg', 'GET', `/cases/${p.id}`);
  const tPetent = detail.templates.find((t: any) => t.code === 'petitie_redirectionare_petent');
  const tInst = detail.templates.find((t: any) => t.code === 'petitie_redirectionare_institutie');
  assert.ok(tPetent && tInst);
  assert.ok(!detail.templates.some((t: any) => t.code.startsWith('pv_')), 'doar șabloanele petițiilor');
  const fields = await must('reg', 'GET', `/cases/${p.id}/templates/${tInst.id}`);
  assert.equal(fields.fields.find((f: any) => f.key === 'institutie_competenta').value, 'Primăria Municipiului Iași');
  const preview = await fetch(`${base}/cases/${p.id}/templates/${tPetent.id}/preview`, { headers: { cookie: `${COOKIE}=${tokens.reg}` } });
  assert.equal(preview.status, 200);
  assert.equal(Buffer.from(await preview.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  assert.equal((await api('reg', 'POST', `/cases/${p.id}/generate`, { templateId: tPetent.id })).status, 400, 'fără tip de document');
  const g1 = await must('reg', 'POST', `/cases/${p.id}/generate`, { templateId: tPetent.id, documentTypeId: typeId, registerId });
  const g2 = await must('reg', 'POST', `/cases/${p.id}/generate`, { templateId: tInst.id, documentTypeId: typeId, registerId });
  assert.match(g1.regLabel, /^RG-/);
  const docs = (await must('reg', 'GET', `/cases/${p.id}`)).documents;
  assert.deepEqual(docs.map((d: any) => d.role), ['adresa', 'adresa']);
  const doc = await must('reg', 'GET', `/documents/${g2.id}`);
  assert.equal(doc.recipient, 'Primăria Municipiului Iași');
  assert.equal(doc.direction, 'iesit');
  assert.deepEqual(doc.cases.map((c: any) => c.regLabel), [p.regLabel]);
  // Agentul fără drept de registratură poate genera din lucrarea lui.
  const own = await must('agent', 'POST', '/cases', { kind: 'control', subject: 'Control comercial', location: 'Piața Unirii 1' });
  const tc = (await must('agent', 'GET', `/cases/${own.id}`)).templates.find((t: any) => t.code === 'control_proces_verbal');
  const gen = await must('agent', 'POST', `/cases/${own.id}/generate`, { templateId: tc.id, documentTypeId: typeId, values: { constatari: 'Lipsă autorizație', echipa: 'Nume agent' } });
  assert.equal((await must('agent', 'GET', `/documents/${gen.id}`)).owner, 'Nume agent');
});

test('conexarea leagă petiția de alta de același tip', async () => {
  const a = await must('reg', 'POST', '/cases', { kind: 'petitie', subject: 'Zgomot', applicantName: 'Ion', departmentId: dep1 });
  const b = await must('reg', 'POST', '/cases', { kind: 'petitie', subject: 'Zgomot, revenire', applicantName: 'Ion', departmentId: dep1 });
  const i = await must('reg', 'POST', '/cases', { kind: 'informatii_publice', subject: 'Buget', applicantName: 'Ion', departmentId: dep1 });
  assert.equal((await api('reg', 'POST', `/cases/${b.id}/close`, { outcome: 'conexata', note: 'Același obiect', parentId: i.id })).status, 400);
  assert.equal((await api('reg', 'POST', `/cases/${b.id}/close`, { outcome: 'conexata', note: 'Același obiect', parentId: b.id })).status, 400);
  const r = await must('reg', 'POST', `/cases/${b.id}/close`, { outcome: 'conexata', note: 'Același petent, același obiect', parentId: a.id });
  assert.equal(r.parentId, a.id);
  assert.equal((await must('reg', 'GET', `/cases/${a.id}`)).children[0].id, b.id);
});

test('Legea 544/2001: 10 zile, prelungire la 30 doar în primele 10 zile, refuz în 5 zile', async () => {
  const r = await must('reg', 'POST', '/cases', { kind: 'informatii_publice', subject: 'Numărul de amenzi în 2026', applicantName: 'Asociația X', departmentId: dep1 });
  assert.match(r.regLabel, /^I-/);
  assert.equal(r.dueOn, plusDays(today(), 10));
  const d = await must('reg', 'GET', `/cases/${r.id}`);
  assert.deepEqual(d.deadlines.map((x: any) => [x.key, x.date]), [['raspuns', plusDays(today(), 10)], ['refuz', plusDays(today(), 5)]]);
  const ext = await must('reg', 'POST', `/cases/${r.id}/extend`, { reason: 'Informații din mai multe compartimente' });
  assert.equal(ext.dueOn, plusDays(today(), 30));
  const late = await must('reg', 'POST', '/cases', { kind: 'informatii_publice', subject: 'Contracte', applicantName: 'Ion', receivedOn: daysAgo(11), departmentId: dep1 });
  assert.equal(late.overdue, true);
  assert.equal((await api('reg', 'POST', `/cases/${late.id}/extend`, { reason: 'Prea târziu' })).status, 409);
});

// Contravenții ------------------------------------------------------------------------

test('dosarul contravențional: comunicare în 2 luni, plată și plângere în 15 zile, trimitere spre executare', async () => {
  const applied = daysAgo(40);
  const pv = {
    pvSeries: 'pl', pvNumber: '0012345', offenderName: 'Vasile Georgescu', offenderIdCode: '1800101223344', offenderAddress: 'Str. Mare 5, Iași',
    fact: 'A depozitat deșeuri pe domeniul public', legalBasis: 'HCL 100/2020 art. 5', sanction: 'amenda', amount: 1000, minAmount: 500, appliedOn: applied,
  };
  assert.equal((await api('agent', 'POST', '/cases', { kind: 'contraventie', contravention: { ...pv, amount: undefined } })).status, 400);
  const c = await must('agent', 'POST', '/cases', { kind: 'contraventie', location: 'Str. Mare 5', contravention: pv, receivedOn: applied });
  assert.match(c.regLabel, /^DC-/);
  assert.equal(c.pvLabel, 'PL 0012345');
  assert.equal(c.dueOn, plusMonths(applied, 2), 'termenul de comunicare');
  assert.equal(c.assigneeId, ids.agent);
  assert.equal((await api('agent2', 'POST', '/cases', { kind: 'contraventie', contravention: pv })).status, 409, 'aceeași serie și număr');

  assert.equal((await api('agent', 'PATCH', `/cases/${c.id}/contravention`, { communicatedOn: daysAgo(50) })).status, 400, 'înaintea aplicării');
  await must('agent', 'PATCH', `/cases/${c.id}/contravention`, { communicatedOn: daysAgo(30), communicationMethod: 'posta' });
  let d = await must('agent', 'GET', `/cases/${c.id}`);
  assert.equal(d.dueOn, null);
  assert.equal(d.contravention.halfMinimum, 250);
  assert.equal(d.contravention.payHalfDue, plusDays(daysAgo(30), 15));
  assert.equal(d.contravention.readyForExecution, true);
  const ready = await must('sef', 'GET', '/cases?readyForExecution=1');
  assert.deepEqual(ready.items.map((x: any) => x.id), [c.id]);

  assert.equal((await api('agent', 'POST', `/cases/${c.id}/close`, { outcome: 'executare', note: 'Trimis' })).status, 409);
  assert.equal((await api('agent', 'PATCH', `/cases/${c.id}/contravention`, { executionSentOn: today() })).status, 400, 'fără organul de executare');
  await must('agent', 'PATCH', `/cases/${c.id}/contravention`, { executionSentOn: today(), executionBody: 'DITL Iași' });
  const tpl = (await must('agent', 'GET', `/cases/${c.id}`)).templates.find((t: any) => t.code === 'pv_executare');
  const f = await must('agent', 'GET', `/cases/${c.id}/templates/${tpl.id}`);
  assert.equal(f.fields.find((x: any) => x.key === 'organ_executare').value, 'DITL Iași');
  await must('agent', 'POST', `/cases/${c.id}/close`, { outcome: 'executare', note: 'Trimis la DITL' });

  // Plângerea și hotărârea
  const c2 = await must('agent', 'POST', '/cases', { kind: 'contraventie', contravention: { ...pv, pvNumber: '0012346', appliedOn: daysAgo(20) }, receivedOn: daysAgo(20) });
  assert.equal((await api('agent', 'PATCH', `/cases/${c2.id}/contravention`, { decisionOn: today(), decisionOutcome: 'plangere_admisa' })).status, 400);
  await must('agent', 'PATCH', `/cases/${c2.id}/contravention`, { communicatedOn: daysAgo(19), communicationMethod: 'inmanare', complaintFiledOn: daysAgo(10), court: 'Judecătoria Iași' });
  d = await must('agent', 'GET', `/cases/${c2.id}`);
  assert.equal(d.contravention.readyForExecution, false, 'contestat');
  await must('agent', 'PATCH', `/cases/${c2.id}/contravention`, { decisionOn: today(), decisionOutcome: 'plangere_respinsa' });
  assert.equal((await must('agent', 'GET', `/cases/${c2.id}`)).contravention.readyForExecution, true);
  await must('agent', 'PATCH', `/cases/${c2.id}/contravention`, { paidOn: today(), paidAmount: 1000 });
  assert.equal((await api('agent', 'PATCH', `/cases/${c2.id}/contravention`, { executionSentOn: today(), executionBody: 'DITL' })).status, 400, 'achitată');
  await must('agent', 'POST', `/cases/${c2.id}/close`, { outcome: 'achitat', note: 'Achitat integral' });
});

test('fotografiile din teren și istoricul pe adresă', async () => {
  const ctrl = await must('agent', 'POST', '/cases', { kind: 'control', subject: 'Verificare șantier', location: 'Bulevardul Ștefan cel Mare și Sfânt 8, Iași', manualDueOn: plusDays(today(), 7) });
  const ok = await upload('agent', `/cases/${ctrl.id}/photos`, { latitude: '47.1622', longitude: '27.5889', note: 'Fațada' }, { name: 'IMG_0001.jpg', data: jpeg, type: 'image/jpeg' });
  assert.equal(ok.status, 201, ok.text);
  const bad = await upload('agent', `/cases/${ctrl.id}/photos`, {}, { name: 'scan.pdf', data: await textPdf({ title: 'Test', paragraphs: ['x'] }), type: 'application/pdf' });
  assert.equal(bad.status, 400);
  assert.equal((await upload('agent', `/cases/${ctrl.id}/photos`, { latitude: '99' }, { name: 'a.jpg', data: jpeg, type: 'image/jpeg' })).status, 400);
  const photo = await fetch(`${base}/cases/${ctrl.id}/photos/${ok.body.id}`, { headers: { cookie: `${COOKIE}=${tokens.agent}` } });
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), jpeg);
  assert.equal((await fetch(`${base}/cases/${ctrl.id}/photos/${ok.body.id}`, { headers: { cookie: `${COOKIE}=${tokens.strain}` } })).status, 404);
  const d = await must('agent', 'GET', `/cases/${ctrl.id}`);
  assert.equal(d.photos[0].latitude, 47.1622);
  assert.deepEqual(d.deadlines.map((x: any) => x.key), ['finalizare']);

  const pv = await must('agent', 'POST', '/cases', {
    kind: 'contraventie', parentId: ctrl.id, location: 'B-dul Stefan cel Mare 8',
    contravention: { pvSeries: 'PL', pvNumber: '77', offenderName: 'SC Construct SRL', fact: 'Lucrări fără autorizație', legalBasis: 'Legea 50/1991', sanction: 'avertisment' },
  });
  // Căutarea nu ține cont de diacritice și găsește și lucrarea din altă formulare a adresei.
  const h = await must('sef', 'GET', `/cases/history?location=${encodeURIComponent('stefan cel mare 8')}`);
  assert.deepEqual(h.cases.map((x: any) => x.id).sort(), [ctrl.id, pv.id].sort());
  assert.equal((await must('strain', 'GET', `/cases/history?location=${encodeURIComponent('stefan cel mare')}`)).cases.length, 0);
  assert.equal((await must('agent', 'GET', `/cases/${ctrl.id}`)).children[0].id, pv.id);
});

// Expediere --------------------------------------------------------------------------------

test('expedierea și dovada comunicării', async () => {
  const doc = await registerDoc();
  const x = await must('reg', 'POST', `/documents/${doc.id}/dispatches`, { method: 'posta_recomandata', recipient: 'Ion Ionescu', address: 'Str. A 1', tracking: 'RR123456789RO' });
  let list = await must('reg', 'GET', `/documents/${doc.id}/dispatches`);
  assert.equal(list[0].deliveredOn, null);
  const proofPdf = await textPdf({ title: 'Test', paragraphs: ['Confirmare de primire'] });
  const conf = await upload('reg', `/dispatches/${x.id}/delivered`, { deliveredOn: today() }, { name: 'confirmare.pdf', data: proofPdf, type: 'application/pdf' });
  assert.equal(conf.status, 200, conf.text);
  list = await must('reg', 'GET', `/documents/${doc.id}/dispatches`);
  assert.equal(list[0].deliveredOn, today());
  assert.equal(list[0].proofSha256, crypto.createHash('sha256').update(proofPdf).digest('hex'));
  const proof = await fetch(`${base}/dispatches/${x.id}/proof`, { headers: { cookie: `${COOKIE}=${tokens.reg}` } });
  assert.deepEqual(Buffer.from(await proof.arrayBuffer()), proofPdf);

  const p = await must('reg', 'POST', '/cases', { kind: 'petitie', subject: 'Test', applicantName: 'Ion', departmentId: dep1, documentId: doc.id });
  const other = await registerDoc();
  assert.equal((await api('reg', 'POST', `/cases/${p.id}/dispatches`, { method: 'email', recipient: 'ion@example.ro', documentId: other.id })).status, 400);
  await must('reg', 'POST', `/cases/${p.id}/dispatches`, { method: 'email', recipient: 'ion@example.ro', documentId: doc.id, isAnswer: true });
  const d = await must('reg', 'GET', `/cases/${p.id}`);
  assert.equal(d.answerCommunicatedOn, today());
  assert.equal(d.dispatches[0].deliveredOn, today(), 'emailul se consideră comunicat la trimitere');
});

// Termene, raport, panou -----------------------------------------------------------------

test('notificarea înaintea termenului și escaladarea la depășire, o singură dată', async () => {
  const soon = await must('reg', 'POST', '/cases', { kind: 'petitie', subject: 'Aproape', applicantName: 'A', departmentId: dep1, assigneeId: ids.agent, receivedOn: daysAgo(28) });
  const late = await must('reg', 'POST', '/cases', { kind: 'petitie', subject: 'Depășit', applicantName: 'B', departmentId: dep1, assigneeId: ids.agent2, receivedOn: daysAgo(31) });
  await db.query('DELETE FROM notifications');
  assert.deepEqual(await cases.checkDeadlines(), { reminded: 1, escalated: 1 });
  assert.deepEqual(await cases.checkDeadlines(), { reminded: 0, escalated: 0 });
  const n = (await db.query('SELECT user_id, kind, link FROM notifications ORDER BY id')).rows;
  assert.deepEqual(n.map((r: any) => [r.user_id, r.kind]), [[ids.agent, 'lucrare_termen'], [ids.agent2, 'lucrare_escaladare'], [ids.sef, 'lucrare_escaladare']]);
  assert.equal(n[0].link, `/lucrari/${soon.id}`);
  const ev = (await must('sef', 'GET', `/cases/${late.id}`)).events.map((e: any) => e.kind);
  assert.ok(ev.includes('escaladare'));
});

test('situația semestrială a petițiilor și panoul pe roluri', async () => {
  const year = Number(today().slice(0, 4));
  const semester = Number(today().slice(5, 7)) <= 6 ? 1 : 2;
  const a = await must('reg', 'POST', '/cases', { kind: 'petitie', subject: 'A', applicantName: 'A', departmentId: dep1, assigneeId: ids.agent, channel: 'email' });
  const b = await must('reg', 'POST', '/cases', { kind: 'petitie', subject: 'B', applicantName: 'B', departmentId: dep2, objects: ['x', 'y'] });
  await must('reg', 'POST', '/cases', { kind: 'petitie', subject: 'C', anonymous: true, departmentId: dep1 });
  await must('reg', 'POST', `/cases/${a.id}/extend`, { days: 10, reason: 'r' });
  await must('reg', 'POST', `/cases/${a.id}/close`, { outcome: 'favorabil', note: 'ok' });
  await must('reg', 'POST', `/cases/${b.id}/close`, { outcome: 'clasata', note: 'Repetată fără elemente noi' });
  assert.equal((await api('agent', 'GET', `/cases/reports/petitions?year=${year}&semester=${semester}`)).status, 403);
  const r = await must('admin', 'GET', `/cases/reports/petitions?year=${year}&semester=${semester}`);
  assert.equal(r.totals.total, 3);
  assert.equal(r.totals.inTerm, 2);
  assert.equal(r.totals.open, 1);
  assert.equal(r.totals.extended, 1);
  assert.equal(r.totals.anonymous, 1);
  assert.equal(r.totals.multipleObjects, 1);
  assert.deepEqual(r.byOutcome.map((o: any) => o.outcome).sort(), ['clasata', 'favorabil']);
  const csv = await api('admin', 'GET', `/cases/reports/petitions/csv?year=${year}&semester=${semester}`);
  assert.match(csv.text, /Petiții înregistrate";"3"/);

  await must('agent', 'POST', '/cases', { kind: 'control', subject: 'Control', location: 'Piața 1' });
  const director = await must('admin', 'GET', '/cases/dashboard');
  assert.equal(director.scope, 'institutie');
  assert.ok(director.breakdown.length >= 1);
  const sef = await must('sef', 'GET', '/cases/dashboard');
  assert.equal(sef.scope, 'serviciu');
  assert.ok(sef.breakdown.every((x: any) => typeof x.open === 'number'));
  const exec = await must('agent', 'GET', '/cases/dashboard');
  assert.equal(exec.scope, 'personal');
  assert.equal(exec.byKind.find((k: any) => k.kind === 'control').open, 1);

  // Conducerea: șeful compartimentului din care se subordonează altele vede și lucrările acelora.
  const d = await must('reg', 'POST', '/cases', { kind: 'petitie', subject: 'D', applicantName: 'D', departmentId: dep2 });
  assert.equal((await api('sef', 'GET', `/cases/${d.id}`)).status, 404);
  await db.query('UPDATE departments SET parent_id = $1 WHERE id = $2', [dep1, dep2]);
  try {
    assert.equal((await must('sef', 'GET', `/cases/${d.id}`)).subject, 'D');
    await must('sef', 'POST', `/cases/${d.id}/assign`, { assigneeId: ids.strain, note: 'Rezoluția directorului' });
    const leaders = await must('sef', 'GET', '/cases/dashboard');
    assert.equal(leaders.scope, 'institutie');
    assert.equal(leaders.byDepartment, true);
    assert.ok(leaders.breakdown.some((x: any) => x.label === 'Disciplina în construcții'));
    assert.equal((await api('sef2', 'GET', `/cases/${a.id}`)).status, 404, 'subordonatul nu vede în sus');
  } finally {
    await db.query('UPDATE departments SET parent_id = NULL WHERE id = $1', [dep2]);
  }
});

// Intranet și API ----------------------------------------------------------------------------

test('Intranet: șeful publică pentru compartiment, angajații primesc notificare și confirmă', async () => {
  assert.equal((await api('agent', 'POST', '/intranet', { title: 'x', body: 'y' })).status, 403);
  assert.equal((await api('sef', 'POST', '/intranet', { title: 'General', body: 'Pentru toți' })).status, 403);
  const p = await must('sef', 'POST', '/intranet', { kind: 'procedura', title: 'Procedura de patrulare', body: 'Pașii...', departmentId: dep1, requiresAck: true });
  assert.equal(p.notified, 4, 'admin, reg, agent, agent2');
  assert.equal((await must('strain', 'GET', '/intranet')).length, 0);
  const seen = await must('agent', 'GET', '/intranet');
  assert.equal(seen[0].title, 'Procedura de patrulare');
  await must('agent', 'POST', `/intranet/${p.id}/read`, { acknowledge: true });
  const acks = await must('sef', 'GET', `/intranet/${p.id}/acknowledgements`);
  assert.equal(acks[0].fullName, 'Nume agent');
  assert.ok(acks[0].acknowledgedAt);
  const general = await must('admin', 'POST', '/intranet', { title: 'Ședință', body: 'Luni la 9', pinned: true });
  assert.equal(general.notified, 6);
  assert.equal((await must('strain', 'GET', '/intranet')).length, 1);
  await must('admin', 'DELETE', `/intranet/${general.id}`);
  assert.equal((await must('strain', 'GET', '/intranet')).length, 0);
  // Conducerea, adică compartimentul care are subcompartimente, dă și anunțuri generale.
  await db.query('UPDATE departments SET parent_id = $1 WHERE id = $2', [dep1, dep2]);
  try {
    const fromLeaders = await must('sef', 'POST', '/intranet', { title: 'Program de sărbători', body: 'Ture de 12 ore' });
    assert.equal(fromLeaders.notified, 6);
    assert.equal((await api('sef2', 'POST', '/intranet', { title: 'General', body: 'x' })).status, 403);
    await must('sef', 'DELETE', `/intranet/${fromLeaders.id}`);
  } finally {
    await db.query('UPDATE departments SET parent_id = NULL WHERE id = $1', [dep2]);
  }
});

test('tokenurile de API: acces fără cookie, cu drepturile contului, până la revocare', async () => {
  assert.equal((await api('sef', 'POST', '/admin/api-tokens', { name: 'x', userId: ids.reg })).status, 403);
  const t = await must('admin', 'POST', '/admin/api-tokens', { name: 'Contabilitate', userId: ids.reg });
  assert.match(t.token, /^sd_/);
  assert.equal((await must('admin', 'GET', '/admin/api-tokens'))[0].prefix, t.token.slice(0, 10));
  const auth = { authorization: `Bearer ${t.token}` };
  const created = await api(null, 'POST', '/cases', { kind: 'petitie', subject: 'Din API', applicantName: 'Ion', departmentId: dep1 }, auth);
  assert.equal(created.status, 201, created.text);
  assert.equal((await api(null, 'GET', '/admin/api-tokens', undefined, auth)).status, 403, 'contul nu e administrator');
  assert.equal((await api(null, 'GET', '/cases', undefined, { authorization: 'Bearer sd_invalidinvalidinvalidinvalid' })).status, 401);
  await must('admin', 'DELETE', `/admin/api-tokens/${t.id}`);
  assert.equal((await api(null, 'GET', '/cases', undefined, auth)).status, 401);
});
