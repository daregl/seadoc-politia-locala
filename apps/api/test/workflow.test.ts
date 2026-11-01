import 'reflect-metadata';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { AuditService } from '../src/audit.js';
import { AuthService, COOKIE, hashPassword } from '../src/auth.js';
import { Db } from '../src/db.js';
import { DocumentsController, DocumentsService } from '../src/documents.js';
import { NotificationService } from '../src/notifications.js';
import { OcrService } from '../src/ocr.js';
import { StorageService } from '../src/storage.js';
import { checkStructure, parseBpmn, stepOutcome, WorkflowEngine } from '../src/workflow-engine.js';
import { DashboardController, DocumentWorkflowController, TasksController, WorkflowsController } from '../src/workflows.js';

@Module({
  controllers: [WorkflowsController, TasksController, DashboardController, DocumentWorkflowController, DocumentsController],
  providers: [Db, AuditService, NotificationService, StorageService, OcrService, DocumentsService, AuthService, WorkflowEngine],
})
class TestModule {}

const PASSWORD = 'Parola-Test-123!';
const PASSWORD_HASH = hashPassword(PASSWORD);

let app: INestApplication;
let db: Db;
let engine: WorkflowEngine;
let base: string;

type Name = 'admin' | 'manager' | 'manager2' | 'alice' | 'bob' | 'carol' | 'dave' | 'reg';
const ids = {} as Record<Name, number>;
const tokens = {} as Record<Name, string>;
let dep1: number;
let dep2: number;
let typeId: number;

before(async () => {
  app = await NestFactory.create(TestModule, { logger: false });
  app.use(cookieParser());
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  db = app.get(Db);
  engine = app.get(WorkflowEngine);
  await db.migrate();
});

after(async () => {
  await app.close();
});

