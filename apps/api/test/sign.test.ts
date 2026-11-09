// Semnături, previzualizare Office și TIFF: server HTTP real, PostgreSQL real, agentul local ca proces separat.
// Certificatele, PKCS#12 și fișierele se generează aici. Nimic din codul aplicației nu este înlocuit.
import assert from 'node:assert/strict';
import { execFile, spawn, ChildProcess, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { Parser } from 'htmlparser2';
import forge from 'node-forge';
import { PDFDocument } from 'pdf-lib';
import pg from 'pg';
import { scannedPagePng, scannedPdf, textPdf } from '../scripts/pdf-tools.js';
import { SCANNED_SAMPLE } from '../scripts/seed-documents.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://seadoc@127.0.0.1:55432/seadoc_sign_test';
if (!/test/.test(new URL(databaseUrl).pathname)) throw new Error('Testele șterg baza de date: DATABASE_URL trebuie să indice o bază de test');
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seadoc-sign-'));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seadoc-sign-work-'));
const trustDir = path.join(workDir, 'radacini');
const otherTrustDir = path.join(workDir, 'alte-radacini');
fs.mkdirSync(trustDir);
fs.mkdirSync(otherTrustDir);
process.env.DATABASE_URL = databaseUrl;
process.env.STORAGE_DIR = storageDir;
process.env.OCR_POLL_MS = '86400000';
process.env.SCHEDULER_MS = '86400000';
process.env.COOKIE_SECURE = 'false';
process.env.TRUST_ROOTS_DIR = trustDir;

const AGENT_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../agent/src/cli.js');
const PASSWORD = 'Parola-Test-2026!';
const P12_PASS = 'parola-p12-de-test';
const WEB_ORIGIN = 'https://seadoc.test.example';
const CHAIN_TEXT = 'lanț de încredere neverificat';

type Json = any;
let base = '';
let app: Json;
let db: Json;
let ocr: Json;
let storage: Json;
let config: Json;
let pdfText: (data: Buffer) => Promise<string[]>;
let pdfSig: typeof import('../src/pdf-signatures.js');
let passwordHash = '';
const ids: Record<string, number> = {};

class Client {
  cookie = '';
  async send(method: string, url: string, body?: BodyInit, contentType?: string) {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (contentType) headers['content-type'] = contentType;
    const res = await fetch(base + url, { method, headers, body });
    const set = res.headers.getSetCookie().find((c) => c.startsWith('seadoc_session='));
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : null, text, headers: res.headers };
  }
  get(url: string) { return this.send('GET', url); }
  post(url: string, body: Json = {}) { return this.send('POST', url, JSON.stringify(body), 'application/json'); }
  upload(url: string, fields: Record<string, unknown>, name: string, data: Buffer) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
    form.set('file', new Blob([new Uint8Array(data)]), name);
    return this.send('POST', url, form);
  }
  async bytes(url: string) {
    const res = await fetch(base + url, { headers: { cookie: this.cookie } });
    return { status: res.status, data: Buffer.from(await res.arrayBuffer()) };
  }
}

const clients: Record<string, Client> = {};

