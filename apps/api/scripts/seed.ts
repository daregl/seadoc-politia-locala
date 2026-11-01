// Date demonstrative pentru SeaDoc. Totul este fictiv; pornire: `npm run seed -w apps/api` (cu `--reset` pentru refacere).
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as OTPAuth from 'otpauth';
import { ArchiveService } from '../src/archive.js';
import { AppModule } from '../src/app.module.js';
import { AuditService } from '../src/audit.js';
import { AuthService, hashPassword, PasswordPolicy, passwordProblem } from '../src/auth.js';
import { config, ROOT } from '../src/config.js';
import { Db, Queryable } from '../src/db.js';
import { DocumentsService } from '../src/documents.js';
import { OcrService } from '../src/ocr.js';
import { CurrentUser, Role } from '../src/perms.js';
import { WorkflowsController } from '../src/workflows.js';
import { buildBpmn, BpmnSpec } from './bpmn-layout.js';
import { scannedPdf, textPdf } from './pdf-tools.js';
import { RECLAMATII_KEY, SCANNED_SAMPLE, SEED_DOCUMENTS, SeedDocument } from './seed-documents.js';

const CREDENTIALS_FILE = path.join(ROOT, '.data/demo-credentials.txt');
const SAMPLES_DIR = path.join(ROOT, 'samples');
const PDF_HEADER = 'CTP Iași · document demonstrativ, date fictive';
const DEFAULT_POLICY: PasswordPolicy = { minLength: 10, requireComplexity: true, expiryDays: 180, maxFailedAttempts: 5, lockMinutes: 15 };
const DEFAULT_SETTINGS: [string, unknown][] = [
  ['password_policy', DEFAULT_POLICY],
  ['internal_networks', ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '192.168.0.0/16']],
];

const DEPARTMENTS = ['Registratură', 'Resurse Umane', 'SSM', 'Achiziții', 'Exploatare', 'Tehnic', 'IT', 'Arhivă', 'Juridic'];

interface DemoUser { username: string; fullName: string; role: Role; department: string; jobTitle: string; manages?: string; hasToken?: boolean }

// Toate numele sunt inventate pentru demonstrație.
const USERS: DemoUser[] = [
  { username: 'admin.demo', fullName: 'Radu Stănescu', role: 'admin', department: 'IT', jobTitle: 'Administrator de Sistem', manages: 'IT' },
  { username: 'director.general', fullName: 'Constantin Bălănescu', role: 'manager', department: 'Conducere', jobTitle: 'Director General', manages: 'Conducere', hasToken: true },
  { username: 'manager.ssm', fullName: 'Cătălina Moraru', role: 'manager', department: 'SSM', jobTitle: 'Șef Serviciu SSM', manages: 'SSM', hasToken: true },
  { username: 'manager.hr', fullName: 'Ștefania Lungu', role: 'manager', department: 'Resurse Umane', jobTitle: 'Șef Serviciu Resurse Umane', manages: 'Resurse Umane' },
  { username: 'manager.achizitii', fullName: 'Bogdan Țurcanu', role: 'manager', department: 'Achiziții', jobTitle: 'Șef Serviciu Achiziții', manages: 'Achiziții' },
  { username: 'manager.exploatare', fullName: 'Florin Căpraru', role: 'manager', department: 'Exploatare', jobTitle: 'Șef Serviciu Exploatare', manages: 'Exploatare' },
  { username: 'manager.tehnic', fullName: 'Iulian Pătrașcu', role: 'manager', department: 'Tehnic', jobTitle: 'Șef Serviciu Tehnic', manages: 'Tehnic' },
  { username: 'registratura.demo', fullName: 'Ana Grădinaru', role: 'registratura', department: 'Registratură', jobTitle: 'Secretar Registratură', manages: 'Registratură' },
  { username: 'arhivar.demo', fullName: 'Vasile Dăscălescu', role: 'arhivar', department: 'Arhivă', jobTitle: 'Arhivar', manages: 'Arhivă' },
  { username: 'ion.popescu', fullName: 'Ion Popescu', role: 'user', department: 'SSM', jobTitle: 'Inspector SSM' },
  { username: 'maria.ionescu', fullName: 'Maria Ionescu', role: 'user', department: 'Exploatare', jobTitle: 'Avizator Exploatare' },
  { username: 'elena.rusu', fullName: 'Elena Rusu', role: 'user', department: 'Resurse Umane', jobTitle: 'Inspector Resurse Umane' },
  { username: 'dan.tanase', fullName: 'Dan Tănase', role: 'user', department: 'Achiziții', jobTitle: 'Referent Achiziții' },
  { username: 'ioana.barsan', fullName: 'Ioana Bârsan', role: 'user', department: 'Juridic', jobTitle: 'Consilier Juridic', manages: 'Juridic' },
];