/** Rândurile din audit rămân: identificatorii de document nu se refolosesc, deci nu se amestecă între teste. */
beforeEach(async () => {
  await db.query(`TRUNCATE notifications, tasks, workflow_join_tokens, workflow_steps, workflow_instances, workflow_definitions,
    signatures, duplicate_matches, document_links, document_access, favorites, access_grants, elimination_proposals,
    document_versions, documents, registers, register_counters, folders, document_types, sessions, user_permissions, users, departments CASCADE`);
  dep1 = (await db.one(`INSERT INTO departments (name) VALUES ('Juridic') RETURNING id`))!.id;
  dep2 = (await db.one(`INSERT INTO departments (name) VALUES ('Financiar') RETURNING id`))!.id;
  typeId = (await db.one(`INSERT INTO document_types (name, nomenclator_code) VALUES ('Contract', 'C1') RETURNING id`))!.id;
  const people: [Name, string, number, string | null][] = [
    ['admin', 'admin', dep1, null],
    ['manager', 'manager', dep1, 'Șef serviciu'],
    ['manager2', 'manager', dep2, 'Șef financiar'],
    ['alice', 'user', dep1, 'Jurist'],
    ['bob', 'user', dep1, 'Jurist'],
    ['carol', 'user', dep1, 'Contabil'],
    ['dave', 'user', dep2, 'Director'],
    ['reg', 'registratura', dep1, null],
  ];
  for (const [name, role, department, jobTitle] of people) {
    ids[name] = (await db.one(
      `INSERT INTO users (username, full_name, password_hash, role, department_id, job_title) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [name, `Nume ${name}`, PASSWORD_HASH, role, department, jobTitle]))!.id;
    tokens[name] = crypto.randomBytes(16).toString('hex');
    await db.query(`INSERT INTO sessions (token_hash, user_id, mfa_ok, expires_at) VALUES ($1,$2,true, now() + interval '1 hour')`,
      [crypto.createHash('sha256').update(tokens[name]).digest('hex'), ids[name]]);
  }
  await db.query('UPDATE departments SET manager_id = $1 WHERE id = $2', [ids.manager, dep1]);
  await db.query('UPDATE departments SET manager_id = $1 WHERE id = $2', [ids.manager2, dep2]);
});

async function api(as: Name | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(as ? { cookie: `${COOKIE}=${tokens[as]}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function must(as: Name, method: string, path: string, body?: unknown) {
  const res = await api(as, method, path, body);
  assert.ok(res.status < 300, `${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

// --- XML ---------------------------------------------------------------------

const wrap = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:seadoc="http://seadoc.ro/schema/bpmn" id="Defs" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Proc" isExecutable="false">${body}</bpmn:process>
  <bpmndi:BPMNDiagram id="Diagram"><bpmndi:BPMNPlane id="Plane" bpmnElement="Proc"/></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
const startEv = (id = 'Start') => `<bpmn:startEvent id="${id}"/>`;
const endEv = (id = 'End') => `<bpmn:endEvent id="${id}"/>`;
const par = (id: string) => `<bpmn:parallelGateway id="${id}"/>`;
const xor = (id: string, def?: string) => `<bpmn:exclusiveGateway id="${id}"${def ? ` default="${def}"` : ''}/>`;
const flow = (from: string, to: string, condition?: string, id = `F_${from}_${to}`) =>
  `<bpmn:sequenceFlow id="${id}" sourceRef="${from}" targetRef="${to}"${condition ? ` seadoc:condition="${condition}"` : ''}/>`;
function task(id: string, attrs: { type?: string; assignee?: string; action?: string; completion?: string; due?: string; name?: string } = {}) {
  const a = [
    `seadoc:assigneeType="${attrs.type ?? 'utilizator'}"`,
    attrs.assignee === undefined ? '' : `seadoc:assignee="${attrs.assignee}"`,
    attrs.action ? `seadoc:action="${attrs.action}"` : '',
    attrs.completion ? `seadoc:completion="${attrs.completion}"` : '',
    attrs.due ? `seadoc:dueHours="${attrs.due}"` : '',
  ].join(' ');
  return `<bpmn:userTask id="${id}" name="${attrs.name ?? `Pas ${id}`}" ${a}><bpmn:incoming>x</bpmn:incoming></bpmn:userTask>`;
}
const single = (attrs: Parameters<typeof task>[1]) => wrap(startEv() + task('T', attrs) + endEv() + flow('Start', 'T') + flow('T', 'End'));

// --- ajutoare --------------------------------------------------------------------

async function publish(key: string, xml: string, as: Name = 'admin', extra: Record<string, unknown> = {}) {
  return must(as, 'POST', '/workflows', { key, name: `Flux ${key}`, xml, ...extra });
}

async function newDoc(opts: { owner?: Name; metadata?: Record<string, string>; department?: number; status?: string } = {}) {
  const id = (await db.one(
    `INSERT INTO documents (title, document_type_id, department_id, owner_id, metadata, status) VALUES ('Contract test',$1,$2,$3,$4,$5) RETURNING id`,
    [typeId, opts.department ?? dep1, ids[opts.owner ?? 'reg'], JSON.stringify(opts.metadata ?? {}), opts.status ?? 'inregistrat']))!.id as number;
  await db.query(`INSERT INTO document_versions (document_id, version_no, filename, mime, size_bytes, sha256, created_by)
    SELECT $1, 1, 'a.pdf', 'application/pdf', 1, 'abc', $2 WHERE (SELECT status FROM documents WHERE id = $1) NOT IN ('arhivat','eliminat')`, [id, ids.reg]);
  return id;
}

async function startOn(key: string, opts: Parameters<typeof newDoc>[0] = {}, as: Name = 'reg') {
  const documentId = await newDoc(opts);
  const { instanceId } = await must(as, 'POST', `/workflows/${key}/start`, { documentId });
  return { documentId, instanceId: instanceId as number };
}

async function openTasks(user: Name, documentId?: number) {
  const list = await must(user, 'GET', '/tasks');
  return documentId == null ? list : list.filter((t: any) => t.documentId === documentId);
}
async function theTask(user: Name, documentId: number, name?: string) {
  const list = (await openTasks(user, documentId)).filter((t: any) => t.status === 'deschisa' && (!name || t.name === name));
  assert.equal(list.length, 1, `${user} ar trebui să aibă o singură sarcină deschisă, are ${list.length}`);
  return list[0];
}
const act = (user: Name, taskId: number, body: Record<string, unknown>) => api(user, 'POST', `/tasks/${taskId}/action`, body);
async function approve(user: Name, documentId: number, name?: string) {
  const t = await theTask(user, documentId, name);
  const res = await act(user, t.id, { action: 'approve' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}
async function reject(user: Name, documentId: number) {
  const t = await theTask(user, documentId);
  const res = await act(user, t.id, { action: 'reject', comment: 'Nu este în regulă' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}
const docStatus = async (id: number) => (await db.one('SELECT status FROM documents WHERE id = $1', [id]))!.status;
const instStatus = async (id: number) => (await db.one('SELECT status FROM workflow_instances WHERE id = $1', [id]))!.status;
const auditActions = async (documentId: number) => (await db.query('SELECT action FROM audit_log WHERE document_id = $1 ORDER BY seq', [documentId])).rows.map((r) => r.action);
const notifications = async (user: Name, kind: string, documentId: number) =>
  (await db.one('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = $2 AND document_id = $3', [ids[user], kind, documentId]))!.n as number;
const taskRows = async (instanceId: number) => (await db.query('SELECT * FROM tasks WHERE instance_id = $1 ORDER BY id', [instanceId])).rows;

const parallelXml = wrap(startEv() + par('Split') + task('A', { assignee: 'alice' }) + task('B', { assignee: 'bob' }) + par('Join') + task('Final', { assignee: 'carol' }) + endEv()
  + flow('Start', 'Split') + flow('Split', 'A') + flow('Split', 'B') + flow('A', 'Join') + flow('B', 'Join') + flow('Join', 'Final') + flow('Final', 'End'));

// --- parcurs de bază -------------------------------------------------------------

test('paralel: ramurile se unesc, apoi aprobatorul final încheie fluxul', async () => {
  await publish('par', parallelXml);
  const { documentId, instanceId } = await startOn('par');
  assert.equal(await docStatus(documentId), 'in_flux');
  assert.equal((await openTasks('carol', documentId)).length, 0);

  await approve('alice', documentId);
  assert.equal((await openTasks('carol', documentId)).length, 0, 'unirea trebuie să aștepte a doua ramură');
  const waiting = await db.one(`SELECT status FROM workflow_steps WHERE instance_id = $1 AND element_id = 'Join'`, [instanceId]);
  assert.equal(waiting!.status, 'activ');

  await approve('bob', documentId);
  assert.equal(await instStatus(instanceId), 'activ');
  await approve('carol', documentId);

  assert.equal(await instStatus(instanceId), 'aprobat');
  assert.equal(await docStatus(documentId), 'aprobat');
  assert.equal(await notifications('reg', 'document_aprobat', documentId), 1);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM workflow_join_tokens WHERE instance_id = $1', [instanceId]))!.n, 0);

  const { instances } = await must('reg', 'GET', `/documents/${documentId}/workflow`);
  const steps = instances[0].steps;
  assert.deepEqual(steps.map((s: any) => s.elementId), ['Start', 'Split', 'A', 'B', 'Join', 'Final', 'End']);
  assert.ok(steps.every((s: any) => s.status === 'finalizat'));
  assert.deepEqual([...new Set(steps.map((s: any) => s.elementType))].sort(), ['endEvent', 'parallelGateway', 'startEvent', 'userTask']);
  const actions = await auditActions(documentId);
  for (const a of ['flux.pornit', 'sarcina.aprobata', 'flux.aprobat']) assert.ok(actions.includes(a), a);
  assert.equal(instances[0].status, 'aprobat');
  assert.ok(instances[0].xml.includes('Split'));
  assert.equal(instances[0].tasks.length, 3);
});

test('un document fără vizibilitate nu își arată fluxul; titularul primește acces', async () => {
  await publish('acces', single({ assignee: 'alice' }));
  const documentId = await newDoc();
  assert.equal((await api('alice', 'GET', `/documents/${documentId}/workflow`)).status, 404);
  await must('reg', 'POST', '/workflows/acces/start', { documentId });
  assert.equal((await api('alice', 'GET', `/documents/${documentId}/workflow`)).status, 200);
  assert.equal((await api('bob', 'GET', `/documents/${documentId}/workflow`)).status, 404);
  assert.equal((await api('bob', 'POST', '/workflows/acces/start', { documentId })).status, 404);
});

test('regula de finalizare, ca funcție', () => {
  assert.equal(stepOutcome('all', 3, 3, 0), 'aprobat');
  assert.equal(stepOutcome('all', 3, 2, 0), null);
  assert.equal(stepOutcome('all', 3, 2, 1), 'respins');
  assert.equal(stepOutcome('any', 3, 1, 2), 'aprobat');
  assert.equal(stepOutcome('any', 3, 0, 2), null);
  assert.equal(stepOutcome('any', 3, 0, 3), 'respins');
  assert.equal(stepOutcome('majority', 4, 3, 0), 'aprobat');
  assert.equal(stepOutcome('majority', 4, 2, 2), 'respins');
  assert.equal(stepOutcome('majority', 4, 2, 1), null);
  assert.equal(stepOutcome('majority', 3, 2, 0), 'aprobat');
  assert.equal(stepOutcome('majority', 3, 1, 1), null);
  assert.equal(stepOutcome('majority', 3, 1, 2), 'respins');
});

const trio = (completion: string) => single({ assignee: 'alice,bob,carol', completion });

test('completion all: trece doar cu toate aprobările', async () => {
  await publish('all', trio('all'));
  const { documentId, instanceId } = await startOn('all');
  await approve('alice', documentId);
  await approve('bob', documentId);
  assert.equal(await instStatus(instanceId), 'activ');
  await approve('carol', documentId);
  assert.equal(await instStatus(instanceId), 'aprobat');
});

test('completion all: prima respingere încheie fluxul și anulează restul', async () => {
  await publish('all', trio('all'));
  const { documentId, instanceId } = await startOn('all');
  await approve('alice', documentId);
  await reject('bob', documentId);
  assert.equal(await instStatus(instanceId), 'respins');
  assert.equal(await docStatus(documentId), 'respins');
  const statuses = (await taskRows(instanceId)).map((t) => t.status);
  assert.deepEqual(statuses, ['finalizata', 'respinsa', 'anulata']);
  assert.equal(await notifications('reg', 'document_respins', documentId), 1);
  const actions = await auditActions(documentId);
  assert.ok(actions.includes('sarcina.respinsa') && actions.includes('flux.respins'));
});

test('completion any: prima aprobare trece, respingerile trebuie să fie unanime', async () => {
  await publish('any', trio('any'));
  const a = await startOn('any');
  await approve('bob', a.documentId);
  assert.equal(await instStatus(a.instanceId), 'aprobat');
  assert.deepEqual((await taskRows(a.instanceId)).map((t) => t.status), ['anulata', 'finalizata', 'anulata']);

  const b = await startOn('any');
  await reject('alice', b.documentId);
  await reject('bob', b.documentId);
  assert.equal(await instStatus(b.instanceId), 'activ');
  await reject('carol', b.documentId);
  assert.equal(await instStatus(b.instanceId), 'respins');

  const c = await startOn('any');
  await reject('alice', c.documentId);
  await approve('carol', c.documentId);
  assert.equal(await instStatus(c.instanceId), 'aprobat');
});

test('completion majority: 2 din 3 aprobă sau resping', async () => {
  await publish('maj', trio('majority'));
  const a = await startOn('maj');
  await approve('alice', a.documentId);
  assert.equal(await instStatus(a.instanceId), 'activ');
  await reject('bob', a.documentId);
  assert.equal(await instStatus(a.instanceId), 'activ');
  await approve('carol', a.documentId);
  assert.equal(await instStatus(a.instanceId), 'aprobat');

  const b = await startOn('maj');
  await reject('alice', b.documentId);
  await reject('bob', b.documentId);
  assert.equal(await instStatus(b.instanceId), 'respins');
  assert.equal((await taskRows(b.instanceId))[2].status, 'anulata');
});

test('respingerea anulează ramura paralelă și tokenii', async () => {
  await publish('par', parallelXml);
  const { documentId, instanceId } = await startOn('par');
  await approve('alice', documentId); // token în așteptare la unire
  await reject('bob', documentId);
  assert.equal(await instStatus(instanceId), 'respins');
  assert.equal((await db.one('SELECT count(*)::int AS n FROM workflow_join_tokens WHERE instance_id = $1', [instanceId]))!.n, 0);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM workflow_steps WHERE instance_id = $1 AND status = 'activ'`, [instanceId]))!.n, 0);
  assert.equal((await openTasks('carol', documentId)).length, 0);

  const second = await startOn('par');
  await reject('alice', second.documentId);
  const rows = await taskRows(second.instanceId);
  assert.deepEqual(rows.map((t) => t.status), ['respinsa', 'anulata']);
  assert.equal((await act('bob', rows[1].id, { action: 'approve' })).status, 409);
});

// --- redirect și completare ---------------------------------------------------------

test('redirecționare: sarcina trece la altcineva, iar N rămâne același', async () => {
  await publish('red', single({ assignee: 'alice,bob', completion: 'all' }));
  const { documentId, instanceId } = await startOn('red');
  const t = await theTask('alice', documentId);
  assert.equal((await act('alice', t.id, { action: 'redirect' })).status, 400);
  assert.equal((await act('alice', t.id, { action: 'redirect', targetUserId: ids.reg })).status, 400, 'fără drept de aprobare');
  assert.equal((await act('alice', t.id, { action: 'redirect', targetUserId: ids.bob })).status, 409, 'are deja o sarcină pe pas');
  assert.equal((await act('alice', t.id, { action: 'redirect', targetUserId: ids.dave })).status, 200);

  assert.equal((await openTasks('alice', documentId)).length, 0);
  assert.equal((await act('alice', t.id, { action: 'approve' })).status, 409);
  assert.equal((await api('dave', 'GET', `/documents/${documentId}/workflow`)).status, 200);
  assert.equal(await notifications('dave', 'sarcina_noua', documentId), 1);
  const moved = (await taskRows(instanceId)).find((r) => r.assignee_id === ids.dave)!;
  assert.equal(moved.redirected_from, ids.alice);
  assert.equal(moved.kind, 'avizare');

  await approve('bob', documentId);
  assert.equal(await instStatus(instanceId), 'activ', 'sarcina redirecționată nu contează, cea nouă da');
  await approve('dave', documentId);
  assert.equal(await instStatus(instanceId), 'aprobat');
  assert.ok((await auditActions(documentId)).includes('sarcina.redirectionata'));
});

test('completare: inițiatorul răspunde, sarcina revine și nu contează ca vot', async () => {
  await publish('info', single({ assignee: 'alice,bob', completion: 'all', action: 'aprobare' }));
  const { documentId, instanceId } = await startOn('info');
  const t = await theTask('alice', documentId);
  assert.equal((await act('alice', t.id, { action: 'request_info' })).status, 400, 'comentariul este obligatoriu');
  assert.equal((await act('alice', t.id, { action: 'request_info', comment: 'Lipsește anexa' })).status, 200);
  assert.equal((await openTasks('alice', documentId))[0].status, 'asteapta_completare');
  assert.equal((await act('alice', t.id, { action: 'approve' })).status, 409, 'cât timp așteaptă nu se poate aproba');

  const child = await theTask('reg', documentId);
  assert.equal(child.kind, 'completare');
  assert.equal(child.comment, 'Lipsește anexa');
  assert.equal(await notifications('reg', 'completare_ceruta', documentId), 1);
  assert.equal((await act('reg', child.id, { action: 'reject', comment: 'Nu' })).status, 400);
  assert.equal((await act('reg', child.id, { action: 'request_info', comment: 'Nu' })).status, 400);
  // Registratura nu are dreptul `approve`, dar completarea nu îl cere.
  assert.equal((await act('reg', child.id, { action: 'approve', comment: 'Am atașat anexa' })).status, 200);
  assert.equal(await notifications('alice', 'completare_finalizata', documentId), 1);
  assert.equal(await instStatus(instanceId), 'activ');

  const back = await theTask('alice', documentId);
  assert.equal(back.id, t.id);
  await approve('alice', documentId);
  assert.equal(await instStatus(instanceId), 'activ', 'completarea finalizată nu este o aprobare');
  await approve('bob', documentId);
  assert.equal(await instStatus(instanceId), 'aprobat');
  const actions = await auditActions(documentId);
  assert.ok(actions.includes('sarcina.completare_ceruta') && actions.includes('sarcina.completare_finalizata'));
});

test('rezolvarea pasului anulează și completarea aflată în lucru', async () => {
  await publish('info2', single({ assignee: 'alice,bob' }));
  const { documentId, instanceId } = await startOn('info2');
  const t = await theTask('alice', documentId);
  await must('alice', 'POST', `/tasks/${t.id}/action`, { action: 'request_info', comment: 'Lipsește anexa' });
  await approve('bob', documentId);
  assert.equal(await instStatus(instanceId), 'aprobat');
  assert.ok((await taskRows(instanceId)).every((r) => r.status !== 'deschisa' && r.status !== 'asteapta_completare'));
});

// --- atribuire ------------------------------------------------------------------------

test('înlocuitorul activ primește sarcina; cel expirat nu', async () => {
  await publish('sub', single({ type: 'functie', assignee: 'Jurist', completion: 'all' }));
  // „Azi” este data din România, indiferent de fusul orar al serverului.
  const today = `(now() AT TIME ZONE 'Europe/Bucharest')::date`;
  await db.query(`UPDATE users SET substitute_id = $1, substitute_until = ${today} + 1 WHERE id = $2`, [ids.dave, ids.alice]);
  await db.query(`UPDATE users SET substitute_id = $1, substitute_until = ${today} - 1 WHERE id = $2`, [ids.carol, ids.bob]);
  const { documentId, instanceId } = await startOn('sub');
  const rows = await taskRows(instanceId);
  assert.deepEqual(rows.map((r) => r.assignee_id).sort(), [ids.bob, ids.dave].sort());
  assert.equal(rows.find((r) => r.assignee_id === ids.dave)!.redirected_from, ids.alice);
  assert.equal((await openTasks('alice', documentId)).length, 0);
  assert.equal((await openTasks('carol', documentId)).length, 0);
  assert.equal((await api('dave', 'GET', `/documents/${documentId}/workflow`)).status, 200);

  // Doi titulari cu același înlocuitor: o singură sarcină. Ultima zi de înlocuire este inclusă.
  await db.query(`UPDATE users SET substitute_id = $1, substitute_until = ${today} WHERE id = $2`, [ids.dave, ids.bob]);
  const second = await startOn('sub');
  assert.deepEqual((await taskRows(second.instanceId)).map((r) => r.assignee_id), [ids.dave]);
});

test('fără titular: managerul departamentului, apoi un administrator, cu urmă în audit', async () => {
  await publish('fb', single({ type: 'functie', assignee: 'Contabil' }));
  await db.query('UPDATE users SET job_title = NULL WHERE id = $1', [ids.carol]);
  const a = await startOn('fb');
  assert.deepEqual((await taskRows(a.instanceId)).map((r) => r.assignee_id), [ids.manager]);
  assert.ok((await auditActions(a.documentId)).includes('flux.titular_lipsa'));

  await db.query('UPDATE departments SET manager_id = NULL WHERE id = $1', [dep1]);
  const b = await startOn('fb');
  assert.deepEqual((await taskRows(b.instanceId)).map((r) => r.assignee_id), [ids.admin]);
  assert.ok((await auditActions(b.documentId)).includes('flux.titular_lipsa'));
});

test('tipurile de titular: funcție, rol, manager de departament, inițiator', async () => {
  const assigneesFor = async (key: string, attrs: Parameters<typeof task>[1], owner: Name = 'reg', as: Name = 'reg') => {
    await publish(key, single(attrs));
    const { instanceId } = await startOn(key, { owner }, as);
    return (await taskRows(instanceId)).map((r) => r.assignee_id);
  };
  assert.deepEqual(await assigneesFor('t1', { type: 'functie', assignee: 'Jurist, Contabil' }), [ids.alice, ids.bob, ids.carol]);
  assert.deepEqual(await assigneesFor('t2', { type: 'rol', assignee: 'admin' }), [ids.admin]);
  assert.deepEqual(await assigneesFor('t3', { type: 'manager_departament' }), [ids.manager]);
  assert.deepEqual(await assigneesFor('t4', { type: 'initiator' }, 'alice', 'alice'), [ids.alice]);
  // Registratura nu poate rezolva o sarcină de avizare, deci ajunge la manager.
  assert.deepEqual(await assigneesFor('t5', { type: 'initiator' }), [ids.manager]);
});

// --- semnare ---------------------------------------------------------------------------

test('semnare: parolă greșită nu schimbă nimic, cea corectă semnează și avansează', async () => {
  await publish('sign', single({ assignee: 'alice', action: 'semnare' }));
  const { documentId, instanceId } = await startOn('sign');
  const t = await theTask('alice', documentId);
  assert.equal(t.kind, 'semnare');
  assert.equal((await act('alice', t.id, { action: 'approve' })).status, 400);
  assert.equal((await act('alice', t.id, { action: 'sign' })).status, 400);

  assert.equal((await act('alice', t.id, { action: 'sign', password: 'gresita' })).status, 401);
  assert.equal(await instStatus(instanceId), 'activ');
  assert.equal((await taskRows(instanceId))[0].status, 'deschisa');
  assert.equal((await db.one('SELECT count(*)::int AS n FROM signatures WHERE document_id = $1', [documentId]))!.n, 0);
  assert.ok((await auditActions(documentId)).every((a) => a !== 'document.semnatura_interna' && a !== 'sarcina.aprobata'));

  assert.equal((await act('bob', t.id, { action: 'sign', password: PASSWORD })).status, 403);
  assert.equal((await act('alice', t.id, { action: 'sign', password: PASSWORD })).status, 200);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM signatures WHERE document_id = $1 AND signer_id = $2', [documentId, ids.alice]))!.n, 1);
  assert.equal(await instStatus(instanceId), 'aprobat');
  assert.equal(await docStatus(documentId), 'aprobat');
});

test('semnare: parole greșite repetate blochează contul, chiar și pentru parola corectă', async () => {
  await publish('sign-lock', single({ assignee: 'alice', action: 'semnare' }));
  const { documentId, instanceId } = await startOn('sign-lock');
  const t = await theTask('alice', documentId);
  try {
    for (let i = 0; i < 5; i++) assert.equal((await act('alice', t.id, { action: 'sign', password: 'gresita' })).status, 401);
    assert.equal((await act('alice', t.id, { action: 'sign', password: PASSWORD })).status, 423);
    assert.equal(await instStatus(instanceId), 'activ');
  } finally {
    await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [ids.alice]);
  }
});

async function uploadVersion(as: Name, documentId: number) {
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), 'v.pdf');
  const res = await fetch(`${base}/documents/${documentId}/versions`, { method: 'POST', headers: { cookie: `${COOKIE}=${tokens[as]}` }, body: form });
  return res.status;
}