async function addUser(username: string, role: string, departmentId: number, opts: { hasToken?: boolean } = {}) {
  const id = (await db.one(
    `INSERT INTO users (username, full_name, password_hash, role, department_id, has_token) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [username, `Test ${username}`, passwordHash, role, departmentId, opts.hasToken ?? false])).id;
  const client = new Client();
  const r = await client.post('/api/auth/login', { username, password: PASSWORD });
  assert.equal(r.status, 200, r.text);
  clients[username] = client;
  ids[username] = id;
  return id;
}

let seq = 0;
async function addDoc(by: string, data: Buffer, name = 'document.pdf', title = `Document ${++seq}`) {
  const r = await clients[by].upload('/api/documents', { title, documentTypeId: ids.type, departmentId: ids.alpha }, name, data);
  assert.equal(r.status, 201, r.text);
  return r.body.id as number;
}

const samplePdf = (text = 'Contract de prestări servicii cu suficient text pentru pragul de pagină, Iași.') =>
  textPdf({ title: `Document de semnat ${++seq}`, paragraphs: [text] });

// Certificate de test -----------------------------------------------------------------------------

interface TestCert { key: forge.pki.rsa.PrivateKey; cert: forge.pki.Certificate; pem: string; sha256: string }

function pemSha(pem: string) {
  return crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest('hex');
}

function issue(subject: string, issuer: TestCert | null, opts: { ca?: boolean; from?: Date; to?: Date } = {}): TestCert {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(8).toString('hex').replace(/^[89a-f]/, '1');
  cert.validity.notBefore = opts.from ?? new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = opts.to ?? new Date(Date.now() + 365 * 86_400_000);
  const attrs = [{ name: 'commonName', value: subject, valueTagClass: forge.asn1.Type.UTF8 as any }, { name: 'countryName', value: 'RO' }];
  cert.setSubject(attrs);
  cert.setIssuer(issuer ? issuer.cert.subject.attributes : attrs);
  cert.setExtensions(opts.ca
    ? [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]
    : [{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, nonRepudiation: true }]);
  cert.sign(issuer ? issuer.key : keys.privateKey, forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(cert);
  return { key: keys.privateKey, cert, pem, sha256: pemSha(pem) };
}

function p12File(name: string, c: TestCert, chain: TestCert[], pass = P12_PASS) {
  const asn1 = forge.pkcs12.toPkcs12Asn1(c.key, [c.cert, ...chain.map((x) => x.cert)], pass, { algorithm: '3des' });
  const file = path.join(workDir, name);
  fs.writeFileSync(file, Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'));
  return file;
}

let rootCa: TestCert;
let intermediate: TestCert;
let signer: TestCert;
let secondSigner: TestCert;
let foreignRoot: TestCert;
let expired: TestCert;

// Agentul, ca proces separat, prin HTTP real -----------------------------------------------------------

let agentProc: ChildProcess | null = null;
let agentBase = '';
let pairingToken = '';
const agentHome = path.join(workDir, 'agent-home');
const certIds: Record<string, string> = {};

function agentCli(args: string[], input?: string): string {
  return execFileSync(process.execPath, [AGENT_CLI, ...args], { env: { ...process.env, SEADOC_AGENT_HOME: agentHome }, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

async function startAgent() {
  const proc = spawn(process.execPath, [AGENT_CLI, 'start'], {
    env: { ...process.env, SEADOC_AGENT_HOME: agentHome, SEADOC_AGENT_PORT: '0', SEADOC_AGENT_ORIGINS: WEB_ORIGIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agentProc = proc;
  const line = await new Promise<string>((resolve, reject) => {
    let out = '';
    proc.stdout!.on('data', (c) => {
      out += c;
      if (out.includes('\n')) resolve(out.split('\n')[0]);
    });
    proc.once('exit', (code) => reject(new Error(`Agentul s-a oprit cu ${code}`)));
  });
  agentBase = JSON.parse(line).listening;
}

function agent(method: string, url: string, body?: Json, headers: Record<string, string> = {}) {
  return fetch(agentBase + url, {
    method,
    headers: { origin: WEB_ORIGIN, 'x-seadoc-agent-token': pairingToken, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Ce face utilizatorul: deschide pagina agentului, introduce parola, confirmă. */
async function confirmInAgent(confirmUrl: string, pass: string, action = 'sign') {
  const page = await fetch(confirmUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1];
  assert.ok(csrf, 'formularul are token csrf');
  assert.ok(!html.includes(pass) || pass === '', 'parola nu apare în pagină');
  return { html, reply: await fetch(confirmUrl, {
    method: 'POST',
    headers: { origin: agentBase, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, pin: pass, action }),
  }) };
}

async function agentSign(digestHex: string, certificateId: string, pass = P12_PASS): Promise<string> {
  const r = await agent('POST', '/sign', { certificateId, digestAlgorithm: 'SHA-256', digestHex, label: 'Document de test' });
  assert.equal(r.status, 202);
  const { requestId, confirmUrl } = await r.json() as Json;
  const { reply } = await confirmInAgent(confirmUrl, pass);
  assert.equal(reply.status, 200);
  const poll = await (await agent('GET', `/sign/${requestId}`)).json() as Json;
  assert.equal(poll.status, 'semnat');
  return poll.cms;
}

const prepare = (who: string, body: Json) => clients[who].post('/api/signing/prepare', body);
const complete = (who: string, sessionId: string, body: Json) => clients[who].post(`/api/signing/sessions/${sessionId}/complete`, body);

async function signFully(who: string, target: { documentId?: number; taskId?: number }, c: TestCert, certId: string, comment?: string) {
  const p = await prepare(who, { ...target, certificatePem: c.pem });
  assert.equal(p.status, 200, p.text);
  const cms = await agentSign(p.body.digestHex, certId);
  const done = await complete(who, p.body.sessionId, { cms, comment });
  assert.equal(done.status, 200, done.text);
  return done.body;
}

// Flux BPMN cu o sarcină de semnare ----------------------------------------------------------------

const bpmn = (assignee: string, action = 'semnare') => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:seadoc="http://seadoc.ro/schema/bpmn" id="Defs" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Proc" isExecutable="false">
    <bpmn:startEvent id="Start"/>
    <bpmn:userTask id="T" name="Pas" seadoc:assigneeType="utilizator" seadoc:assignee="${assignee}" seadoc:action="${action}"/>
    <bpmn:endEvent id="End"/>
    <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="T"/>
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="End"/>
  </bpmn:process>
</bpmn:definitions>`;

let flowSeq = 0;
async function docInFlow(assignee: string, data?: Buffer, action = 'semnare') {
  const key = `flux-${++flowSeq}`;
  const pub = await clients.manager.post('/api/workflows', { key, name: `Flux ${key}`, xml: bpmn(assignee, action), departmentId: ids.alpha });
  assert.ok(pub.status < 300, pub.text);
  const documentId = await addDoc('manager', data ?? await samplePdf());
  await ocr.drain();
  const started = await clients.manager.post(`/api/workflows/${key}/start`, { documentId });
  assert.ok(started.status < 300, started.text);
  const taskId = (await db.one(`SELECT id FROM tasks WHERE document_id = $1 AND status = 'deschisa'`, [documentId])).id as number;
  return { documentId, taskId, instanceId: started.body.instanceId as number };
}

const verifyVia = async (who: string, documentId: number, version?: number) => {
  const r = await clients[who].post(`/api/documents/${documentId}/pdf-signatures/verify${version ? `?version=${version}` : ''}`);
  assert.equal(r.status, 200, r.text);
  return r.body;
};

// Verificare independentă de codul aplicației: citește ByteRange cu expresii, CMS cu OpenSSL, PDF cu pdf.js.
function independentParts(pdf: Buffer) {
  const text = pdf.toString('latin1');
  const all = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  const m = all[all.length - 1];
  const [a, b, c, d] = m.slice(1, 5).map(Number);
  const covered = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);
  const hex = pdf.toString('latin1', b + 1, c - 1);
  // Lungimea reală din antetul DER: semnătura se poate termina cu 0x00, deci zerourile de completare nu se taie după tipar.
  const raw = Buffer.from(hex, 'hex');
  const n = raw[1] & 0x7f;
  const len = raw[1] < 0x80 ? 2 + raw[1] : 2 + n + [...raw.subarray(2, 2 + n)].reduce((acc, x) => acc * 256 + x, 0);
  const der = raw.subarray(0, len);
  return { a, b, c, d, covered, der };
}

function opensslVerify(der: Buffer, covered: Buffer, caPem: string): Promise<{ ok: boolean; stderr: string }> {
  const dir = fs.mkdtempSync(path.join(workDir, 'openssl-'));
  fs.writeFileSync(path.join(dir, 'sig.der'), der);
  fs.writeFileSync(path.join(dir, 'data.bin'), covered);
  fs.writeFileSync(path.join(dir, 'ca.pem'), caPem);
  return new Promise((resolve) => {
    execFile('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', path.join(dir, 'sig.der'), '-content', path.join(dir, 'data.bin'),
      '-CAfile', path.join(dir, 'ca.pem'), '-purpose', 'any', '-out', path.join(dir, 'out.bin')], (err, _out, stderr) => {
      resolve({ ok: !err, stderr: String(stderr) });
    });
  });
}

async function pdfjsAnnotations(pdf: Buffer) {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await lib.getDocument({ data: new Uint8Array(pdf), useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const annotations = await (await doc.getPage(1)).getAnnotations();
  const pages = doc.numPages;
  await doc.loadingTask.destroy();
  return { pages, annotations };
}

/** CMS produs independent de agent, cu forge: alt semnatar, alt cod. */
function forgeCms(covered: Buffer, c: TestCert, extra: TestCert[] = [], signingTime = new Date()) {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(covered.toString('binary'));
  p7.addCertificate(c.cert);
  for (const x of extra) p7.addCertificate(x.cert);
  p7.addSigner({
    key: c.key,
    certificate: c.cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: signingTime as any },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

/** Un PDF semnat de altcineva, cu CMS-ul dat, așa cum ar sosi la registratură. */
function embed(prepared: { pdf: Buffer; contentsStart: number; contentsEnd: number }, der: Buffer) {
  const out = Buffer.from(prepared.pdf);
  out.write(der.toString('hex'), prepared.contentsStart + 1, 'latin1');
  return out;
}

async function receivedSigned(c: TestCert, chain: TestCert[] = [], signingTime?: Date) {
  const prepared = pdfSig.insertPlaceholder(await samplePdf(), new Date());
  const covered = Buffer.concat([prepared.pdf.subarray(0, prepared.contentsStart), prepared.pdf.subarray(prepared.contentsEnd)]);
  return embed(prepared, forgeCms(covered, c, chain, signingTime));
}

// -------------------------------------------------------------------------------------------------

before(async () => {
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE');
  await admin.query('CREATE SCHEMA public');
  await admin.end();

  const cfg = await import('../src/config.js');
  config = cfg.config;
  config.webDist = path.join(storageDir, 'fara-web');
  const main = await import('../src/main.js');
  const { Db } = await import('../src/db.js');
  const { OcrService, pdfText: extract } = await import('../src/ocr.js');
  const { StorageService } = await import('../src/storage.js');
  const { hashPassword } = await import('../src/auth.js');
  pdfSig = await import('../src/pdf-signatures.js');
  pdfText = extract;
  passwordHash = hashPassword(PASSWORD);
  app = await main.createApp({ logger: ['error'] });
  db = app.get(Db);
  ocr = app.get(OcrService);
  storage = app.get(StorageService);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;

  ids.alpha = (await db.one(`INSERT INTO departments (name) VALUES ('Alpha') RETURNING id`)).id;
  ids.beta = (await db.one(`INSERT INTO departments (name) VALUES ('Beta') RETURNING id`)).id;
  ids.type = (await db.one(`INSERT INTO document_types (name, nomenclator_code, retention_years) VALUES ('Tip test','T-1',5) RETURNING id`)).id;
  await addUser('manager', 'manager', ids.alpha);
  await addUser('semnatar', 'user', ids.alpha, { hasToken: true });
  await addUser('alt.semnatar', 'user', ids.alpha, { hasToken: true });
  await addUser('fara.token', 'user', ids.alpha);
  await addUser('strain', 'user', ids.beta, { hasToken: true });

  rootCa = issue('SeaDoc Test Root CA', null, { ca: true });
  intermediate = issue('SeaDoc Test Intermediar', rootCa, { ca: true });
  signer = issue('Ștefan Țăran Semnatar Test', intermediate);
  secondSigner = issue('Maria Ionescu Semnatar Test', intermediate);
  foreignRoot = issue('Alta Autoritate Root', null, { ca: true });
  expired = issue('Certificat Expirat Test', intermediate, { from: new Date(Date.now() - 30 * 86_400_000), to: new Date(Date.now() - 86_400_000) });
  fs.writeFileSync(path.join(trustDir, 'test-radacina.pem'), rootCa.pem);
  fs.writeFileSync(path.join(otherTrustDir, 'alta.pem'), foreignRoot.pem);

  certIds.signer = agentCli(['import-p12', p12File('semnatar.p12', signer, [intermediate, rootCa])], `${P12_PASS}\n`).split('\t')[0].trim();
  certIds.second = agentCli(['import-p12', p12File('al-doilea.p12', secondSigner, [intermediate, rootCa])], `${P12_PASS}\n`).split('\t')[0].trim();
  pairingToken = agentCli(['pair']).trim();
  await startAgent();
});

after(async () => {
  agentProc?.kill('SIGTERM');
  await app?.close();
  fs.rmSync(storageDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

// Verificarea semnăturilor primite ---------------------------------------------------------------------

test('document fără semnături: raportul o spune și se păstrează', async () => {
  const id = await addDoc('manager', await samplePdf());
  const r = await verifyVia('manager', id);
  assert.equal(r.report.status, 'fara_semnaturi');
  const stored = await clients.manager.get(`/api/documents/${id}/pdf-signatures`);
  assert.equal(stored.status, 200);
  assert.equal(stored.body[0].report.status, 'fara_semnaturi');
  assert.equal((await clients.strain.get(`/api/documents/${id}/pdf-signatures`)).status, 404, 'fără vizibilitate nu vede rezultatul');
  assert.equal((await clients.strain.post(`/api/documents/${id}/pdf-signatures/verify`)).status, 404);
});

test('semnătură primită, CMS produs de alt cod: raportul complet, cu lanț neverificat fără rădăcina potrivită', async () => {
  const when = new Date(Date.now() - 3_600_000);
  const pdf = await receivedSigned(signer, [intermediate, rootCa], when);
  const id = await addDoc('manager', pdf);

  // Rădăcini configurate, dar altele decât cea a semnatarului.
  config.trustRootsDir = otherTrustDir;
  try {
    const r = await verifyVia('manager', id);
    assert.equal(r.report.status, 'cu_semnaturi');
    const s = r.report.signatures[0];
    assert.equal(s.verdict, 'lant_neverificat');
    assert.notEqual(s.chain.status, 'verificat');
    assert.ok(s.chain.message.includes(CHAIN_TEXT), s.chain.message);
    assert.ok(s.message.includes(CHAIN_TEXT));
    assert.ok(!/\bvalid[ăa]?\b/i.test(s.chain.message));
    assert.match(s.signer.subject, /Ștefan Țăran Semnatar Test/);
    assert.match(s.signer.issuer, /SeaDoc Test Intermediar/);
    assert.equal(s.signingTime.value, new Date(Math.floor(when.getTime() / 1000) * 1000).toISOString());
    assert.equal(s.signingTime.source, 'atribut_semnat');
    assert.equal(s.digestMatches, true);
    assert.equal(s.cmsSignatureValid, true);
    assert.equal(s.coversWholeFile, true);
    assert.equal(s.certificateValidAtSigning, true);
    assert.equal(s.revocation.checked, false);
    assert.match(s.revocation.message, /nu a fost verificată/);
    assert.equal(s.qualified.checked, false);
    assert.match(s.qualified.message, /nu a fost verificat/);
    assert.ok(s.testIndicators.length > 0);
  } finally {
    config.trustRootsDir = trustDir;
  }

  // Fără nicio rădăcină.
  config.trustRootsDir = null;
  try {
    const r = await verifyVia('manager', id);
    assert.equal(r.report.signatures[0].verdict, 'lant_neverificat');
    assert.ok(r.report.signatures[0].chain.message.includes('TRUST_ROOTS_DIR'));
  } finally {
    config.trustRootsDir = trustDir;
  }

  // Cu rădăcina potrivită: lanț verificat până la ea, prin intermediarul din semnătură.
  const trusted = (await verifyVia('manager', id)).report.signatures[0];
  assert.equal(trusted.verdict, 'valida');
  assert.equal(trusted.chain.status, 'verificat');
  assert.equal(trusted.chain.rootFile, 'test-radacina.pem');
  assert.equal(trusted.chain.certificates.length, 3);
  assert.equal(trusted.revocation.checked, false);
  assert.equal(trusted.qualified.checked, false);
  assert.ok(trusted.testIndicators.some((t: string) => t.includes('test-radacina.pem')));
  assert.ok(!JSON.stringify(trusted).includes('calificată'), 'raportul nu pretinde statut calificat');

  const audit = await db.one(`SELECT details FROM audit_log WHERE document_id = $1 AND action = 'document.verificare_semnaturi' ORDER BY seq DESC LIMIT 1`, [id]);
  assert.equal(audit.details.stare, 'cu_semnaturi');
});

test('un intermediar lipsă din semnătură lasă lanțul neverificat, iar un certificat obișnuit nu poate fi intermediar', async () => {
  const noIntermediate = (await verifyVia('manager', await addDoc('manager', await receivedSigned(signer, [rootCa])))).report.signatures[0];
  assert.equal(noIntermediate.chain.status, 'neverificat');
  assert.ok(noIntermediate.chain.message.includes(CHAIN_TEXT));

  // Semnatarul „emite” un certificat cu cheia lui; nu are drept de autoritate.
  const forged = issue('Fals Emis De Semnatar', signer);
  const r = (await verifyVia('manager', await addDoc('manager', await receivedSigned(forged, [signer, intermediate, rootCa])))).report.signatures[0];
  assert.equal(r.chain.status, 'neverificat', 'un certificat fără CA nu continuă lanțul');
});

test('certificat expirat la momentul semnării și semnătură peste alți octeți', async () => {
  const late = (await verifyVia('manager', await addDoc('manager', await receivedSigned(expired, [intermediate, rootCa], new Date())))).report.signatures[0];
  assert.equal(late.verdict, 'certificat_nevalabil');
  assert.equal(late.certificateValidAtSigning, false);

  // CMS corect ca formă, dar peste alt conținut.
  const prepared = pdfSig.insertPlaceholder(await samplePdf(), new Date());
  const wrong = embed(prepared, forgeCms(Buffer.from('alt conținut'), signer, [intermediate, rootCa]));
  const r = (await verifyVia('manager', await addDoc('manager', wrong))).report.signatures[0];
  assert.equal(r.verdict, 'alterata');
  assert.equal(r.digestMatches, false);
});

test('CMS produs de OpenSSL, cu cheie RSA-PSS și EC: se verifică la fel', { skip: !hasOpenssl() }, async () => {
  const cases: [string, string[], string[]][] = [
    ['EC', ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256'], []],
    ['RSA-PSS', ['-newkey', 'rsa:2048'], ['-keyopt', 'rsa_padding_mode:pss']],
  ];
  for (const [label, keyArgs, signArgs] of cases) {
    const dir = fs.mkdtempSync(path.join(workDir, 'ossl-'));
    const key = path.join(dir, 'k.pem');
    const crt = path.join(dir, 'c.pem');
    execFileSync('openssl', ['req', '-x509', '-nodes', ...keyArgs, '-keyout', key, '-out', crt, '-days', '2', '-subj', `/CN=OpenSSL ${label} Test`], { stdio: 'ignore' });
    const prepared = pdfSig.insertPlaceholder(await samplePdf(), new Date());
    const dataFile = path.join(dir, 'd.bin');
    fs.writeFileSync(dataFile, Buffer.concat([prepared.pdf.subarray(0, prepared.contentsStart), prepared.pdf.subarray(prepared.contentsEnd)]));
    const sigFile = path.join(dir, 's.der');
    execFileSync('openssl', ['cms', '-sign', '-binary', '-md', 'sha256', '-signer', crt, '-inkey', key, '-in', dataFile, '-outform', 'DER', '-out', sigFile, ...signArgs], { stdio: 'ignore' });
    const r = (await verifyVia('manager', await addDoc('manager', embed(prepared, fs.readFileSync(sigFile))))).report.signatures[0];
    assert.equal(r.digestMatches, true, label);
    assert.equal(r.cmsSignatureValid, true, label);
    assert.equal(r.chain.status, 'neverificat', label);
    assert.equal(r.verdict, 'lant_neverificat', label);
    assert.ok(r.testIndicators.includes('certificat autosemnat'), label);
  }
});

function hasOpenssl() {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// Fișiere ostile --------------------------------------------------------------------------------------

const sigObject = (byteRange: string, hex: string, sub = 'adbe.pkcs7.detached') =>
  `1 0 obj\n<</Type/Sig/Filter/Adobe.PPKLite/SubFilter/${sub}/ByteRange[${byteRange}]/Contents<${hex}>>>\nendobj\n`;

test('PDF-uri ostile: fiecare primește un raport, niciunul nu trece drept valid, serverul rămâne în picioare', { timeout: 120_000 }, async () => {
  const head = '%PDF-1.7\n';
  const deepDer = Buffer.concat(Array.from({ length: 2000 }, () => Buffer.from([0x30, 0x80]))).toString('hex');
  const hugeLen = '3084ffffffff';
  const bomb = zlib.deflateSync(Buffer.alloc(80 * 1024 * 1024));
  const hostile: Record<string, Buffer> = {
    'gunoi după antet': Buffer.from(`${head}${crypto.randomBytes(4096).toString('latin1')}`, 'latin1'),
    'trunchiat': Buffer.from(`${head}1 0 obj\n<</ByteRange[0 1`),
    'liste imbricate': Buffer.from(`${head}1 0 obj\n${'['.repeat(200_000)}`),
    'dicționare imbricate': Buffer.from(`${head}1 0 obj\n${'<</A '.repeat(100_000)}`),
    'ByteRange peste fișier': Buffer.from(`${head}${sigObject('0 10 999999 999999', '3000')}`),
    'ByteRange negativ': Buffer.from(`${head}${sigObject('-5 10 20 -3', '3000')}`),
    'ByteRange cu trei numere': Buffer.from(`${head}${sigObject('0 10 20', '3000')}`),
    'ByteRange real și enorm': Buffer.from(`${head}${sigObject('0 1e308 2 3', '3000')}`),
    'CMS gunoi': Buffer.from(`${head}${sigObject('0 40 60 10', 'deadbeef'.repeat(64))}`),
    'CMS gol': Buffer.from(`${head}${sigObject('0 40 60 10', '')}`),
    'DER cu lungime enormă': Buffer.from(`${head}${sigObject('0 40 60 10', hugeLen)}`),
    'DER adânc': Buffer.from(`${head}${sigObject('0 40 60 10', deepDer)}`),
    'bombă în flux de obiecte': Buffer.concat([Buffer.from(`${head}1 0 obj\n<</Type/ObjStm/N 1/First 4/Filter/FlateDecode/Length ${bomb.length}>>\nstream\n`), bomb, Buffer.from('\nendstream\nendobj\n')]),
    'referințe circulare în formular': Buffer.from(`${head}1 0 obj\n<</Type/Catalog/AcroForm 2 0 R/Pages 1 0 R>>\nendobj\n2 0 obj\n<</Fields[3 0 R]>>\nendobj\n3 0 obj\n<</Kids[3 0 R]/V 3 0 R/ByteRange[0 1 2 3]/Contents<00>>>\nendobj\ntrailer\n<</Root 1 0 R>>\n`),
    'prea multe semnături': Buffer.from(head + Array.from({ length: 200 }, (_, i) => sigObject('0 10 20 3', '3000').replace('1 0 obj', `${i + 1} 0 obj`)).join('')),
  };
  for (const [name, data] of Object.entries(hostile)) {
    const id = await addDoc('manager', data, 'ostil.pdf', `Ostil: ${name}`);
    const r = await clients.manager.post(`/api/documents/${id}/pdf-signatures/verify`);
    assert.equal(r.status, 200, `${name}: ${r.text}`);
    assert.ok(['malformat', 'fara_semnaturi', 'cu_semnaturi', 'esuat'].includes(r.body.report.status), name);
    for (const s of r.body.report.signatures) assert.notEqual(s.verdict, 'valida', name);
    // Pregătirea pentru semnare refuză curat aceleași fișiere, cu un motiv, în loc să producă un PDF semnabil.
    await db.query(`UPDATE document_versions SET ocr_status = 'neaplicabil' WHERE document_id = $1`, [id]);
    const p = await prepare('manager', { documentId: id, certificatePem: signer.pem });
    assert.equal(p.status, 400, `${name}: pregătire ${p.status} ${p.text}`);
    assert.match(p.body.message, /PDF/, name);
    assert.equal((await clients.manager.get('/api/auth/me')).status, 200, `${name}: serverul răspunde`);
  }
});

test('semnătura mutată: golul din ByteRange nu mai este șirul /Contents', async () => {
  const prepared = pdfSig.insertPlaceholder(await samplePdf(), new Date());
  const covered = Buffer.concat([prepared.pdf.subarray(0, prepared.contentsStart), prepared.pdf.subarray(prepared.contentsEnd)]);
  const good = embed(prepared, forgeCms(covered, signer, [intermediate, rootCa]));
  // Actualizare care înlocuiește dicționarul semnăturii cu altul, ce refolosește același ByteRange peste conținutul vechi.
  const text = good.toString('latin1');
  const br = /\/ByteRange\s*\[[^\]]+\]/.exec(text)![0];
  const wrapped = Buffer.concat([good, Buffer.from(`\n90 0 obj\n<</Type/Sig/SubFilter/ETSI.CAdES.detached${br}/Contents<3000>>>\nendobj\n`, 'latin1')]);
  const r = (await verifyVia('manager', await addDoc('manager', wrapped))).report.signatures;
  const fake = r.find((s: Json) => s.byteRangeValid === false);
  assert.ok(fake, 'dicționarul adăugat este semnalat');
  assert.equal(fake.verdict, 'structura_invalida');
  const real = r.find((s: Json) => s.byteRangeValid === true);
  assert.equal(real.coversWholeFile, false);
  assert.equal(real.verdict, 'modificat_dupa_semnare');
});

test('limitele firului izolat: timpul și memoria opresc lucrul, nu serverul', { timeout: 60_000 }, async () => {
  const { runInWorker, WorkerLimitError, detachedCopy } = await import('../src/bounded-worker.js');
  // Șiruri neterminate: analiza devine pătratică, deci depășește limita mică de timp.
  const slow = detachedCopy(Buffer.from(`%PDF-1.7\n${'1 0 obj (a '.repeat(600_000)}`));
  await assert.rejects(runInWorker('pdf-verify', { data: slow, roots: [] }, { timeoutMs: 200, maxOldMb: 128 }, [slow.buffer as ArrayBuffer]),
    (e: Json) => e instanceof WorkerLimitError && e.kind === 'timp_depasit');
  // Multe obiecte mici umplu o limită mică de memorie.
  const fat = detachedCopy(Buffer.from(`%PDF-1.7\n1 0 obj\n[${'<</A 1>> '.repeat(900_000)}]\nendobj\n`));
  await assert.rejects(runInWorker('pdf-verify', { data: fat, roots: [] }, { timeoutMs: 40_000, maxOldMb: 16 }, [fat.buffer as ArrayBuffer]),
    (e: Json) => e instanceof WorkerLimitError && (e.kind === 'memorie_depasita' || e.kind === 'esuat'));
  assert.equal((await clients.manager.get('/api/auth/me')).status, 200);
});

// Semnarea prin agent -------------------------------------------------------------------------------------

test('fluxul complet prin agent: sarcina se finalizează, PDF-ul semnat trece verificările independente', { timeout: 120_000 }, async () => {
  const original = await samplePdf('Text de control pentru extragere după semnare: Iași, sănătate și securitate în muncă.');
  const { documentId, taskId, instanceId } = await docInFlow('semnatar', original);

  // Certificatul declarat se vede în agent, cu mențiunea de test.
  const list = await (await agent('GET', '/certificates')).json() as Json;
  const listed = list.certificates.find((c: Json) => c.id === certIds.signer);
  assert.equal(listed.testCertificate, true);
  assert.equal(listed.sha256, signer.sha256);

  const p = await prepare('semnatar', { taskId, certificatePem: listed.certPem });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.body.digestAlgorithm, 'SHA-256');
  assert.match(p.body.digestHex, /^[0-9a-f]{64}$/);
  assert.equal(p.body.documentId, documentId);
  assert.equal(p.body.versionNo, 1);

  const cms = await agentSign(p.body.digestHex, certIds.signer);
  const done = await complete('semnatar', p.body.sessionId, { cms, comment: 'Semnat prin agent' });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.versionNo, 2);
  assert.equal(done.body.task.status, 'finalizata');
  assert.equal(done.body.task.instanceStatus, 'aprobat');
  assert.equal(done.body.testCertificate, true);

  assert.equal((await db.one(`SELECT status FROM tasks WHERE id = $1`, [taskId])).status, 'finalizata');
  assert.equal((await db.one(`SELECT status FROM workflow_instances WHERE id = $1`, [instanceId])).status, 'aprobat');
  assert.equal((await db.one(`SELECT status FROM documents WHERE id = $1`, [documentId])).status, 'aprobat');
  const sig = await db.one(`SELECT * FROM signatures WHERE document_id = $1`, [documentId]);
  assert.equal(sig.kind, 'certificat');
  assert.equal(sig.signer_id, ids.semnatar);
  assert.equal(sig.certificate_sha256, signer.sha256);
  const version = await db.one(`SELECT * FROM document_versions WHERE document_id = $1 AND version_no = 2`, [documentId]);
  assert.equal(version.ocr_status, 'finalizat', 'versiunea semnată nu mai trece prin OCR');
  assert.equal(version.searchable_key, null);
  assert.match(version.text_content, /sănătate/);

  // Fișierul descărcat prin API.
  const file = await clients.semnatar.bytes(`/api/documents/${documentId}/file?version=2&download=1`);
  assert.equal(file.status, 200);
  const signed = file.data;
  assert.equal(crypto.createHash('sha256').update(signed).digest('hex'), version.sha256);
  assert.equal(crypto.createHash('sha256').update(signed).digest('hex'), sig.sha256);
  assert.ok(signed.subarray(0, original.length).equals(original), 'actualizarea incrementală lasă intact fișierul semnat');

  // Independent: hash peste ByteRange, CMS cu OpenSSL, pagini și câmp cu pdf.js, text.
  const parts = independentParts(signed);
  assert.equal(crypto.createHash('sha256').update(parts.covered).digest('hex'), p.body.digestHex);
  assert.equal(parts.a, 0);
  assert.equal(parts.c + parts.d, signed.length, 'ByteRange acoperă tot fișierul');
  const ossl = await opensslVerify(parts.der, parts.covered, rootCa.pem);
  assert.ok(ossl.ok, ossl.stderr);
  const js = await pdfjsAnnotations(signed);
  assert.equal(js.pages, 1);
  const widget = js.annotations.find((a: Json) => a.fieldType === 'Sig');
  assert.ok(widget, 'pdf.js vede câmpul de semnătură');
  assert.deepEqual(await pdfText(signed), await pdfText(original), 'textul rămâne identic');
  await PDFDocument.load(signed);

  // Verificatorul aplicației.
  const report = (await verifyVia('semnatar', documentId)).report;
  assert.equal(report.signatures.length, 1);
  const s = report.signatures[0];
  assert.equal(s.verdict, 'valida');
  assert.equal(s.digestMatches, true);
  assert.equal(s.cmsSignatureValid, true);
  assert.equal(s.coversWholeFile, true);
  assert.equal(s.signingCertificateAttribute, 'ok');
  assert.equal(s.subFilter, 'ETSI.CAdES.detached');
  assert.equal(s.signingTime.source, 'dictionar_pdf');
  assert.equal(s.chain.status, 'verificat');
  assert.equal(s.qualified.checked, false);
  assert.equal(s.fieldName, 'SemnaturaSeaDoc1');
  assert.equal(s.referenced, true);
  assert.ok(s.testIndicators.length > 0, 'certificatul de test este semnalat');

  // Calea internă de verificare recunoaște tipul nou.
  const internal = await clients.semnatar.get(`/api/documents/${documentId}/signatures/verify`);
  assert.equal(internal.status, 200);
  assert.equal(internal.body[0].kind, 'certificat');
  assert.equal(internal.body[0].valid, true);
  assert.equal(internal.body[0].certificate.chain, 'verificat');

  const detail = await clients.semnatar.get(`/api/documents/${documentId}`);
  const row = detail.body.signatures[0];
  assert.equal(row.kind, 'certificat');
  assert.match(row.certificateSubject, /Ștefan/);
  assert.ok(row.testIndicators.length > 0);

  const actions = (await db.query(`SELECT action FROM audit_log WHERE document_id = $1`, [documentId])).rows.map((r: Json) => r.action);
  for (const a of ['semnatura.pregatita', 'document.semnatura_certificat', 'sarcina.aprobata']) assert.ok(actions.includes(a), a);

  // Aceeași sesiune nu se poate folosi de două ori.
  assert.equal((await complete('semnatar', p.body.sessionId, { cms })).status, 409);
  const leftover = await db.one(`SELECT storage_key FROM signing_sessions WHERE id = $1`, [p.body.sessionId]);
  assert.equal(leftover.storage_key, null, 'PDF-ul pregătit nu rămâne în stocare');
});

test('alterarea după semnare se detectează, inclusiv de calea internă', { timeout: 60_000 }, async () => {
  const documentId = await addDoc('manager', await samplePdf('Conținut original al contractului, suficient pentru a trece de prag.'));
  await ocr.drain();
  const done = await signFully('manager', { documentId }, signer, certIds.signer);
  const signed = (await clients.manager.bytes(`/api/documents/${documentId}/file?version=${done.versionNo}`)).data;
  const parts = independentParts(signed);

  // Un octet schimbat în conținutul acoperit.
  const flipped = Buffer.from(signed);
  flipped[100] ^= 0x01;
  const a = (await verifyVia('manager', await addDoc('manager', flipped))).report.signatures[0];
  assert.equal(a.verdict, 'alterata');
  assert.equal(a.digestMatches, false);
  assert.equal((await opensslVerify(parts.der, Buffer.concat([flipped.subarray(0, parts.b), flipped.subarray(parts.c)]), rootCa.pem)).ok, false, 'și OpenSSL respinge');

  // Un octet schimbat chiar în semnătură.
  const badSig = Buffer.from(signed);
  const sigByte = parts.b + 1 + parts.der.length * 2 - 2; // ultimele cifre ale CMS-ului: valoarea semnăturii RSA
  badSig[sigByte] = badSig[sigByte] === 0x30 ? 0x31 : 0x30;
  const b = (await verifyVia('manager', await addDoc('manager', badSig))).report.signatures[0];
  assert.equal(b.verdict, 'semnatura_invalida');
  assert.equal(b.cmsSignatureValid, false);
  assert.equal(b.digestMatches, true);

  // Un octet schimbat într-un certificat din CMS: lanțul nu mai poate fi confirmat ca fiind de încredere.
  const badChain = Buffer.from(signed);
  const middle = parts.b + 1 + parts.der.length;
  badChain[middle] = badChain[middle] === 0x30 ? 0x31 : 0x30;
  assert.notEqual((await verifyVia('manager', await addDoc('manager', badChain))).report.signatures[0].verdict, 'valida');

  // O revizie adăugată după semnare.
  const appended = Buffer.concat([signed, Buffer.from('\n99 0 obj\n<</Modificat true>>\nendobj\n')]);
  const c = (await verifyVia('manager', await addDoc('manager', appended))).report.signatures[0];
  assert.equal(c.coversWholeFile, false);
  assert.equal(c.bytesAfterSignature, appended.length - signed.length);
  assert.equal(c.verdict, 'modificat_dupa_semnare');

  // Fișierul din stocare înlocuit: calea internă nu mai confirmă semnătura.
  const key = await storage.put(flipped);
  await db.query(`UPDATE document_versions SET storage_key = $2 WHERE document_id = $1 AND version_no = $3`, [documentId, key, done.versionNo]);
  const internal = await clients.manager.get(`/api/documents/${documentId}/signatures/verify`);
  assert.equal(internal.body[0].valid, false);
  // Rândul din bază modificat: sigiliul nu mai corespunde, chiar dacă fișierul este corect.
  const docTwo = await addDoc('manager', await samplePdf('Al doilea document de semnat, cu suficient text pentru a trece de prag.'));
  await ocr.drain();
  await signFully('manager', { documentId: docTwo }, signer, certIds.signer);
  await db.query(`UPDATE signatures SET certificate_sha256 = $2 WHERE document_id = $1`, [docTwo, 'f'.repeat(64)]);
  const sealed = await clients.manager.get(`/api/documents/${docTwo}/signatures/verify`);
  assert.equal(sealed.body[0].valid, false);
});

test('PDF scanat cu strat OCR: semnarea nu îl strică, textul rămâne extractibil și semnătura anterioară rămâne', { timeout: 300_000 }, async () => {
  const documentId = await addDoc('manager', await scannedPdf(SCANNED_SAMPLE), 'scan.pdf');
  await ocr.drain();
  const before = await db.one(`SELECT searchable_key, ocr_used, text_content FROM document_versions WHERE document_id = $1 AND version_no = 1`, [documentId]);
  assert.ok(before.searchable_key, 'există PDF căutabil');
  assert.equal(before.ocr_used, true);
  const searchable: Buffer = await storage.get(before.searchable_key);
  const textBefore = await pdfText(searchable);
  assert.match(textBefore.join(' '), /hamul/);

  const first = await signFully('manager', { documentId }, signer, certIds.signer);
  const signed1 = (await clients.manager.bytes(`/api/documents/${documentId}/file?version=${first.versionNo}`)).data;
  assert.ok(signed1.subarray(0, searchable.length).equals(searchable), 'semnarea pornește de la PDF-ul căutabil, neatins');
  assert.deepEqual(await pdfText(signed1), textBefore, 'stratul OCR rămâne extractibil, identic');
  assert.ok((await pdfjsAnnotations(signed1)).annotations.some((a: Json) => a.fieldType === 'Sig'));

  // A doua semnătură peste prima: prima rămâne valabilă pentru revizia ei.
  const second = await signFully('manager', { documentId }, secondSigner, certIds.second);
  assert.equal(second.versionNo, first.versionNo + 1);
  const signed2 = (await clients.manager.bytes(`/api/documents/${documentId}/file?version=${second.versionNo}`)).data;
  assert.ok(signed2.subarray(0, signed1.length).equals(signed1));
  assert.deepEqual(await pdfText(signed2), textBefore);
  const r = (await verifyVia('manager', documentId)).report.signatures;
  assert.equal(r.length, 2);
  assert.equal(r[0].digestMatches, true);
  assert.equal(r[0].cmsSignatureValid, true);
  assert.equal(r[0].coversWholeFile, false);
  assert.equal(r[0].verdict, 'modificat_dupa_semnare');
  assert.equal(r[1].verdict, 'valida');
  assert.equal(r[1].coversWholeFile, true);
  assert.match(r[1].signer.subject, /Maria/);
  assert.equal(r[1].fieldName, 'SemnaturaSeaDoc2');
  // Căutarea găsește documentul în continuare.
  const found = await clients.manager.get('/api/documents?q=hamul');
  assert.ok(found.body.items.some((d: Json) => d.id === documentId));
});

test('forme de PDF: tabel clasic de referințe, formular existent, Annots și Fields ca obiecte separate', { timeout: 60_000 }, async () => {
  const classic = await PDFDocument.load(await samplePdf('Fișier salvat fără fluxuri de obiecte, cu tabel clasic de referințe la final.'));
  const classicBytes = Buffer.from(await classic.save({ useObjectStreams: false }));
  assert.ok(classicBytes.includes('\nxref\n') || classicBytes.includes('xref\n0 '), 'tabel clasic');

  const withForm = await PDFDocument.load(await samplePdf('Fișier cu formular existent, ale cărui câmpuri trebuie să rămână după semnare.'));
  const textField = withForm.getForm().createTextField('camp.existent');
  textField.setText('valoare');
  textField.addToPage(withForm.getPage(0));
  const formBytes = Buffer.from(await withForm.save({ useObjectStreams: true }));

  const hand = (() => {
    // PDF scris de mână: Annots și Fields sunt referințe spre liste separate.
    const objs = [
      '1 0 obj\n<</Type/Catalog/Pages 2 0 R/AcroForm 5 0 R>>\nendobj\n',
      '2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n',
      '3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Annots 4 0 R/Resources<</Font<</F1 8 0 R>>>>/Contents 9 0 R>>\nendobj\n',
      '4 0 obj\n[7 0 R]\nendobj\n',
      '5 0 obj\n<</Fields 6 0 R>>\nendobj\n',
      '6 0 obj\n[7 0 R]\nendobj\n',
      '7 0 obj\n<</Type/Annot/Subtype/Widget/FT/Tx/T(alt)/Rect[0 0 10 10]/P 3 0 R>>\nendobj\n',
      '8 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n',
    ];
    const content = 'BT /F1 12 Tf 10 100 Td (Text scris de mana in document, cu litere suficiente pentru prag.) Tj ET';
    objs.push(`9 0 obj\n<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n`);
    let body = '%PDF-1.5\n';
    const offsets: number[] = [];
    for (const o of objs) { offsets.push(body.length); body += o; }
    const xref = body.length;
    body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(body, 'latin1');
  })();

  for (const [label, data] of [['clasic', classicBytes], ['formular', formBytes], ['de mână', hand]] as [string, Buffer][]) {
    const documentId = await addDoc('manager', data);
    await ocr.drain();
    const textBefore = await pdfText(data);
    const done = await signFully('manager', { documentId }, signer, certIds.signer);
    const signed = (await clients.manager.bytes(`/api/documents/${documentId}/file?version=${done.versionNo}`)).data;
    assert.ok(signed.subarray(0, data.length).equals(data), label);
    assert.deepEqual(await pdfText(signed), textBefore, label);
    const annots = (await pdfjsAnnotations(signed)).annotations;
    assert.ok(annots.some((a: Json) => a.fieldType === 'Sig'), `${label}: câmp semnătură`);
    const s = (await verifyVia('manager', documentId)).report.signatures[0];
    assert.equal(s.verdict, 'valida', `${label}: ${s.message} ${s.issues}`);
    assert.equal(s.referenced, true, label);
    assert.ok((await opensslVerify(independentParts(signed).der, independentParts(signed).covered, rootCa.pem)).ok, label);
    if (label === 'formular') assert.ok(annots.some((a: Json) => a.fieldName === 'camp.existent'), 'câmpul existent rămâne');
    if (label === 'de mână') assert.ok(annots.some((a: Json) => a.fieldName === 'alt'), 'adnotarea existentă rămâne');
  }
});

// Reguli ale sesiunii -----------------------------------------------------------------------------------

test('sesiunea este legată de utilizator și de sarcină', { timeout: 60_000 }, async () => {
  const { documentId, taskId } = await docInFlow('semnatar');

  assert.equal((await prepare('alt.semnatar', { taskId, certificatePem: secondSigner.pem })).status, 403, 'nu este titularul');
  assert.equal((await prepare('fara.token', { documentId, certificatePem: signer.pem })).status, 403, 'fără drept de semnare');
  assert.equal((await prepare('semnatar', { documentId, certificatePem: signer.pem })).status, 403, 'în flux, doar din sarcină');

  const p = await prepare('semnatar', { taskId, certificatePem: signer.pem });
  assert.equal(p.status, 200, p.text);
  const cms = await agentSign(p.body.digestHex, certIds.signer);

  // Alt utilizator, cu drept de semnare și acces la document, nu poate finaliza sesiunea.
  await db.query('INSERT INTO document_access (document_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [documentId, ids['alt.semnatar']]);
  const stolen = await complete('alt.semnatar', p.body.sessionId, { cms });
  assert.equal(stolen.status, 403);
  assert.equal((await db.one(`SELECT status FROM signing_sessions WHERE id = $1`, [p.body.sessionId])).status, 'pregatita');
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM signatures WHERE document_id = $1`, [documentId])).n, 0);

  // Identificatori invalizi sau inexistenți.
  assert.equal((await complete('semnatar', 'nu-este-uuid', { cms })).status, 404);
  assert.equal((await complete('semnatar', crypto.randomUUID(), { cms })).status, 404);

  // Sarcina s-a redirecționat între timp: semnarea nu mai poate finaliza.
  await db.query(`UPDATE tasks SET status = 'redirectionata' WHERE id = $1`, [taskId]);
  assert.equal((await complete('semnatar', p.body.sessionId, { cms })).status, 409);
  await db.query(`UPDATE tasks SET status = 'deschisa' WHERE id = $1`, [taskId]);
  // Eșecul a anulat tranzacția, deci sesiunea rămâne utilizabilă, iar fișierul pregătit există.
  const retry = await complete('semnatar', p.body.sessionId, { cms });
  assert.equal(retry.status, 200, retry.text);
});

test('sesiune expirată', { timeout: 60_000 }, async () => {
  const documentId = await addDoc('manager', await samplePdf());
  await ocr.drain();
  const p = await prepare('manager', { documentId, certificatePem: signer.pem });
  const cms = await agentSign(p.body.digestHex, certIds.signer);
  const stored = await db.one(`SELECT storage_key FROM signing_sessions WHERE id = $1`, [p.body.sessionId]);
  await db.query(`UPDATE signing_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [p.body.sessionId]);
  const r = await complete('manager', p.body.sessionId, { cms });
  assert.equal(r.status, 410);
  assert.match(r.body.message, /expirat/);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM signatures WHERE document_id = $1`, [documentId])).n, 0);
  const after = await db.one(`SELECT status, storage_key FROM signing_sessions WHERE id = $1`, [p.body.sessionId]);
  assert.equal(after.status, 'expirata');
  assert.equal(after.storage_key, null);
  await assert.rejects(storage.get(stored.storage_key), 'fișierul pregătit s-a șters');
  // A doua încercare primește același răspuns.
  assert.equal((await complete('manager', p.body.sessionId, { cms })).status, 410);
});

test('CMS respins: altă amprentă, alt certificat, conținut invalid; o versiune nouă invalidează sesiunea', { timeout: 60_000 }, async () => {
  const documentId = await addDoc('manager', await samplePdf());
  await ocr.drain();
  const p = await prepare('manager', { documentId, certificatePem: signer.pem });
  assert.equal(p.status, 200, p.text);

  // Semnat corect de agent, dar peste altă amprentă.
  const other = crypto.createHash('sha256').update('alt document').digest('hex');
  const overOther = await complete('manager', p.body.sessionId, { cms: await agentSign(other, certIds.signer) });
  assert.equal(overOther.status, 400);
  assert.match(overOther.body.message, /altă amprentă/);

  // Amprenta corectă, dar alt certificat decât cel declarat.
  const otherCert = await complete('manager', p.body.sessionId, { cms: await agentSign(p.body.digestHex, certIds.second) });
  assert.equal(otherCert.status, 400);
  assert.match(otherCert.body.message, /declarat/);

  // Semnătură alterată: messageDigest corect, valoarea semnăturii schimbată.
  const genuine = Buffer.from(await agentSign(p.body.digestHex, certIds.signer), 'base64');
  const broken = Buffer.from(genuine);
  broken[broken.length - 1] ^= 0xff;
  const invalidSig = await complete('manager', p.body.sessionId, { cms: broken.toString('base64') });
  assert.equal(invalidSig.status, 400);
  assert.match(invalidSig.body.message, /nu se verifică/);

  for (const bad of ['', 'nu este base64!', Buffer.from('gunoi').toString('base64'), Buffer.alloc(40_000).toString('base64')]) {
    assert.equal((await complete('manager', p.body.sessionId, { cms: bad })).status, 400);
  }
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM signatures WHERE document_id = $1`, [documentId])).n, 0);

  // O versiune nouă apărută între pregătire și finalizare.
  const v2 = await clients.manager.upload(`/api/documents/${documentId}/versions`, {}, 'v2.pdf', await samplePdf('A doua versiune a documentului, cu conținut schimbat între timp, peste prag.'));
  assert.equal(v2.status, 201, v2.text);
  await ocr.drain();
  const stale = await complete('manager', p.body.sessionId, { cms: genuine.toString('base64') });
  assert.equal(stale.status, 409);
  assert.match(stale.body.message, /versiune nouă/);
  assert.equal((await db.one(`SELECT status FROM signing_sessions WHERE id = $1`, [p.body.sessionId])).status, 'pregatita');
});

test('pregătirea refuză ce nu se poate semna, iar garda pentru versiuni rămâne', { timeout: 60_000 }, async () => {
  const txt = await addDoc('manager', Buffer.from('Un simplu text, fără PDF asociat.'), 'nota.txt');
  await ocr.drain();
  const refused = await prepare('manager', { documentId: txt, certificatePem: signer.pem });
  assert.equal(refused.status, 400);
  assert.match(refused.body.message, /PDF/);

  const pending = await addDoc('manager', await samplePdf());
  assert.equal((await prepare('manager', { documentId: pending, certificatePem: signer.pem })).status, 409, 'OCR în curs');
  await ocr.drain();

  assert.equal((await prepare('manager', { documentId: pending, certificatePem: expired.pem })).status, 400, 'certificat expirat');
  assert.equal((await prepare('manager', { documentId: pending, certificatePem: 'nu este certificat' })).status, 400);
  assert.equal((await prepare('manager', { documentId: pending })).status, 400);
  assert.equal((await prepare('strain', { documentId: pending, certificatePem: signer.pem })).status, 404, 'fără vizibilitate');

  // Doar citire în afara departamentului: nu poate crea versiuni, deci nici semnate.
  await db.query('INSERT INTO document_access (document_id, user_id) VALUES ($1,$2)', [pending, ids.strain]);
  assert.equal((await prepare('strain', { documentId: pending, certificatePem: signer.pem })).status, 403);

  // PDF criptat: refuzat, nu semnat pe jumătate.
  const encrypted = Buffer.from('%PDF-1.5\n1 0 obj\n<</Type/Catalog>>\nendobj\ntrailer\n<</Root 1 0 R/Encrypt 2 0 R>>\nstartxref\n9\n%%EOF\n');
  const enc = await addDoc('manager', encrypted);
  await db.query(`UPDATE document_versions SET ocr_status = 'neaplicabil' WHERE document_id = $1`, [enc]);
  const encReply = await prepare('manager', { documentId: enc, certificatePem: signer.pem });
  assert.equal(encReply.status, 400);
  assert.match(encReply.body.message, /criptat/);

  // Încărcarea obișnuită a unei versiuni în flux rămâne interzisă, iar semnătura trece pe calea ei.
  const { documentId, taskId } = await docInFlow('semnatar');
  assert.equal((await clients.semnatar.upload(`/api/documents/${documentId}/versions`, {}, 'x.pdf', await samplePdf())).status, 403);
  assert.equal((await db.one('SELECT status FROM documents WHERE id = $1', [documentId])).status, 'in_flux');
  const done = await signFully('semnatar', { taskId }, signer, certIds.signer);
  assert.equal(done.versionNo, 2);
});

test('semnătura internă rămâne: action sign pe altă sarcină, verificată ca înainte', { timeout: 60_000 }, async () => {
  const { documentId, taskId } = await docInFlow('semnatar');
  assert.equal((await clients.semnatar.post(`/api/tasks/${taskId}/action`, { action: 'approve' })).status, 400);
  assert.equal((await clients.semnatar.post(`/api/tasks/${taskId}/action`, { action: 'sign', password: 'gresita' })).status, 401);
  const r = await clients.semnatar.post(`/api/tasks/${taskId}/action`, { action: 'sign', password: PASSWORD });
  assert.equal(r.status, 200, r.text);
  const verify = await clients.semnatar.get(`/api/documents/${documentId}/signatures/verify`);
  assert.deepEqual(verify.body, [{ id: verify.body[0].id, kind: 'interna', valid: true }]);
  assert.equal((await db.one('SELECT kind FROM signatures WHERE document_id = $1', [documentId])).kind, 'interna');

  // Sarcina finalizată intern nu mai acceptă o sesiune cu certificat.
  assert.equal((await prepare('semnatar', { taskId, certificatePem: signer.pem })).status, 409);

  // Sarcina care nu este de semnare nu se poate finaliza cu certificat.
  const aviz = await docInFlow('semnatar', undefined, 'avizare');
  assert.equal((await prepare('semnatar', { taskId: aviz.taskId, certificatePem: signer.pem })).status, 400);
});

test('CHECK pe tipul semnăturii acceptă doar cele două valori și cere certificatul', async () => {
  const documentId = await addDoc('manager', await samplePdf());
  const v = await db.one('SELECT id FROM document_versions WHERE document_id = $1', [documentId]);
  await assert.rejects(db.query(
    `INSERT INTO signatures (document_id, version_id, signer_id, kind, sha256, signed_at, seal) VALUES ($1,$2,$3,'calificata','x',now(),'x')`, [documentId, v.id, ids.manager]));
  await assert.rejects(db.query(
    `INSERT INTO signatures (document_id, version_id, signer_id, kind, sha256, signed_at, seal) VALUES ($1,$2,$3,'certificat','x',now(),'x')`, [documentId, v.id, ids.manager]));
});

// Agentul -----------------------------------------------------------------------------------------------

test('agent: origine nepermisă, token lipsă sau greșit, gazdă falsă', async () => {
  const digest = '0'.repeat(64);
  const body = { certificateId: certIds.signer, digestAlgorithm: 'SHA-256', digestHex: digest };

  const evil = await agent('POST', '/sign', body, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null, 'fără CORS pentru o origine străină');
  assert.equal((await agent('GET', '/certificates', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await agent('GET', '/health', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await agent('OPTIONS', '/sign', undefined, { origin: 'https://evil.example', 'access-control-request-method': 'POST' })).headers.get('access-control-allow-origin'), null);
  // Fără Origin (nu este o pagină web de pe lista permisă).
  const noOrigin = await fetch(`${agentBase}/certificates`, { headers: { 'x-seadoc-agent-token': pairingToken } });
  assert.equal(noOrigin.status, 403);

  const missing = await fetch(`${agentBase}/certificates`, { headers: { origin: WEB_ORIGIN } });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('access-control-allow-origin'), WEB_ORIGIN);
  const wrong = await agent('POST', '/sign', body, { 'x-seadoc-agent-token': 'f'.repeat(64) });
  assert.equal(wrong.status, 401);

  const health = await fetch(`${agentBase}/health`, { headers: { origin: WEB_ORIGIN } });
  assert.equal(health.status, 200);
  assert.equal((await health.json() as Json).paired, false, 'detectabil, dar neasociat');
  assert.equal((await (await agent('GET', '/health')).json() as Json).paired, true);

  // DNS rebinding: pagina a ajuns la 127.0.0.1 printr-un nume public.
  const rebinding = await new Promise<number>((resolve, reject) => {
    const url = new URL(agentBase);
    import('node:http').then(({ default: http }) => {
      http.get({ host: url.hostname, port: url.port, path: '/health', headers: { host: 'atacator.example', origin: WEB_ORIGIN } }, (res) => { res.resume(); resolve(res.statusCode!); }).on('error', reject);
    });
  });
  assert.equal(rebinding, 403);
});

test('agent: preflight CORS și Private Network Access pentru originea permisă', async () => {
  const r = await agent('OPTIONS', '/sign', undefined, {
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type,x-seadoc-agent-token',
    'access-control-request-private-network': 'true',
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), WEB_ORIGIN);
  assert.equal(r.headers.get('access-control-allow-private-network'), 'true');
  assert.match(r.headers.get('access-control-allow-headers') ?? '', /x-seadoc-agent-token/i);
  assert.match(r.headers.get('vary') ?? '', /Origin/);
});

test('agent: ascultă doar pe interfața locală', async () => {
  const external = Object.values(os.networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4');
  if (!external) return;
  const port = new URL(agentBase).port;
  await assert.rejects(fetch(`http://${external.address}:${port}/health`, { headers: { origin: WEB_ORIGIN } }));
});

test('agent: confirmarea este a utilizatorului; parola rămâne în agent, iar o pagină străină nu poate confirma', async () => {
  const digest = crypto.createHash('sha256').update('confirmare').digest('hex');
  const start = await agent('POST', '/sign', { certificateId: certIds.signer, digestAlgorithm: 'SHA-256', digestHex: digest, label: '<script>alert(1)</script> Contract' });
  assert.equal(start.status, 202);
  const { requestId, confirmUrl } = await start.json() as Json;
  assert.equal((await (await agent('GET', `/sign/${requestId}`)).json() as Json).status, 'asteapta');
  assert.equal(new URL(confirmUrl).origin, agentBase);

  const pageRes = await fetch(confirmUrl);
  const html = await pageRes.text();
  assert.equal(pageRes.status, 200);
  assert.ok(pageRes.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
  assert.equal(pageRes.headers.get('x-frame-options'), 'DENY');
  assert.equal(pageRes.headers.get('access-control-allow-origin'), null, 'aplicația web nu poate citi pagina');
  assert.ok(!html.includes('<script>'), 'eticheta din aplicație este escapată');
  assert.ok(html.includes(digest));
  assert.match(html, /certificat de test/);
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(html)![1];

  // O pagină de pe originea permisă, chiar cu tokenul din adresă, nu poate confirma în locul utilizatorului.
  const foreign = await fetch(confirmUrl, { method: 'POST', headers: { origin: WEB_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, pin: P12_PASS, action: 'sign' }) });
  assert.equal(foreign.status, 403);
  const noCsrf = await fetch(confirmUrl, { method: 'POST', headers: { origin: agentBase, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: 'x', pin: P12_PASS, action: 'sign' }) });
  assert.equal(noCsrf.status, 403);
  assert.equal((await fetch(confirmUrl.replace(/t=.*/, 't=gresit'))).status, 404);
  assert.equal((await (await agent('GET', `/sign/${requestId}`)).json() as Json).status, 'asteapta');
  assert.equal((await (await agent('GET', `/sign/${requestId}`, undefined, { origin: 'https://evil.example' })).status), 403);

  // Parola greșită de trei ori încheie cererea, fără CMS, iar parola nu ajunge în răspunsul către aplicație.
  for (let i = 0; i < 3; i++) {
    const wrong = await fetch(confirmUrl, { method: 'POST', headers: { origin: agentBase, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, pin: 'parola-gresita-xyz', action: 'sign' }) });
    assert.equal(wrong.status, 401);
    assert.ok(!(await wrong.text()).includes('parola-gresita-xyz'));
  }
  const ended = await agent('GET', `/sign/${requestId}`);
  const endedText = await ended.text();
  assert.equal(JSON.parse(endedText).status, 'esuat');
  assert.equal(JSON.parse(endedText).cms, null);
  assert.ok(!endedText.includes('parola-gresita-xyz'));

  // Refuzul utilizatorului.
  const refused = await agent('POST', '/sign', { certificateId: certIds.signer, digestAlgorithm: 'SHA-256', digestHex: digest });
  const refusedBody = await refused.json() as Json;
  await confirmInAgent(refusedBody.confirmUrl, '', 'refuse');
  const state = await (await agent('GET', `/sign/${refusedBody.requestId}`)).json() as Json;
  assert.equal(state.status, 'refuzat');
  assert.equal(state.cms, null);

  // Doar amprente SHA-256 și doar certificate cunoscute.
  assert.equal((await agent('POST', '/sign', { certificateId: certIds.signer, digestAlgorithm: 'SHA-1', digestHex: digest })).status, 400);
  assert.equal((await agent('POST', '/sign', { certificateId: certIds.signer, digestAlgorithm: 'SHA-256', digestHex: 'xyz' })).status, 400);
  assert.equal((await agent('POST', '/sign', { certificateId: 'inexistent', digestAlgorithm: 'SHA-256', digestHex: digest })).status, 404);
});

test('agent: importul cu parolă greșită eșuează, iar configurația nu conține parole sau chei', () => {
  const file = p12File('import.p12', secondSigner, []);
  assert.throws(() => agentCli(['import-p12', file], 'gresita\n'));
  const stored = fs.readFileSync(path.join(agentHome, 'config.json'), 'utf8');
  assert.ok(!stored.includes(P12_PASS));
  assert.ok(!/PRIVATE KEY/.test(stored));
  assert.equal(fs.statSync(path.join(agentHome, 'config.json')).mode & 0o077, 0, 'configurația nu este citibilă de alții');
});

// Previzualizare ---------------------------------------------------------------------------------------------

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function drawingXml(blip: string, descr: string) {
  return `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="i" descr="${descr}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip ${blip}/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

async function hostileDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="svg" ContentType="image/svg+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://sigur.example/pagina" TargetMode="External"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://evil.example/track.png" TargetMode="External"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/bun.png"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/rau.svg"/>
<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="file:///etc/passwd" TargetMode="External"/>
</Relationships>`);
  zip.file('word/media/bun.png', PNG_1X1);
  zip.file('word/media/rau.svg', `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(2)"><script>alert(3)</script></svg>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>
<w:p><w:r><w:t>Hotărâre privind securitatea în muncă, Iași</w:t></w:r></w:p>
<w:p><w:r><w:t>&lt;script&gt;alert('text')&lt;/script&gt; &lt;img src=x onerror=alert(4)&gt;</w:t></w:r></w:p>
<w:p><w:hyperlink r:id="rId1"><w:r><w:t>legătură periculoasă</w:t></w:r></w:hyperlink></w:p>
<w:p><w:hyperlink r:id="rId2"><w:r><w:t>legătură bună</w:t></w:r></w:hyperlink></w:p>
${drawingXml('r:link="rId3"', 'externă')}
${drawingXml('r:link="rId6"', 'fișier local')}
${drawingXml('r:embed="rId5"', 'svg')}
${drawingXml('r:embed="rId4"', 'bună&quot; onerror=&quot;alert(5)')}
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Celulă</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const ALLOWED_ATTRIBUTES = new Set(['href', 'target', 'rel', 'src', 'alt', 'colspan', 'rowspan', 'scope', 'start']);

const assertNoActiveContent = (html: string) => {
  // Citit cu un analizor HTML, nu cu expresii: un atribut alt care conține „onerror=” este doar text.
  new Parser({
    onopentag(name, attribs) {
      for (const key of Object.keys(attribs)) {
        assert.ok(ALLOWED_ATTRIBUTES.has(key), `atribut nepermis ${key} pe ${name}`);
      }
    },
  }).end(html);
  assert.ok(!/<script/i.test(html), 'fără script');
  assert.ok(!/<style/i.test(html), 'fără foaie de stil');
  assert.ok(!/javascript:/i.test(html), 'fără javascript:');
  assert.ok(!/evil\.example/.test(html), 'fără imagine externă');
  assert.ok(!/etc\/passwd|root:x:/.test(html), 'fără fișier local');
  assert.ok(!/image\/svg/i.test(html), 'fără SVG');
  assert.ok(!/<svg/i.test(html));
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) assert.match(m[0], /src="data:image\/(png|jpeg|gif|webp);base64,/);
};

test('DOCX ostil: HTML curat, fără script, fără imagine externă, sub vizibilitate și audit', { timeout: 60_000 }, async () => {
  const id = await addDoc('manager', await hostileDocx(), 'ostil.docx');
  await ocr.drain();
  const r = await clients.manager.get(`/api/documents/${id}/preview`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.kind, 'html');
  assert.equal(r.body.format, 'docx');
  const html: string = r.body.html;
  assertNoActiveContent(html);
  assert.match(html, /Hotărâre privind securitatea în muncă, Iași/);
  assert.ok(html.includes('&lt;script&gt;'), 'textul care arată a cod rămâne text');
  assert.match(html, /<a href="https:\/\/sigur\.example\/pagina" target="_blank" rel="noopener noreferrer">legătură bună<\/a>/);
  assert.match(html, /legătură periculoasă/);
  assert.match(html, /<img [^>]*src="data:image\/png;base64,/, 'imaginea încorporată rămâne');
  assert.match(html, /<table>/);

  assert.equal((await clients.strain.get(`/api/documents/${id}/preview`)).status, 404, 'fără vizibilitate');
  const audit = await db.one(`SELECT count(*)::int AS n FROM audit_log WHERE document_id = $1 AND action = 'document.previzualizare'`, [id]);
  assert.equal(audit.n, 1);
  // Vizualizarea eșuată a altcuiva nu lasă urme de conținut.
  await db.query('UPDATE documents SET personal_data = true WHERE id = $1', [id]);
  await clients.manager.get(`/api/documents/${id}/preview`);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM audit_log WHERE document_id = $1 AND action = 'gdpr.acces_date_personale'`, [id])).n, 1);
});