// Termenele de păstrare și codurile de nomenclator sunt ILUSTRATIVE, doar pentru demonstrație; nu reprezintă nomenclatorul real.
const DOCUMENT_TYPES: { name: string; code: string; retention: number | null; fields: { key: string; label: string; type: 'text' | 'date' | 'number'; required: boolean }[] }[] = [
  { name: 'Instrucțiune SSM', code: 'SSM-01', retention: 50, fields: [
    { key: 'cod_instructiune', label: 'Cod instrucțiune', type: 'text', required: true },
    { key: 'data_revizie', label: 'Data reviziei', type: 'date', required: false }] },
  { name: 'Fișă de instruire SSM', code: 'SSM-02', retention: 50, fields: [
    { key: 'angajat', label: 'Angajat', type: 'text', required: true },
    { key: 'tip_instruire', label: 'Tip instruire', type: 'text', required: true },
    { key: 'data_instruire', label: 'Data instruirii', type: 'date', required: true }] },
  { name: 'Proces-verbal SSM', code: 'SSM-03', retention: 10, fields: [
    { key: 'loc', label: 'Locul verificării', type: 'text', required: true },
    { key: 'data_verificare', label: 'Data verificării', type: 'date', required: true }] },
  { name: 'Cerere de concediu', code: 'RU-04', retention: 5, fields: [
    { key: 'angajat', label: 'Angajat', type: 'text', required: true },
    { key: 'data_inceput', label: 'Data de început', type: 'date', required: true },
    { key: 'data_sfarsit', label: 'Data de sfârșit', type: 'date', required: true },
    { key: 'zile', label: 'Număr de zile', type: 'number', required: true }] },
  { name: 'Contract individual de muncă', code: 'RU-01', retention: 75, fields: [
    { key: 'angajat', label: 'Angajat', type: 'text', required: true },
    { key: 'functie_angajat', label: 'Funcție', type: 'text', required: true },
    { key: 'data_angajare', label: 'Data angajării', type: 'date', required: true }] },
  { name: 'Decizie de personal', code: 'RU-02', retention: 75, fields: [
    { key: 'angajat', label: 'Angajat', type: 'text', required: true },
    { key: 'data_efect', label: 'Data de la care produce efecte', type: 'date', required: false }] },
  { name: 'Referat de necesitate', code: 'ACH-01', retention: 5, fields: [
    { key: 'categorie_valoare', label: 'Categorie de valoare (sub_prag / peste_prag)', type: 'text', required: true },
    { key: 'valoare_estimata', label: 'Valoare estimată (lei fără TVA)', type: 'number', required: true },
    { key: 'cod_cpv', label: 'Cod CPV', type: 'text', required: false }] },
  { name: 'Contract de achiziție', code: 'ACH-02', retention: 10, fields: [
    { key: 'furnizor', label: 'Furnizor', type: 'text', required: true },
    { key: 'valoare', label: 'Valoare (lei fără TVA)', type: 'number', required: false },
    { key: 'data_expirare', label: 'Data expirării', type: 'date', required: false }] },
  { name: 'Proces-verbal de recepție', code: 'ACH-03', retention: 10, fields: [
    { key: 'furnizor', label: 'Furnizor', type: 'text', required: true },
    { key: 'numar_factura', label: 'Număr factură', type: 'text', required: false }] },
  { name: 'Procedură operațională', code: 'DOC-02', retention: 10, fields: [
    { key: 'cod_procedura', label: 'Cod procedură', type: 'text', required: true },
    { key: 'revizie', label: 'Revizia', type: 'number', required: false }] },
  { name: 'Raport tehnic', code: 'TEH-01', retention: 5, fields: [
    { key: 'vehicul', label: 'Vehicul sau instalație', type: 'text', required: false }] },
  { name: 'Corespondență', code: 'REG-01', retention: 3, fields: [
    { key: 'referinta', label: 'Referință', type: 'text', required: false }] },
  // Singurul tip cu păstrare permanentă.
  { name: 'Decizie a directorului general', code: 'CON-01', retention: null, fields: [
    { key: 'numar_decizie', label: 'Număr decizie', type: 'number', required: true }] },
];