test('versiuni: accesul de citire nu permite înlocuirea fișierului', async () => {
  const documentId = await newDoc();
  await db.query('INSERT INTO document_access VALUES ($1, $2)', [documentId, ids.alice]);
  assert.equal(await uploadVersion('alice', documentId), 403);
  assert.equal(await uploadVersion('reg', documentId), 201);
});

test('versiuni: în timpul fluxului, doar titularul unei cereri de completare încarcă', async () => {
  await publish('ver-flow', single({ assignee: 'alice,bob', completion: 'all' }));
  const { documentId } = await startOn('ver-flow', {}, 'admin');
  assert.equal(await uploadVersion('admin', documentId), 403);
  assert.equal(await uploadVersion('reg', documentId), 403);
  const t = await theTask('alice', documentId);
  assert.equal((await act('alice', t.id, { action: 'request_info', comment: 'Lipsește anexa' })).status, 200);
  assert.equal(await uploadVersion('admin', documentId), 201);
  assert.equal(await uploadVersion('reg', documentId), 403);
});

test('semnătura nu se poate folosi pe o sarcină care nu este de semnare', async () => {
  await publish('nosign', single({ assignee: 'alice' }));
  const { documentId } = await startOn('nosign');
  const t = await theTask('alice', documentId);
  assert.equal((await act('alice', t.id, { action: 'sign', password: PASSWORD })).status, 400);
  assert.equal((await act('alice', t.id, { action: 'nimic' })).status, 400);
  assert.equal((await act('alice', t.id, { action: 'reject' })).status, 400, 'respingerea cere motiv');
});