test('lista de permisiuni a HTML-ului, direct', async () => {
  const { sanitize } = await import('../src/preview-convert.js');
  const dirty = `<p onclick="x()" style="position:fixed">ok</p><script>bad()</script><style>p{}</style><iframe src="https://x"></iframe>
<img src="https://evil.example/a.png"><img src="//evil.example/b.png"><img src="/api/auth/logout"><img src="data:image/svg+xml;base64,AAAA"><img src="data:text/html;base64,AAAA">
<img src="data:image/png;base64,AAAA" onerror="x()" alt="bun"><a href="javascript:x()">j</a><a href="data:text/html,x">d</a><a href="/api/x">r</a><a href="#ancora">a</a><a href="https://bun.example/" onclick="x()">b</a>
<svg onload="x()"><circle/></svg><math><mi>x</mi></math><object data="x"></object><embed src="x"><form action="x"><input name="p"></form><base href="https://x"><meta http-equiv="refresh" content="0"><link rel="stylesheet" href="x"><table><tr><td colspan="2" onmouseover="x()">c</td></tr></table>`;
  const clean = sanitize(dirty);
  assertNoActiveContent(clean);
  for (const tag of ['iframe', 'object', 'embed', 'form', 'input', 'base', 'meta', 'link', 'math']) assert.ok(!new RegExp(`<${tag}\\b`, 'i').test(clean), tag);
  assert.equal((clean.match(/<img\b/g) ?? []).length, 1, 'rămâne doar imaginea încorporată raster');
  assert.ok(clean.includes('<a href="https://bun.example/" target="_blank" rel="noopener noreferrer">b</a>'));
  assert.ok(clean.includes('<a>r</a>') && clean.includes('<a>a</a>') && clean.includes('<a>j</a>') && clean.includes('<a>d</a>'));
  assert.ok(clean.includes('<td colspan="2">c</td>'));
});