const REGISTERS: { name: string; code: string; department?: string; type?: string }[] = [
  { name: 'Registrul general', code: 'RG' },
  { name: 'Registrul SSM', code: 'SSM', department: 'SSM' },
  { name: 'Registrul Resurse Umane', code: 'RU', department: 'Resurse Umane' },
  { name: 'Registrul Achiziții', code: 'ACH', department: 'Achiziții' },
  { name: 'Registrul Exploatare', code: 'EXP', department: 'Exploatare' },
  { name: 'Registrul Tehnic', code: 'TEH', department: 'Tehnic' },
  { name: 'Registrul contractelor', code: 'CTR', type: 'Contract de achiziție' },
  { name: 'Registrul deciziilor', code: 'DEC', type: 'Decizie a directorului general' },
];

const FLOWS: { key: string; description: string; department: string; spec: BpmnSpec }[] = [
  {
    key: 'instruire-ssm',
    description: 'Două avizări în paralel, urmate de semnătura directorului general.',
    department: 'SSM',
    spec: {
      id: 'Instruire_SSM',
      name: 'Instruire SSM',
      nodes: [
        { id: 'Start', type: 'startEvent', name: 'Document depus' },
        { id: 'Split', type: 'parallelGateway', name: 'Avizare în paralel' },
        { id: 'Aviz_Inspector', type: 'userTask', name: 'Aviz Inspector SSM', assigneeType: 'functie', assignee: 'Inspector SSM', action: 'avizare', dueHours: 48 },
        { id: 'Aviz_Exploatare', type: 'userTask', name: 'Aviz Exploatare', assigneeType: 'functie', assignee: 'Avizator Exploatare', action: 'avizare', dueHours: 48 },
        { id: 'Join', type: 'parallelGateway', name: 'Avize complete' },
        { id: 'Semnare_DG', type: 'userTask', name: 'Semnare Director General', assigneeType: 'functie', assignee: 'Director General', action: 'semnare', dueHours: 72 },
        { id: 'End', type: 'endEvent', name: 'Aprobat' },
      ],
      edges: [
        { from: 'Start', to: 'Split' },
        { from: 'Split', to: 'Aviz_Inspector' },
        { from: 'Split', to: 'Aviz_Exploatare' },
        { from: 'Aviz_Inspector', to: 'Join' },
        { from: 'Aviz_Exploatare', to: 'Join' },
        { from: 'Join', to: 'Semnare_DG' },
        { from: 'Semnare_DG', to: 'End' },
      ],
    },
  },
  {
    key: 'concediu-odihna',
    description: 'Aprobarea managerului, apoi înregistrarea la Resurse Umane.',
    department: 'Resurse Umane',
    spec: {
      id: 'Concediu_Odihna',
      name: 'Concediu de odihnă',
      nodes: [
        { id: 'Start', type: 'startEvent', name: 'Cerere depusă' },
        { id: 'Aprobare_Manager', type: 'userTask', name: 'Aprobare manager', assigneeType: 'manager_departament', action: 'aprobare', dueHours: 48 },
        { id: 'Avizare_HR', type: 'userTask', name: 'Verificare Resurse Umane', assigneeType: 'functie', assignee: 'Inspector Resurse Umane', action: 'avizare', dueHours: 24 },
        { id: 'End', type: 'endEvent', name: 'Concediu aprobat' },
      ],
      edges: [
        { from: 'Start', to: 'Aprobare_Manager' },
        { from: 'Aprobare_Manager', to: 'Avizare_HR' },
        { from: 'Avizare_HR', to: 'End' },
      ],
    },
  },
  {
    key: 'referat-necesitate',
    description: 'Peste pragul intern aprobă directorul general; sub prag, șeful serviciului.',
    department: 'Achiziții',
    spec: {
      id: 'Referat_Necesitate',
      name: 'Referat de necesitate achiziții',
      nodes: [
        { id: 'Start', type: 'startEvent', name: 'Referat depus' },
        { id: 'Verificare', type: 'userTask', name: 'Verificare Referent Achiziții', assigneeType: 'functie', assignee: 'Referent Achiziții', action: 'avizare', dueHours: 48 },
        { id: 'Prag', type: 'exclusiveGateway', name: 'Valoare peste prag?' },
        { id: 'Aprobare_DG', type: 'userTask', name: 'Aprobare Director General', assigneeType: 'functie', assignee: 'Director General', action: 'aprobare', dueHours: 72 },
        { id: 'Aprobare_Sef', type: 'userTask', name: 'Aprobare șef serviciu', assigneeType: 'manager_departament', action: 'aprobare', dueHours: 48 },
        { id: 'Unire', type: 'exclusiveGateway' },
        { id: 'Informare', type: 'userTask', name: 'Informare inițiator', assigneeType: 'initiator', action: 'informare' },
        { id: 'End', type: 'endEvent', name: 'Referat aprobat' },
      ],
      edges: [
        { from: 'Start', to: 'Verificare' },
        { from: 'Verificare', to: 'Prag' },
        { from: 'Prag', to: 'Aprobare_DG', name: 'Peste prag', condition: 'categorie_valoare = peste_prag' },
        { from: 'Prag', to: 'Aprobare_Sef', name: 'Sub prag', isDefault: true },
        { from: 'Aprobare_DG', to: 'Unire' },
        { from: 'Aprobare_Sef', to: 'Unire' },
        { from: 'Unire', to: 'Informare' },
        { from: 'Informare', to: 'End' },
      ],
    },
  },
];