// --- concurență --------------------------------------------------------------------------

test('aprobări simultane pe ambele ramuri: unirea avansează exact o dată', async () => {
  await publish('par', parallelXml);
  for (let i = 0; i < 6; i++) {
    const { documentId, instanceId } = await startOn('par');
    const [a, b] = [await theTask('alice', documentId), await theTask('bob', documentId)];
    const results = await Promise.all([act('alice', a.id, { action: 'approve' }), act('bob', b.id, { action: 'approve' })]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    const joins = await db.query(`SELECT status FROM workflow_steps WHERE instance_id = $1 AND element_id = 'Join'`, [instanceId]);
    assert.deepEqual(joins.rows.map((r) => r.status), ['finalizat']);
    assert.equal((await db.one('SELECT count(*)::int AS n FROM workflow_join_tokens WHERE instance_id = $1', [instanceId]))!.n, 0);
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM workflow_steps WHERE instance_id = $1 AND element_id = 'Final'`, [instanceId]))!.n, 1);
    assert.equal((await openTasks('carol', documentId)).length, 1);
  }
});

test('două aprobări simultane pe „any”: prima câștigă, a doua primește 409', async () => {
  await publish('any', single({ assignee: 'alice,bob' }));
  const { documentId, instanceId } = await startOn('any');
  const [a, b] = [await theTask('alice', documentId), await theTask('bob', documentId)];
  const results = await Promise.all([act('alice', a.id, { action: 'approve' }), act('bob', b.id, { action: 'approve' })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(await instStatus(instanceId), 'aprobat');
  assert.equal((await auditActions(documentId)).filter((x) => x === 'flux.aprobat').length, 1);
});

test('același titular trimite aprobarea de două ori simultan', async () => {
  await publish('dbl', single({ assignee: 'alice' }));
  const { documentId } = await startOn('dbl');
  const t = await theTask('alice', documentId);
  const results = await Promise.all([act('alice', t.id, { action: 'approve' }), act('alice', t.id, { action: 'approve' })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
});

test('un singur flux activ pe document, chiar la pornire simultană', async () => {
  await publish('one', single({ assignee: 'alice' }));
  const documentId = await newDoc();
  const results = await Promise.all([1, 2, 3].map(() => api('reg', 'POST', '/workflows/one/start', { documentId })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
  // După încheiere documentul poate intra din nou în flux.
  await approve('alice', documentId);
  assert.equal((await api('reg', 'POST', '/workflows/one/start', { documentId })).status, 201);
  assert.equal(await docStatus(documentId), 'in_flux');
});

test('pornire: document arhivat 409, fără drept 403, flux inexistent 404', async () => {
  await publish('st', single({ assignee: 'alice' }));
  const archived = await newDoc({ status: 'arhivat' });
  assert.equal((await api('reg', 'POST', '/workflows/st/start', { documentId: archived })).status, 409);
  assert.equal(await docStatus(archived), 'arhivat');
  assert.equal((await api('reg', 'POST', '/workflows/absent/start', { documentId: await newDoc() })).status, 404);
  // Vede documentul prin acces direct, dar nu este proprietar și nu are `register`.
  const documentId = await newDoc();
  await db.query('INSERT INTO document_access VALUES ($1,$2)', [documentId, ids.carol]);
  assert.equal((await api('carol', 'POST', '/workflows/st/start', { documentId })).status, 403);
  const own = await newDoc({ owner: 'carol' });
  assert.equal((await api('carol', 'POST', '/workflows/st/start', { documentId: own })).status, 201);
});

// --- termene --------------------------------------------------------------------------------

test('termene: reamintirea și escaladarea se trimit o singură dată', async () => {
  await publish('due', single({ assignee: 'alice', due: '10' }));
  await publish('far', single({ assignee: 'alice', due: '100' }));
  const { documentId, instanceId } = await startOn('due');
  const far = await startOn('far');
  const [dueTask] = await taskRows(instanceId);
  assert.ok(dueTask.due_at);

  const first = await engine.checkDeadlines();
  assert.equal(first.reminded, 1);
  await Promise.all([engine.checkDeadlines(), engine.checkDeadlines()]);
  assert.equal(await notifications('alice', 'termen_apropiat', documentId), 1);
  assert.equal(await notifications('alice', 'termen_apropiat', far.documentId), 0, 'termenul îndepărtat nu se reamintește');
  assert.equal(await notifications('alice', 'termen_depasit', documentId), 0);

  await db.query(`UPDATE tasks SET due_at = now() - interval '1 hour' WHERE id = $1`, [dueTask.id]);
  await Promise.all([engine.checkDeadlines(), engine.checkDeadlines()]);
  await engine.checkDeadlines();
  assert.equal(await notifications('alice', 'termen_depasit', documentId), 1);
  assert.equal(await notifications('manager', 'termen_depasit', documentId), 1);
  assert.equal(await notifications('alice', 'termen_apropiat', documentId), 1);
  assert.equal((await auditActions(documentId)).filter((a) => a === 'flux.termen_depasit').length, 1);
  assert.equal((await theTask('alice', documentId)).overdue, true);

  const row = (await taskRows(instanceId))[0];
  assert.ok(row.reminded_at && row.escalated_at);
});

test('termene: managerul titular nu primește de două ori; sarcina închisă nu mai escaladează', async () => {
  await publish('m', single({ type: 'manager_departament', due: '1' }));
  const { documentId, instanceId } = await startOn('m');
  await db.query(`UPDATE tasks SET due_at = now() - interval '1 hour' WHERE instance_id = $1`, [instanceId]);
  await engine.checkDeadlines();
  assert.equal(await notifications('manager', 'termen_depasit', documentId), 1);

  await publish('c', single({ assignee: 'alice', due: '1' }));
  const closed = await startOn('c');
  await approve('alice', closed.documentId);
  await db.query(`UPDATE tasks SET due_at = now() - interval '1 hour' WHERE instance_id = $1`, [closed.instanceId]);
  await engine.checkDeadlines();
  assert.equal(await notifications('alice', 'termen_depasit', closed.documentId), 0);
});

test('programatorul pornește o singură dată și se oprește', () => {
  engine.startScheduler();
  engine.startScheduler();
  engine.stopScheduler();
  engine.stopScheduler();
  engine.onApplicationShutdown();
});

// --- versiuni și publicare -----------------------------------------------------------------

test('o versiune nouă nu afectează instanța în curs', async () => {
  const v1 = await publish('ver', single({ assignee: 'alice' }));
  assert.equal(v1.version, 1);
  const running = await startOn('ver');
  const v2 = await publish('ver', single({ assignee: 'bob', name: 'Pas nou' }));
  assert.equal(v2.version, 2);
  assert.equal(v2.key, 'ver');

  assert.equal((await openTasks('bob', running.documentId)).length, 0);
  await approve('alice', running.documentId);
  assert.equal(await instStatus(running.instanceId), 'aprobat');

  const fresh = await startOn('ver');
  assert.equal((await openTasks('alice', fresh.documentId)).length, 0);
  assert.equal((await theTask('bob', fresh.documentId)).name, 'Pas nou');
  const seen = await must('admin', 'GET', `/documents/${running.documentId}/workflow`);
  assert.equal(seen.instances[0].version, 1);
  assert.ok(seen.instances[0].xml.includes('alice'));

  const versions = await must('reg', 'GET', '/workflows/ver/versions');
  assert.deepEqual(versions.map((v: any) => v.version), [2, 1]);
  assert.equal(versions[0].createdBy, 'Nume admin');
  const list = await must('reg', 'GET', '/workflows');
  assert.deepEqual(list.map((d: any) => [d.key, d.version]), [['ver', 2]]);
  assert.equal(list[0].canEdit, false);
  const detail = await must('reg', 'GET', '/workflows/ver');
  assert.equal(detail.version, 2);
  assert.ok(detail.xml.includes('bob'));
  assert.equal((await api('reg', 'GET', '/workflows/absent')).status, 404);
});

test('publicare simultană: versiunile rămân unice, cererea pierdută primește 409', async () => {
  await publish('race', single({ assignee: 'alice' }));
  const results = await Promise.all([1, 2, 3].map(() => api('admin', 'POST', '/workflows', { key: 'race', name: 'Curse', xml: single({ assignee: 'alice' }) })));
  for (const r of results) assert.ok(r.status === 201 || r.status === 409, String(r.status));
  assert.ok(results.some((r) => r.status === 201));
  const versions = (await db.query(`SELECT version FROM workflow_definitions WHERE key = 'race' ORDER BY version`)).rows.map((r) => r.version);
  assert.equal(versions.length, 1 + results.filter((r) => r.status === 201).length);
  assert.deepEqual(versions, versions.map((_, i) => i + 1));
});

test('publicare: drepturi pe departament, cheie, audit', async () => {
  const xml = single({ assignee: 'alice' });
  const post = (as: Name, body: Record<string, unknown>) => api(as, 'POST', '/workflows', { xml, ...body });

  assert.equal((await post('alice', { name: 'X', departmentId: dep1 })).status, 403);
  assert.equal((await api('alice', 'POST', '/workflows/validate', { xml })).status, 403);
  assert.equal((await post('manager', { name: 'Global' })).status, 403, 'managerul nu creează flux la nivel de companie');
  assert.equal((await post('manager', { name: 'Global', departmentId: null })).status, 403);
  assert.equal((await post('manager', { name: 'Alt dep', departmentId: dep2 })).status, 403);

  const own = await post('manager', { name: 'Aprobare Contract Șef Țară', departmentId: dep1 });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.key, 'aprobare-contract-sef-tara');
  assert.equal(own.body.departmentName, 'Juridic');
  assert.equal(own.body.canEdit, true);

  // Managerul altui departament nu își poate însuși cheia dând propriul departament.
  assert.equal((await post('manager2', { key: own.body.key, name: 'Preluare', departmentId: dep2 })).status, 403);
  await must('admin', 'POST', '/workflows', { key: 'global', name: 'Global', xml });
  assert.equal((await post('manager', { key: 'global', name: 'Preluare', departmentId: dep1 })).status, 403);

  // O versiune nouă fără departament îl păstrează pe cel existent.
  const next = await post('manager', { key: own.body.key, name: 'Aprobare 2' });
  assert.equal(next.status, 201);
  assert.equal(next.body.version, 2);
  assert.equal(next.body.departmentId, dep1);

  assert.equal((await post('admin', { name: 'Fără cheie validă', key: 'Cheie Mare' })).status, 400);
  assert.equal((await post('admin', {})).status, 400);
  assert.equal((await post('admin', { name: '!!!' })).status, 400);
  assert.equal((await post('admin', { name: 'Y', departmentId: 999999 })).status, 400);

  const list = await must('manager', 'GET', '/workflows');
  assert.equal(list.find((d: any) => d.key === own.body.key).canEdit, true);
  assert.equal(list.find((d: any) => d.key === 'global').canEdit, false);
  const audit = await db.one(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'flux.publicat' AND details->>'cheie' = $1 AND at > now() - interval '1 minute'`, [own.body.key]);
  assert.ok(audit!.n >= 2);
});

test('rute: assignee-options nu se confundă cu :key; fără sesiune 401', async () => {
  const opts = await must('alice', 'GET', '/workflows/assignee-options');
  assert.ok(opts.jobTitles.includes('Jurist'));
  assert.ok(opts.roles.includes('manager'));
  assert.ok(!opts.roles.includes('registratura'), 'rolurile fără drept de aprobare nu pot primi sarcini');
  assert.deepEqual(Object.keys(opts.users[0]).sort(), ['departmentName', 'fullName', 'id', 'jobTitle', 'username']);
  assert.ok(opts.departments.some((d: any) => d.name === 'Juridic'));
  assert.equal((await api(null, 'GET', '/workflows')).status, 401);
  assert.equal((await api(null, 'GET', '/tasks')).status, 401);
  assert.equal((await api(null, 'GET', '/dashboard')).status, 401);
});

// --- autorizare --------------------------------------------------------------------------------

test('doar titularul acționează, fără excepție pentru administrator; dreptul approve este cerut', async () => {
  await publish('auth', single({ assignee: 'alice' }));
  const { documentId, instanceId } = await startOn('auth');
  const t = await theTask('alice', documentId);
  for (const as of ['bob', 'admin', 'manager'] as Name[]) {
    assert.equal((await act(as, t.id, { action: 'approve' })).status, 403, as);
    assert.equal((await act(as, t.id, { action: 'reject', comment: 'x' })).status, 403, as);
    assert.equal((await act(as, t.id, { action: 'redirect', targetUserId: ids[as] })).status, 403, as);
  }
  assert.equal((await act('alice', 99999999, { action: 'approve' })).status, 404);
  await db.query(`INSERT INTO user_permissions VALUES ($1, 'approve', false)`, [ids.alice]);
  assert.equal((await act('alice', t.id, { action: 'approve' })).status, 403, 'dreptul retras');
  assert.equal(await instStatus(instanceId), 'activ');
  await db.query('DELETE FROM user_permissions WHERE user_id = $1', [ids.alice]);
  assert.equal((await act('alice', t.id, { action: 'approve' })).status, 200);
  // După încheiere, străinul primește tot 403, iar titularul 409.
  assert.equal((await act('bob', t.id, { action: 'approve' })).status, 403);
  assert.equal((await act('alice', t.id, { action: 'approve' })).status, 409);
});

// --- porți exclusive -----------------------------------------------------------------------------

test('poarta exclusivă alege după metadate, tip, departament sau calea implicită', async () => {
  const xml = wrap(startEv() + xor('G') + task('M', { assignee: 'alice' }) + task('Tip', { assignee: 'bob' }) + task('Dep', { assignee: 'carol' }) + task('Def', { assignee: 'dave' }) + endEv()
    + flow('Start', 'G') + flow('G', 'M', 'valoare = 100') + flow('G', 'Tip', 'tip = contract') + flow('G', 'Dep', 'departament = Financiar') + flow('G', 'Def')
    + flow('M', 'End') + flow('Tip', 'End') + flow('Dep', 'End') + flow('Def', 'End'));
  await publish('xor', xml);
  // Primele legături au prioritate; tipul este mereu „Contract”, deci eliminăm potrivirea pe tip pentru celelalte cazuri.
  const byMeta = await startOn('xor', { metadata: { valoare: '100' } });
  assert.equal((await openTasks('alice', byMeta.documentId)).length, 1);
  const byType = await startOn('xor');
  assert.equal((await openTasks('bob', byType.documentId)).length, 1);

  const noType = wrap(startEv() + xor('G', 'F_G_Def') + task('Dep', { assignee: 'carol' }) + task('Def', { assignee: 'dave' }) + endEv()
    + flow('Start', 'G') + flow('G', 'Dep', 'departament = Financiar') + flow('G', 'Def', 'ignorat = da', 'F_G_Def') + flow('Dep', 'End') + flow('Def', 'End'));
  await publish('xor2', noType);
  const byDep = await startOn('xor2', { department: dep2 }, 'admin');
  assert.equal((await openTasks('carol', byDep.documentId)).length, 1);
  const byDefault = await startOn('xor2');
  assert.equal((await openTasks('dave', byDefault.documentId)).length, 1);
  const { instances } = await must('reg', 'GET', `/documents/${byDefault.documentId}/workflow`);
  assert.deepEqual(instances[0].steps.map((s: any) => s.elementId), ['Start', 'G', 'Def']);
});

test('fluxul nu se aprobă cât timp altă ramură lucrează; un token rămas fără pereche îl încheie ca respins', async () => {
  const xml = wrap(startEv() + par('Split') + task('A', { assignee: 'alice' }) + xor('G') + par('Join') + endEv('End1') + endEv('End2')
    + flow('Start', 'Split') + flow('Split', 'A') + flow('Split', 'G') + flow('A', 'Join')
    + flow('G', 'End2', 'camp = x') + flow('G', 'Join') + flow('Join', 'End1'));
  await publish('blk', xml);
  const { documentId, instanceId } = await startOn('blk', { metadata: { camp: 'x' } });
  assert.equal(await instStatus(instanceId), 'activ', 'End2 atins, dar A este încă deschisă');
  await approve('alice', documentId);
  assert.equal(await instStatus(instanceId), 'respins');
  assert.equal(await docStatus(documentId), 'respins');
  assert.ok((await auditActions(documentId)).includes('flux.blocat'));
  assert.equal(await notifications('reg', 'document_respins', documentId), 1);

  // Pe cealaltă cale unirea primește ambii tokeni și fluxul se aprobă.
  const ok = await startOn('blk', { metadata: { camp: 'y' } });
  await approve('alice', ok.documentId);
  assert.equal(await instStatus(ok.instanceId), 'aprobat');
});

test('bucla fără sarcini oprește pornirea, iar tranzacția se anulează', async () => {
  // Validarea o respinge, deci o introducem direct, ca o definiție veche sau importată.
  const xml = wrap(startEv() + xor('G1') + xor('G2') + endEv() + flow('Start', 'G1') + flow('G1', 'G2') + flow('G2', 'G1'));
  assert.ok((await engine.validate(xml)).some((e) => e.includes('buclă')));
  await db.query(`INSERT INTO workflow_definitions (key, version, name, xml) VALUES ('loop', 1, 'Buclă', $1)`, [xml]);
  const documentId = await newDoc();
  const res = await api('reg', 'POST', '/workflows/loop/start', { documentId });
  assert.equal(res.status, 409);
  assert.match(res.body.message, /buclă/);
  assert.equal(await docStatus(documentId), 'inregistrat');
  assert.equal((await db.one('SELECT count(*)::int AS n FROM workflow_instances WHERE document_id = $1', [documentId]))!.n, 0);
});

// --- validare ---------------------------------------------------------------------------------

async function errorsOf(xml: string) {
  return (await must('admin', 'POST', '/workflows/validate', { xml })).errors as string[];
}
const hasError = (errors: string[], re: RegExp) => assert.ok(errors.some((e) => re.test(e)), `${re} lipsește din ${JSON.stringify(errors)}`);

test('validare: un flux corect nu are erori, în ambele forme de namespace', async () => {
  assert.deepEqual(await errorsOf(parallelXml), []);
  const defaultNs = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:seadoc="http://seadoc.ro/schema/bpmn" id="D">
    <process id="P"><startEvent id="S"><outgoing>f1</outgoing></startEvent>
      <userTask id="T" name="Avizare &amp; control" seadoc:assigneeType="rol" seadoc:assignee="manager" seadoc:action="aprobare" seadoc:completion="majority" seadoc:dueHours="48"><incoming>f1</incoming><outgoing>f2</outgoing></userTask>
      <endEvent id="E"><incoming>f2</incoming></endEvent>
      <sequenceFlow id="f1" sourceRef="S" targetRef="T"/><sequenceFlow id="f2" sourceRef="T" targetRef="E"/></process>
    <BPMNDiagram xmlns="http://www.omg.org/spec/BPMN/20100524/DI" id="Dg"><BPMNPlane id="Pl" bpmnElement="P"/></BPMNDiagram></definitions>`;
  assert.deepEqual(await errorsOf(defaultNs), []);
  const parsed = parseBpmn(defaultNs).process!.elements.get('T')!;
  assert.equal(parsed.name, 'Avizare & control');
  assert.equal(parsed.action, 'aprobare');
  assert.equal(parsed.completion, 'majority');
  assert.equal(parsed.dueHours, '48');
  assert.deepEqual(checkStructure(parseBpmn(defaultNs).process!), []);
});

test('validare: XML stricat, DOCTYPE, fișier fără proces', async () => {
  assert.equal((await errorsOf('')).length, 1);
  hasError(await errorsOf('<a><b></a>'), /XML invalid/);
  hasError(await errorsOf('<!DOCTYPE x [<!ENTITY a "b">]><definitions/>'), /DOCTYPE/);
  hasError(await errorsOf('<a/>'), /BPMN/);
  hasError(await errorsOf('<definitions id="x"/>'), /niciun proces/);
  const res = await api('admin', 'POST', '/workflows', { key: 'bad', name: 'Rău', xml: '<a/>' });
  assert.equal(res.status, 400);
  assert.equal(typeof res.body.message, 'string');
  assert.ok(Array.isArray(res.body.errors) && res.body.errors.length > 0);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM workflow_definitions WHERE key = 'bad'`))!.n, 0);
});