test('XLSX: tabele cu valorile afișate; conținutul care arată a HTML rămâne text', { timeout: 60_000 }, async () => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Plăți Iași');
  sheet.addRow(['Denumire', 'Sumă', 'Dată', 'Formulă', 'Legătură']);
  sheet.addRow(['Mașină de spălat', 1234.5, new Date(Date.UTC(2026, 0, 15)), { formula: '1+1', result: 2 }, { text: 'site', hyperlink: 'javascript:alert(1)' }]);
  sheet.addRow(['<img src=x onerror=alert(1)><script>alert(2)</script>', '=HYPERLINK("http://evil.example")', null, null, null]);
  sheet.addRow([{ richText: [{ font: { bold: true }, text: 'Text ' }, { text: 'bogat' }] }]);
  sheet.mergeCells('A6:B6');
  sheet.getCell('A6').value = 'Îmbinată';
  wb.addWorksheet('Ascunsă', { state: 'hidden' }).addRow(['secret']);
  wb.addWorksheet('Goală');
  const id = await addDoc('manager', Buffer.from(await wb.xlsx.writeBuffer()), 'plati.xlsx');
  await ocr.drain();
  const r = await clients.manager.get(`/api/documents/${id}/preview`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.format, 'xlsx');
  const html: string = r.body.html;
  assert.ok(html.includes('<h2>Plăți Iași</h2>'));
  assert.ok(html.includes('<td>Mașină de spălat</td><td>1234.5</td><td>2026-01-15</td><td>2</td><td>site</td>'), html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;'), 'HTML din celulă rămâne text');
  assert.ok(html.includes('Text bogat'));
  assert.equal((html.match(/Îmbinată/g) ?? []).length, 1);
  assert.ok(!html.includes('secret'), 'foaia ascunsă nu se afișează');
  assert.ok(html.includes('<h2>Goală</h2>'));
  assert.ok(!/<(img|script)\b/i.test(html));
  assert.ok(!/javascript:/i.test(html));
  assert.ok(!/href=/i.test(html));
});