function refuse(message: string): never {
  console.error(message);
  process.exit(1);
}

function generatePassword(): string {
  // Respectă politica implicită: mici, mari, cifre, caracter special.
  return `Demo-${crypto.randomBytes(12).toString('base64url').replace(/[-_]/g, 'x')}-7a`;
}

async function resetDatabase(db: Db) {
  await db.tx(async (c) => {
    const tables = (await c.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`)).rows.map((r) => `"${r.tablename}"`);
    await c.query('ALTER TABLE audit_log DISABLE TRIGGER USER');
    await c.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
    await c.query('ALTER TABLE audit_log ENABLE TRIGGER USER');
    await c.query('ALTER SEQUENCE audit_log_seq RESTART');
    for (const [key, value] of DEFAULT_SETTINGS) await c.query('INSERT INTO settings (key, value) VALUES ($1,$2)', [key, JSON.stringify(value)]);
  });
  // Doar fișierele stocate de aplicație, recunoscute după nume.
  if (fs.existsSync(config.storageDir)) {
    for (const name of fs.readdirSync(config.storageDir)) {
      if (/^[a-f0-9-]{36}$/.test(name)) fs.rmSync(path.join(config.storageDir, name), { force: true });
    }
  }
}

function writeCredentials(password: string, totpSecret: string, totpUri: string) {
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
  const lines = [
    'SeaDoc - conturi demonstrative. Nu folosiți aceste date în producție.',
    '',
    `Parola comună pentru toate conturile: ${password}`,
    '',
    'Conturi:',
    ...USERS.map((u) => `  ${u.username.padEnd(20)} ${u.role.padEnd(13)} ${u.department.padEnd(15)} ${u.jobTitle}`),
    '',
    'MFA: admin.demo are autentificarea în doi pași activă; celelalte conturi nu sunt înrolate.',
    `  Secret TOTP admin.demo: ${totpSecret}`,
    `  URI otpauth: ${totpUri}`,
    '',
  ];
  fs.rmSync(CREDENTIALS_FILE, { force: true });
  fs.writeFileSync(CREDENTIALS_FILE, lines.join('\n'), { mode: 0o600 });
  fs.chmodSync(CREDENTIALS_FILE, 0o600);
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[șş]/g, 's').replace(/[țţ]/g, 't').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);

const pdfSpec = (d: SeedDocument, createdAt?: Date) => ({ title: d.title, lines: d.lines, paragraphs: d.paragraphs, header: PDF_HEADER, createdAt });

async function seedOrganisation(db: Db, password: string, totpSecret: string) {
  return db.tx(async (c) => {
    const departments = new Map<string, number>();
    const root = (await c.query('INSERT INTO departments (name) VALUES ($1) RETURNING id', ['Conducere'])).rows[0].id;
    departments.set('Conducere', root);
    for (const name of DEPARTMENTS) departments.set(name, (await c.query('INSERT INTO departments (name, parent_id) VALUES ($1,$2) RETURNING id', [name, root])).rows[0].id);

    const users = new Map<string, number>();
    for (const u of USERS) {
      const mfa = u.username === 'admin.demo';
      const id = (await c.query(
        `INSERT INTO users (username, full_name, email, password_hash, role, department_id, job_title, has_token, totp_secret, mfa_enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [u.username, u.fullName, `${u.username}@demo.seadoc.invalid`, hashPassword(password), u.role, departments.get(u.department), u.jobTitle, u.hasToken ?? false, mfa ? totpSecret : null, mfa])).rows[0].id;
      users.set(u.username, id);
    }
    for (const u of USERS) {
      if (u.manages) await c.query('UPDATE departments SET manager_id = $2 WHERE id = $1', [departments.get(u.manages), users.get(u.username)]);
    }
    // Colegii văd documentele departamentului lor printr-un acces controlat, nu prin rol.
    for (const u of USERS.filter((x) => x.role === 'user')) {
      await c.query(`INSERT INTO access_grants (user_id, scope, target_id) VALUES ($1,'department',$2)`, [users.get(u.username), departments.get(u.department)]);
    }

    const types = new Map<string, number>();
    for (const t of DOCUMENT_TYPES) {
      types.set(t.name, (await c.query(
        'INSERT INTO document_types (name, nomenclator_code, retention_years, fields) VALUES ($1,$2,$3,$4) RETURNING id',
        [t.name, t.code, t.retention, JSON.stringify(t.fields)])).rows[0].id);
    }
    const registers = new Map<string, number>();
    for (const r of REGISTERS) {
      registers.set(r.code, (await c.query(
        'INSERT INTO registers (name, code, department_id, document_type_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [r.name, r.code, r.department ? departments.get(r.department) : null, r.type ? types.get(r.type) : null])).rows[0].id);
    }
    const folders = new Map<string, number>();
    const folder = async (name: string, department: string, parent: number | null) => {
      const id = (await c.query('INSERT INTO folders (name, parent_id, department_id) VALUES ($1,$2,$3) RETURNING id', [name, parent, departments.get(department)])).rows[0].id;
      folders.set(`${department}/${name}`, id);
      return id;
    };
    const wanted = new Map<string, Set<string>>();
    for (const d of SEED_DOCUMENTS) wanted.set(d.department, (wanted.get(d.department) ?? new Set()).add(d.folder));
    for (const name of [...departments.keys()]) {
      const top = await folder(name, name, null);
      for (const sub of wanted.get(name) ?? []) await folder(sub, name, top);
    }
    return { departments, users, types, registers, folders };
  });
}

async function nextPastNumber(c: Queryable, registerId: number, code: string, year: number) {
  const n = (await c.query(
    `INSERT INTO register_counters (register_id, year, last_number) VALUES ($1,$2,1)
     ON CONFLICT (register_id, year) DO UPDATE SET last_number = register_counters.last_number + 1 RETURNING last_number`, [registerId, year])).rows[0].last_number as number;
  return { number: n, label: `${code}-${String(n).padStart(5, '0')}/${year}` };
}

async function main() {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  if (reset && process.env.NODE_ENV === 'production') refuse('--reset este interzis când NODE_ENV=production.');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const db = app.get(Db);
  const auth = app.get(AuthService);
  const audit = app.get(AuditService);
  const docs = app.get(DocumentsService);
  const ocr = app.get(OcrService);
  const archive = app.get(ArchiveService);
  const workflows = app.get(WorkflowsController);
  const close = () => app.close();

  try {
    await db.migrate();
    const existing = (await db.one('SELECT count(*)::int AS n FROM users')).n;
    if (existing > 0 && !reset) {
      await close();
      refuse(`Tabela de utilizatori are deja ${existing} rânduri. Datele nu au fost modificate. Folosiți --reset pentru a șterge totul și a reface datele demonstrative.`);
    }
    // Verificarea vine înaintea golirii bazei: o parolă respinsă nu trebuie să lase baza goală.
    const password = process.env.SEED_PASSWORD || generatePassword();
    const problem = passwordProblem(password, DEFAULT_POLICY);
    if (problem) throw new Error(`SEED_PASSWORD nu respectă politica: ${problem}`);
    if (reset) await resetDatabase(db);
    const totpSecret = new OTPAuth.Secret({ size: 20 }).base32;
    const totpUri = new OTPAuth.TOTP({ issuer: 'SeaDoc', label: 'admin.demo', secret: OTPAuth.Secret.fromBase32(totpSecret), digits: 6, period: 30 }).toString();

    const org = await seedOrganisation(db, password, totpSecret);
    writeCredentials(password, totpSecret, totpUri);
    await audit.log(null, { action: 'seed.date_demonstrative', details: { utilizatori: USERS.length, reset } });

    const actors = new Map<string, CurrentUser>();
    for (const [username, id] of org.users) actors.set(username, (await auth.loadUser(id, '127.0.0.1'))!);
    const actor = (username: string) => {
      const u = actors.get(username);
      if (!u) throw new Error(`Utilizator necunoscut în date: ${username}`);
      return u;
    };

    for (const flow of FLOWS) {
      await workflows.publish(actor('admin.demo'), {
        key: flow.key, name: flow.spec.name, description: flow.description, departmentId: org.departments.get(flow.department), xml: buildBpmn(flow.spec),
      });
    }

    const created = new Map<string, number>();
    let reclamatiiPdf: Parameters<typeof textPdf>[0] | null = null;
    for (const d of SEED_DOCUMENTS) {
      const spec = pdfSpec(d);
      if (d.key === RECLAMATII_KEY) reclamatiiPdf = spec;
      const buffer = await textPdf(spec);
      const typeId = org.types.get(d.type);
      const folderId = org.folders.get(`${d.department}/${d.folder}`);
      if (!typeId || !folderId) throw new Error(`Date incoerente pentru documentul ${d.key}`);
      // Documentele vechi primesc numărul din anul lor mai jos, ca registrul anului curent să rămână fără goluri.
      const old = d.archive?.mode === 'expired';
      const registerId = org.registers.get(d.register);
      if (!registerId) throw new Error(`Registru necunoscut: ${d.register}`);
      const due = d.dueInDays === undefined ? undefined : new Date(Date.now() + d.dueInDays * 86_400_000).toISOString().slice(0, 10);
      const r = await docs.create(actor(d.by), {
        title: d.title, direction: d.direction, registerId: old ? undefined : registerId, issuer: d.issuer, recipient: d.recipient, summary: d.summary,
        dueDate: due, documentTypeId: typeId, departmentId: org.departments.get(d.department), folderId, metadata: d.metadata ?? {}, personalData: d.personalData === true,
      }, { originalname: `${slug(d.title)}.pdf`, mimetype: 'application/pdf', buffer, size: buffer.length });
      created.set(d.key, r.id);
    }

    await ocr.drain();

    for (const d of SEED_DOCUMENTS) {
      const id = created.get(d.key)!;
      if (d.linkTo) await db.query('INSERT INTO document_links VALUES ($1,$2,$3)', [id, created.get(d.linkTo.key), d.linkTo.kind]);
      for (const username of d.favoriteBy ?? []) await db.query('INSERT INTO favorites (user_id, document_id) VALUES ($1,$2)', [org.users.get(username), id]);
    }

    // Documentele vechi: datele se dau înapoi înainte de schimbarea stării, cât declanșatorul încă permite.
    for (const d of SEED_DOCUMENTS) {
      const id = created.get(d.key)!;
      if (d.archive?.mode === 'current') {
        await archive.archive(actor('arhivar.demo'), id);
      } else if (d.archive?.mode === 'expired') {
        const year = d.archive.year;
        const type = DOCUMENT_TYPES.find((t) => t.name === d.type)!;
        const registerId = org.registers.get(d.register)!;
        await db.tx(async (c) => {
          const n = await nextPastNumber(c, registerId, d.register, year);
          const date = `${year}-03-15 10:00:00+02`;
          await c.query(
            `UPDATE documents SET created_at = $2, register_id = $3, reg_year = $4, reg_number = $5, reg_label = $6, reg_date = $2 WHERE id = $1`,
            [id, date, registerId, year, n.number, n.label]);
          await c.query('UPDATE document_versions SET created_at = $2 WHERE document_id = $1', [id, date]);
          await c.query(
            `UPDATE documents SET status = 'arhivat', closed_at = $2, archived_at = $2, retention_until = ($2::timestamptz + make_interval(years => $3::int))::date WHERE id = $1`,
            [id, `${year}-12-20 12:00:00+02`, type.retention]);
          await audit.log(actor('arhivar.demo'), { action: 'arhiva.arhivare', documentId: id, details: { numar: n.label, pastrareAni: type.retention, dateDemonstrative: true } }, c);
        });
      }
    }

    // O propunere deschisă: arhivarul a propus, iar administratorul poate decide în demonstrație.
    const proposed = created.get('arhiva-corespondenta-2021')!;
    await archive.propose(actor('arhivar.demo'), proposed, 'Termenul de păstrare de 3 ani a expirat; documentul nu mai are valoare practică.');

    fs.mkdirSync(SAMPLES_DIR, { recursive: true });
    fs.writeFileSync(path.join(SAMPLES_DIR, 'scan-instructiune-ssm.pdf'), await scannedPdf(SCANNED_SAMPLE));
    // Același text ca procedura înregistrată, dar alt fișier: duplicatul se găsește după conținut, nu după amprentă.
    fs.writeFileSync(path.join(SAMPLES_DIR, 'duplicat-procedura.pdf'), await textPdf({ ...reclamatiiPdf!, createdAt: new Date('2026-01-05T09:00:00Z') }));

    const stats = await db.one(
      `SELECT (SELECT count(*)::int FROM documents) AS documents,
              (SELECT count(*)::int FROM documents WHERE status = 'arhivat') AS archived,
              (SELECT count(*)::int FROM documents WHERE status = 'arhivat' AND retention_until < (now() AT TIME ZONE 'Europe/Bucharest')::date) AS expired,
              (SELECT count(*)::int FROM documents WHERE personal_data) AS personal,
              (SELECT count(*)::int FROM favorites) AS favorites,
              (SELECT count(*)::int FROM workflow_definitions) AS flows,
              (SELECT count(*)::int FROM document_versions WHERE ocr_status = 'finalizat') AS extracted,
              (SELECT count(*)::int FROM document_versions) AS versions,
              (SELECT count(DISTINCT document_id)::int FROM duplicate_matches WHERE match_kind = 'text') AS text_duplicates`);
    const chain = await audit.verifyChain();

    console.log([
      'Date demonstrative SeaDoc create.',
      `  Departamente: ${org.departments.size}; utilizatori: ${USERS.length}; tipuri de document: ${DOCUMENT_TYPES.length}; registre: ${REGISTERS.length}; dosare: ${org.folders.size}`,
      `  Fluxuri publicate: ${stats.flows} (${FLOWS.map((f) => f.spec.name).join(', ')})`,
      `  Documente: ${stats.documents}, din care ${stats.personal} cu date personale; text extras pentru ${stats.extracted} din ${stats.versions} versiuni; ${stats.favorites} favorite`,
      `  Arhivă: ${stats.archived} documente, ${stats.expired} cu termenul expirat; o propunere de eliminare așteaptă decizia altei persoane`,
      `  Posibile duplicate după conținut: ${stats.text_duplicates} documente`,
      `  Jurnal de audit: ${chain.ok ? 'lanț intact' : `lanț rupt la ${chain.brokenAt}`}, ${chain.checked} intrări`,
      `  Conturile și datele MFA sunt în ${path.relative(ROOT, CREDENTIALS_FILE)} (mod 600).`,
      `  Fișiere pentru demonstrație în ${path.relative(ROOT, SAMPLES_DIR)}/: scan-instructiune-ssm.pdf (scanat, căutați „hamul” după OCR), duplicat-procedura.pdf (același text ca PO-EXP-02).`,
    ].join('\n'));
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(`Seed eșuat: ${(err as Error).message}`);
  process.exit(1);
});