test('validare: start, final, atingere și legături', async () => {
  hasError(await errorsOf(wrap(endEv())), /exact un eveniment de start \(are 0\)/);
  hasError(await errorsOf(wrap(startEv('S1') + startEv('S2') + endEv() + flow('S1', 'End') + flow('S2', 'End'))), /are 2/);
  hasError(await errorsOf(wrap(startEv() + flow('Start', 'Start'))), /cel puțin un eveniment de final/);
  hasError(await errorsOf(wrap(startEv() + endEv() + flow('Start', 'End') + flow('End', 'Start'))), /nu poate avea legături de intrare/);
  hasError(await errorsOf(wrap(startEv() + endEv() + flow('Start', 'End') + flow('End', 'End'))), /nu poate avea legături de ieșire/);
  hasError(await errorsOf(wrap(startEv() + endEv() + task('T', { assignee: 'alice' }) + flow('Start', 'End') + flow('T', 'End'))), /nu poate fi atins/);
  hasError(await errorsOf(wrap(startEv() + endEv() + task('T', { assignee: 'alice' }) + flow('Start', 'End') + flow('Start', 'T'))), /nu se poate ajunge la un eveniment de final/);
  hasError(await errorsOf(wrap(startEv() + endEv() + flow('Start', 'End') + flow('Start', 'Lipsa'))), /element inexistent: Lipsa/);
  hasError(await errorsOf(wrap(startEv() + endEv() + flow('Start', 'End') + flow('Lipsa', 'End'))), /element inexistent: Lipsa/);
  hasError(await errorsOf(wrap(startEv() + endEv('Start') + flow('Start', 'Start'))), /folosit de mai multe ori/);
});