test('XLSX mare: previzualizarea este limitată și spune asta', { timeout: 60_000 }, async () => {
  const { MAX_ROWS } = await import('../src/preview-convert.js');
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet('Mare');
  for (let i = 0; i < MAX_ROWS + 50; i++) s.addRow([`rand${i}`]);
  const id = await addDoc('manager', Buffer.from(await wb.xlsx.writeBuffer()), 'mare.xlsx');
  await ocr.drain();
  const r = await clients.manager.get(`/api/documents/${id}/preview`);
  assert.equal(r.status, 200);
  assert.equal(r.body.truncated, true);
  assert.ok(r.body.notes[0].includes(String(MAX_ROWS)));
  assert.ok(r.body.html.includes(`rand${MAX_ROWS - 1}<`));
  assert.ok(!r.body.html.includes(`rand${MAX_ROWS}<`));
});

test('PPTX: textul pe diapozitive, în ordine numerică; formatele vechi cer descărcare', { timeout: 60_000 }, async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  const slide = (lines: string[]) => `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r><a:r><a:t lang="ro"> continuare</a:t></a:r></a:p>`).join('')}</p:spTree></p:cSld></p:sld>`;
  zip.file('ppt/slides/slide1.xml', slide(['Primul diapozitiv, Iași']));
  zip.file('ppt/slides/slide2.xml', slide(['Al doilea &lt;script&gt;alert(1)&lt;/script&gt;', 'A &amp; B']));
  zip.file('ppt/slides/slide10.xml', slide(['Al zecelea']));
  const id = await addDoc('manager', await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), 'prezentare.pptx');
  await ocr.drain();
  const r = await clients.manager.get(`/api/documents/${id}/preview`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.format, 'pptx');
  const html: string = r.body.html;
  assert.ok(html.indexOf('Diapozitivul 2') < html.indexOf('Diapozitivul 10'), 'ordine numerică');
  assert.ok(html.includes('<p>Primul diapozitiv, Iași continuare</p>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('A &amp; B continuare'));
  assert.ok(r.body.notes[0].includes('doar textul'));

  for (const [name, head] of [['vechi.doc', 'D0CF11E0'], ['vechi.xls', 'D0CF11E0'], ['vechi.ppt', 'D0CF11E0']]) {
    const legacy = await addDoc('manager', Buffer.concat([Buffer.from(head, 'hex'), Buffer.alloc(600)]), name);
    await ocr.drain();
    const l = await clients.manager.get(`/api/documents/${legacy}/preview`);
    assert.equal(l.status, 200);
    assert.equal(l.body.kind, 'descarcare');
    assert.match(l.body.message, /\.doc, \.xls, \.ppt/);
  }
});

/** O arhivă cu o singură intrare care se dezarhivează enorm, iar antetul declară altceva. */
async function zipBomb(entryName: string, megabytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const deflate = zlib.createDeflateRaw({ level: 9 });
  deflate.on('data', (c) => chunks.push(c));
  const ended = new Promise((resolve) => deflate.on('end', resolve));
  const mb = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < megabytes; i++) if (!deflate.write(mb)) await new Promise((r) => deflate.once('drain', r));
  deflate.end();
  await ended;
  const data = Buffer.concat(chunks);
  const name = Buffer.from(entryName);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(1000, 22); // dimensiune declarată mincinos
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(1000, 24);
  central.writeUInt16LE(name.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}

test('bombă ZIP și arhive invalide: previzualizarea refuză curat, extragerea textului eșuează curat', { timeout: 120_000 }, async () => {
  const bomb = await zipBomb('word/document.xml', 300);
  assert.ok(bomb.length < 2 * 1024 * 1024, 'arhiva este mică');
  const before = process.memoryUsage().rss;
  const id = await addDoc('manager', bomb, 'bomba.docx');
  const r = await clients.manager.get(`/api/documents/${id}/preview`);
  assert.equal(r.status, 422);
  assert.match(r.body.message, /nu poate fi previzualizat/);
  await ocr.drain();
  const v = await db.one('SELECT ocr_status, ocr_error FROM document_versions WHERE document_id = $1', [id]);
  assert.equal(v.ocr_status, 'esuat');
  assert.match(v.ocr_error, /excesiv/);
  assert.ok(process.memoryUsage().rss - before < 250 * 1024 * 1024, 'memoria procesului rămâne mică');

  const junk = await addDoc('manager', Buffer.concat([Buffer.from('PK\x03\x04'), crypto.randomBytes(2000)]), 'gunoi.xlsx');
  const j = await clients.manager.get(`/api/documents/${junk}/preview`);
  assert.equal(j.status, 422);
  await ocr.drain();
  assert.equal((await clients.manager.get('/api/auth/me')).status, 200);
});

// TIFF și limite de OCR -------------------------------------------------------------------------------------

async function grayPage(spec: Parameters<typeof scannedPagePng>[0]) {
  const { png, width, height } = scannedPagePng(spec);
  const image = await loadImage(png);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const gray = Buffer.alloc(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = rgba[i * 4];
  return { gray, width, height };
}

/** TIFF necomprimat, în tonuri de gri, cu mai multe pagini; scris de mână, deci independent de decodor. */
function tiffFrom(pages: { gray: Buffer; width: number; height: number }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  let offset = 8;
  header.writeUInt32LE(offset, 4);
  parts.push(header);
  pages.forEach((page, index) => {
    const entries: [number, number, number, number][] = [
      [256, 4, 1, page.width], [257, 4, 1, page.height], [258, 3, 1, 8], [259, 3, 1, 1], [262, 3, 1, 1],
      [273, 4, 1, 0], [277, 3, 1, 1], [278, 4, 1, page.height], [279, 4, 1, page.gray.length],
    ];
    const ifdSize = 2 + entries.length * 12 + 4;
    const stripOffset = offset + ifdSize;
    const next = index === pages.length - 1 ? 0 : stripOffset + page.gray.length;
    const ifd = Buffer.alloc(ifdSize);
    ifd.writeUInt16LE(entries.length, 0);
    entries.forEach(([tag, type, count, value], i) => {
      const p = 2 + i * 12;
      ifd.writeUInt16LE(tag, p);
      ifd.writeUInt16LE(type, p + 2);
      ifd.writeUInt32LE(count, p + 4);
      if (type === 3) ifd.writeUInt16LE(value, p + 8);
      else ifd.writeUInt32LE(tag === 273 ? stripOffset : value, p + 8);
    });
    ifd.writeUInt32LE(next, 2 + entries.length * 12);
    parts.push(ifd, page.gray);
    offset = stripOffset + page.gray.length;
  });
  return Buffer.concat(parts);
}

test('TIFF pe două pagini: OCR, PDF căutabil, cuvinte românești, se poate semna', { timeout: 300_000 }, async () => {
  const first = await grayPage(SCANNED_SAMPLE);
  const second = await grayPage({ title: 'Procesul verbal de recepție', paragraphs: ['Comisia constată că lucrările de reparații ale tramvaiului sunt terminate. Președintele comisiei semnează procesul verbal.'] });
  const tiff = tiffFrom([first, second]);
  const documentId = await addDoc('manager', tiff, 'scanare.tiff');
  await ocr.drain();
  const v = await db.one('SELECT ocr_status, ocr_used, ocr_error, searchable_key, text_content FROM document_versions WHERE document_id = $1', [documentId]);
  assert.equal(v.ocr_status, 'finalizat', v.ocr_error);
  assert.equal(v.ocr_used, true);
  assert.ok(v.searchable_key);
  assert.match(v.text_content, /hamul de siguranță/);
  assert.match(v.text_content, /Președintele/);
  assert.ok(!/[şţŞŢ]/.test(v.text_content), 'doar diacritice cu virgulă');
  const pdf: Buffer = await storage.get(v.searchable_key);
  const pages = await pdfText(pdf);
  assert.equal(pages.length, 2);
  assert.match(pages[0], /hamul/);
  assert.match(pages[1], /tramvaiului/);
  const found = await clients.manager.get(`/api/documents?q=${encodeURIComponent('președintele')}`);
  assert.ok(found.body.items.some((d: Json) => d.id === documentId));

  const download = await clients.manager.bytes(`/api/documents/${documentId}/file?kind=searchable`);
  assert.equal(download.status, 200);
  assert.ok(download.data.equals(pdf));

  const done = await signFully('manager', { documentId }, signer, certIds.signer);
  const signed = (await clients.manager.bytes(`/api/documents/${documentId}/file?version=${done.versionNo}`)).data;
  assert.deepEqual(await pdfText(signed), pages);
});

function forgedPng(width: number, height: number) {
  const b = Buffer.from(PNG_1X1);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function forgedJpeg(width: number, height: number) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

function circularTiff() {
  const b = Buffer.alloc(8 + 2 + 12 * 2 + 4);
  b.write('II', 0, 'latin1');
  b.writeUInt16LE(42, 2);
  b.writeUInt32LE(8, 4);
  b.writeUInt16LE(2, 8);
  [[256, 100], [257, 100]].forEach(([tag, value], i) => {
    const p = 10 + i * 12;
    b.writeUInt16LE(tag, p);
    b.writeUInt16LE(4, p + 2);
    b.writeUInt32LE(1, p + 4);
    b.writeUInt32LE(value, p + 8);
  });
  b.writeUInt32LE(8, 10 + 24); // următorul director este tot el
  return b;
}

test('bombe de imagine: dimensiunile declarate opresc lucrul înainte de decodare', { timeout: 120_000 }, async () => {
  const hugeTiff = (w: number, h: number, samples = 1, bits = 8) => {
    const entries: [number, number, number][] = [[256, 4, w], [257, 4, h], [258, 3, bits], [277, 3, samples]];
    const b = Buffer.alloc(8 + 2 + entries.length * 12 + 4);
    b.write('II', 0, 'latin1');
    b.writeUInt16LE(42, 2);
    b.writeUInt32LE(8, 4);
    b.writeUInt16LE(entries.length, 8);
    entries.forEach(([tag, type, value], i) => {
      const p = 10 + i * 12;
      b.writeUInt16LE(tag, p);
      b.writeUInt16LE(type, p + 2);
      b.writeUInt32LE(1, p + 4);
      if (type === 3) b.writeUInt16LE(value, p + 8);
      else b.writeUInt32LE(value, p + 8);
    });
    return b;
  };
  const cases: [string, Buffer, RegExp][] = [
    ['mare.tiff', hugeTiff(60_000, 60_000), /megapixeli/],
    ['ingust.tiff', hugeTiff(4_000_000_000, 2), /megapixeli/],
    ['esantioane.tiff', hugeTiff(1000, 1000, 4000), /format de pixeli/],
    ['circular.tif', circularTiff(), /circulare/],
    ['mare.png', forgedPng(50_000, 50_000), /megapixeli/],
    ['mare.jpg', forgedJpeg(60_000, 60_000), /megapixeli/],
  ];
  const before = process.memoryUsage().rss;
  for (const [name, data, message] of cases) {
    const id = await addDoc('manager', data, name);
    await ocr.drain();
    const v = await db.one('SELECT ocr_status, ocr_error FROM document_versions WHERE document_id = $1', [id]);
    assert.equal(v.ocr_status, 'esuat', name);
    assert.match(v.ocr_error, message, name);
  }
  assert.ok(process.memoryUsage().rss - before < 200 * 1024 * 1024, 'memoria procesului rămâne mică');
  assert.equal((await clients.manager.get('/api/auth/me')).status, 200);
});

test('limite de pagini: TIFF și PDF scanat peste limită eșuează curat', { timeout: 120_000 }, async () => {
  const small = { gray: Buffer.alloc(400 * 400, 255), width: 400, height: 400 };
  process.env.OCR_MAX_PAGES = '2';
  try {
    const t = await addDoc('manager', tiffFrom([small, small, small]), 'pagini.tiff');
    const pdfDoc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) pdfDoc.addPage([200, 200]);
    const p = await addDoc('manager', Buffer.from(await pdfDoc.save()), 'pagini.pdf');
    await ocr.drain();
    for (const id of [t, p]) {
      const v = await db.one('SELECT ocr_status, ocr_error FROM document_versions WHERE document_id = $1', [id]);
      assert.equal(v.ocr_status, 'esuat');
      assert.match(v.ocr_error, /limit/);
    }
  } finally {
    delete process.env.OCR_MAX_PAGES;
  }
});

test('PDF cu pagină enormă: se randează cu rezoluție limitată; PDF cu flux-bombă nu ajunge la pdf.js', { timeout: 180_000 }, async () => {
  await ocr.drain();
  const huge = await PDFDocument.create();
  huge.addPage([14_400, 14_400]);
  process.env.OCR_MAX_PIXELS = '1000000';
  try {
    const id = await addDoc('manager', Buffer.from(await huge.save()), 'pagina-mare.pdf');
    const before = process.memoryUsage().rss;
    await ocr.drain();
    const v = await db.one('SELECT ocr_status, ocr_error, searchable_key FROM document_versions WHERE document_id = $1', [id]);
    assert.equal(v.ocr_status, 'finalizat', v.ocr_error);
    assert.ok(process.memoryUsage().rss - before < 400 * 1024 * 1024, 'fără pânza de 1,6 gigapixeli la 200 DPI');
  } finally {
    delete process.env.OCR_MAX_PIXELS;
  }

  // Un flux Flate de câțiva MB care se dezarhivează peste limita de 512 MB.
  const deflate = zlib.createDeflate({ level: 9 });
  const chunks: Buffer[] = [];
  deflate.on('data', (c) => chunks.push(c));
  const ended = new Promise((resolve) => deflate.on('end', resolve));
  const mb = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < 600; i++) if (!deflate.write(mb)) await new Promise((r) => deflate.once('drain', r));
  deflate.end();
  await ended;
  const compressed = Buffer.concat(chunks);
  const bomb = Buffer.concat([
    Buffer.from(`%PDF-1.7\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R>>\nendobj\n4 0 obj\n<</Filter/FlateDecode/Length ${compressed.length}>>\nstream\n`),
    compressed,
    Buffer.from('\nendstream\nendobj\ntrailer\n<</Root 1 0 R>>\nstartxref\n0\n%%EOF\n'),
  ]);
  const id = await addDoc('manager', bomb, 'bomba.pdf');
  const memory = process.memoryUsage().rss;
  await ocr.drain();
  const v = await db.one('SELECT ocr_status, ocr_error FROM document_versions WHERE document_id = $1', [id]);
  assert.equal(v.ocr_status, 'esuat');
  assert.match(v.ocr_error, /excesive/);
  assert.ok(process.memoryUsage().rss - memory < 200 * 1024 * 1024);
  assert.equal((await clients.manager.get('/api/auth/me')).status, 200);
});