test('validare: elementele neacceptate se resping pe nume', async () => {
  const ok = startEv() + endEv() + flow('Start', 'End');
  hasError(await errorsOf(wrap(ok + '<bpmn:serviceTask id="Svc"/>')), /„serviceTask” \(Svc\)/);
  hasError(await errorsOf(wrap(ok + '<bpmn:inclusiveGateway id="Inc"/>')), /„inclusiveGateway”/);
  hasError(await errorsOf(wrap(ok + '<bpmn:subProcess id="Sub"/>')), /„subProcess”/);
  hasError(await errorsOf(wrap('<bpmn:startEvent id="Start"><bpmn:timerEventDefinition/></bpmn:startEvent>' + endEv() + flow('Start', 'End'))), /„timerEventDefinition”/);
  hasError(await errorsOf(wrap(startEv() + '<bpmn:userTask id="T" seadoc:assigneeType="initiator"><bpmn:multiInstanceLoopCharacteristics/></bpmn:userTask>' + endEv() + flow('Start', 'T') + flow('T', 'End'))), /„multiInstanceLoopCharacteristics”/);
  hasError(await errorsOf(wrap(startEv() + endEv() + '<bpmn:sequenceFlow id="F" sourceRef="Start" targetRef="End"><bpmn:conditionExpression>x</bpmn:conditionExpression></bpmn:sequenceFlow>')), /„conditionExpression”/);
});

test('validare: atributele sarcinii și valorile din baza de date', async () => {
  const one = (attrs: Parameters<typeof task>[1]) => errorsOf(single(attrs));
  hasError(await errorsOf(wrap(startEv() + '<bpmn:userTask id="T"/>' + endEv() + flow('Start', 'T') + flow('T', 'End'))), /lipsește seadoc:assigneeType/);
  hasError(await one({ type: 'magic', assignee: 'x' }), /tip de titular invalid „magic”/);
  hasError(await one({ type: 'functie' }), /lipsește seadoc:assignee/);
  hasError(await one({ assignee: 'alice', action: 'zbor' }), /acțiune invalidă/);
  hasError(await one({ assignee: 'alice', completion: 'toti' }), /regulă de finalizare invalidă/);
  for (const due of ['abc', '-3', '0', '1e9']) hasError(await one({ assignee: 'alice', due }), /termen invalid/);

  hasError(await one({ type: 'functie', assignee: 'Jurist,Astronaut,Scafandru' }), /Funcții.*: Astronaut, Scafandru$/);
  hasError(await one({ type: 'rol', assignee: 'manager,sef' }), /Roluri.*: sef$/);
  hasError(await one({ type: 'rol', assignee: 'registratura' }), /Roluri.*: registratura$/);
  hasError(await one({ assignee: 'alice,nimeni' }), /Utilizatori.*: nimeni$/);
  hasError(await one({ assignee: 'reg' }), /Utilizatori.*: reg$/);
  await db.query('UPDATE users SET active = false WHERE id = $1', [ids.bob]);
  hasError(await one({ assignee: 'bob' }), /Utilizatori.*: bob$/);
  assert.deepEqual(await one({ type: 'functie', assignee: 'jurist' }), [], 'funcția se compară fără majuscule');
  assert.deepEqual(await one({ type: 'initiator' }), []);
  assert.deepEqual(await one({ type: 'manager_departament' }), []);
});

test('validare: porți exclusive și bucle fără sarcini', async () => {
  const twoWays = (a?: string, b?: string, def?: string) => wrap(startEv() + xor('G', def) + endEv('E1') + endEv('E2') + flow('Start', 'G') + flow('G', 'E1', a) + flow('G', 'E2', b));
  assert.deepEqual(await errorsOf(twoWays('camp = 1')), []);
  assert.deepEqual(await errorsOf(twoWays('camp = 1', 'alt = 2', 'F_G_E2')), []);
  hasError(await errorsOf(twoWays('camp = 1', 'alt = 2')), /cale implicită/);
  hasError(await errorsOf(twoWays()), /mai multe căi fără condiție/);
  hasError(await errorsOf(twoWays('fara egal')), /condiție invalidă/);
  hasError(await errorsOf(twoWays('camp != 2')), /condiție invalidă/);
  hasError(await errorsOf(twoWays('camp = 1', undefined, 'Nimic')), /nu iese din această poartă/);
  hasError(await errorsOf(wrap(startEv() + endEv() + flow('Start', 'End', 'camp = 1'))), /doar la ieșirea dintr-o poartă exclusivă/);
  hasError(await errorsOf(wrap(startEv() + xor('G1') + par('G2') + endEv() + flow('Start', 'G1') + flow('G1', 'G2', 'a = 1') + flow('G1', 'End') + flow('G2', 'G1'))), /buclă fără nicio sarcină/);
  // O buclă care trece printr-o sarcină este permisă.
  assert.deepEqual(await errorsOf(wrap(startEv() + xor('G') + task('T', { assignee: 'alice' }) + endEv() + flow('Start', 'G') + flow('G', 'T', 'a = 1') + flow('G', 'End') + flow('T', 'G'))), []);
});

// --- liste -------------------------------------------------------------------------------------

test('/tasks și /dashboard', async () => {
  await publish('dash', single({ assignee: 'alice', due: '5', name: 'Avizare' }));
  const { documentId, instanceId } = await startOn('dash');
  await db.query(`UPDATE documents SET due_date = current_date + 2, reg_label = 'R-1' WHERE id = $1`, [documentId]);
  const other = await newDoc({ owner: 'alice' });

  const [t] = await openTasks('alice', documentId);
  assert.deepEqual(
    { name: t.name, kind: t.kind, status: t.status, overdue: t.overdue, regLabel: t.regLabel, documentTitle: t.documentTitle, workflowName: t.workflowName, instanceId: t.instanceId },
    { name: 'Avizare', kind: 'avizare', status: 'deschisa', overdue: false, regLabel: 'R-1', documentTitle: 'Contract test', workflowName: 'Flux dash', instanceId });

  const dash = await must('alice', 'GET', '/dashboard');
  assert.equal(dash.tasks.length, 1);
  assert.deepEqual(dash.counts, { openTasks: 1, overdueTasks: 0, pending: 2 });
  assert.deepEqual(dash.pendingDocuments.map((d: any) => d.id).sort((a: number, b: number) => a - b), [documentId, other]);
  assert.deepEqual(dash.dueThisWeek.map((d: any) => d.kind), ['sarcina', 'document']);
  assert.equal(dash.dueThisWeek[0].id, t.id);
  assert.equal(dash.dueThisWeek[0].documentId, documentId);
  assert.equal(dash.dueThisWeek[1].documentId, documentId);
  assert.equal(dash.dueThisWeek[1].id, undefined);

  await db.query(`UPDATE tasks SET due_at = now() - interval '1 hour' WHERE id = $1`, [t.id]);
  assert.equal((await must('alice', 'GET', '/dashboard')).counts.overdueTasks, 1);

  await must('alice', 'POST', `/tasks/${t.id}/action`, { action: 'approve', comment: 'De acord' });
  assert.equal((await openTasks('alice', documentId)).length, 0);
  const done = await must('alice', 'GET', '/tasks?scope=done');
  assert.equal(done.length, 1);
  assert.equal(done[0].status, 'finalizata');
  assert.equal(done[0].overdue, false);
  const view = await must('alice', 'GET', `/documents/${documentId}/workflow`);
  assert.deepEqual(
    { comment: view.instances[0].tasks[0].comment, assignee: view.instances[0].tasks[0].assignee, elementId: view.instances[0].tasks[0].elementId },
    { comment: 'De acord', assignee: 'Nume alice', elementId: 'T' });
  assert.ok(view.instances[0].tasks[0].completedAt);
  assert.equal(view.instances[0].startedBy, 'Nume reg');
});
