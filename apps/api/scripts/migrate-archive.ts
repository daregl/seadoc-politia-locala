// Migrarea arhivei în patru pași: inventar, mapare, import cu OCR, raport de integritate.
//   npm run migrate:archive -w apps/api -- inventory <dosar> [--manifest fisier.csv] [--out inventar.csv]
//   npm run migrate:archive -w apps/api -- map <mapare.yaml> [--inventory inventar.csv]
//   npm run migrate:archive -w apps/api -- import --inventory inventar.csv --mapping mapare.yaml --root <dosar> --dry-run|--commit [--limit N] [--max-mb N]
//   npm run migrate:archive -w apps/api -- report <rulare> [--out dosar] [--recount]
// Codurile de ieșire: 0 corect, 1 eroare de utilizare sau probleme de mapare, 2 raport NECONFORM.
import fontkit from '@pdf-lib/fontkit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PDFDocument, PDFFont, rgb } from 'pdf-lib';
import YAML from 'yaml';
import { decodeCell, decodeCsv, encodeCell, parseCsv, parseDate } from '../src/csv.js';
import type { Queryable } from '../src/db.js';

const require = createRequire(import.meta.url);
const FONT_DIR = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
const SEP = ';';
const COLUMNS = ['path', 'size_bytes', 'mtime', 'extension', 'sha256', 'status', 'note', 'fields'];
const MIGRATION_USER = 'migrare.sistem';
/** Blocare de sesiune: un singur import rulează la un moment dat. */
const IMPORT_LOCK = 727020;
const DEFAULT_MAX_MB = 50;

class UsageError extends Error {}

export type InventoryStatus = 'ok' | 'refuzat_symlink' | 'ignorat_symlink_intern' | 'ignorat_special' | 'refuzat_nume' | 'eroare_citire' | 'lipsa_pe_disc' | 'hash_diferit_manifest';

export interface InventoryRow {
  path: string; size: number | null; mtime: string | null; extension: string; sha256: string | null;
  status: InventoryStatus; note: string; fields: Record<string, string>;
}

const say = (line = '') => process.stdout.write(`${line}\n`);
const shout = (line: string) => process.stderr.write(`${line}\n`);
const sha256Of = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');
const toPosix = (p: string) => p.split(path.sep).join('/');
const inside = (root: string, target: string) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

function rowToLine(r: InventoryRow): string {
  return [r.path, r.size ?? '', r.mtime ?? '', r.extension, r.sha256 ?? '', r.status, r.note, Object.keys(r.fields).length ? JSON.stringify(r.fields) : ''].map(encodeCell).join(SEP);
}

function parseInventory(text: string): InventoryRow[] {
  const table = parseCsv(text);
  const missing = COLUMNS.filter((c) => !table.columns.includes(c));
  if (missing.length) throw new UsageError(`Inventarul nu are coloanele: ${missing.join(', ')}`);
  if (table.malformed.length) throw new UsageError(`Inventarul este deteriorat la linia ${table.malformed[0].line}: ${table.malformed[0].reason}`);
  const at = Object.fromEntries(COLUMNS.map((c) => [c, table.columns.indexOf(c)]));
  const seen = new Set<string>();
  return table.rows.map(({ cells }) => {
    const cell = (name: string) => decodeCell(cells[at[name]] ?? '');
    if (seen.has(cell('path'))) throw new UsageError(`Inventarul conține de două ori calea ${cell('path')}`);
    seen.add(cell('path'));
    return {
      path: cell('path'),
      size: cell('size_bytes') === '' ? null : Number(cell('size_bytes')),
      mtime: cell('mtime') || null,
      extension: cell('extension'),
      sha256: cell('sha256') || null,
      status: cell('status') as InventoryStatus,
      note: cell('note'),
      fields: cell('fields') ? JSON.parse(cell('fields')) : {},
    };
  });
}

/** Deschide fără să urmeze un link în ultimul element al căii și hash-uiește în flux, fără să țină fișierul în memorie. */
async function hashFile(abs: string): Promise<{ sha256: string; size: number }> {
  const handle = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
    return { sha256: hash.digest('hex'), size };
  } finally {
    await handle.close();
  }
}

/** Parcurge arborele fără să urmeze niciun link simbolic. Linkurile spre exterior se raportează; cele interne ar număra de două ori. */
async function* walk(root: string): AsyncGenerator<{ rel: string; kind: 'file' } | { rel: string; kind: 'refused' | 'internal' | 'special' | 'badname'; note: string }> {
  const stack: string[] = [''];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fsp.readdir(path.join(root, dir), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const entry of entries) {
      const rel = dir ? path.join(dir, entry.name) : entry.name;
      if (entry.name.includes('�')) {
        yield { rel: toPosix(rel), kind: 'badname', note: 'Numele fișierului nu este UTF-8 valid; redenumiți-l sau montați sursa cu codarea corectă' };
      } else if (entry.isSymbolicLink()) {
        let target: string | null = null;
        try { target = await fsp.realpath(path.join(root, rel)); } catch { /* link rupt */ }
        if (target !== null && inside(root, target)) yield { rel: toPosix(rel), kind: 'internal', note: 'Link simbolic intern; ținta se numără o singură dată' };
        else yield { rel: toPosix(rel), kind: 'refused', note: target === null ? 'Link simbolic rupt' : 'Link simbolic spre exteriorul sursei: refuzat' };
      } else if (entry.isDirectory()) {
        subdirs.push(rel);
      } else if (entry.isFile()) {
        yield { rel: toPosix(rel), kind: 'file' };
      } else {
        yield { rel: toPosix(rel), kind: 'special', note: 'Nu este un fișier obișnuit' };
      }
    }
    for (const sub of subdirs.reverse()) stack.push(sub);
  }
}

interface ManifestRow { path: string; sha256: string | null; fields: Record<string, string> }

function readManifest(file: string): Map<string, ManifestRow> {
  const table = parseCsv(decodeCsv(fs.readFileSync(file)));
  if (table.malformed.length) throw new UsageError(`Manifestul are rânduri deteriorate; prima la linia ${table.malformed[0].line}: ${table.malformed[0].reason}`);
  const lower = table.columns.map((c) => c.toLowerCase());
  const pathColumn = lower.findIndex((c) => ['path', 'cale', 'fisier', 'fișier', 'file'].includes(c));
  if (pathColumn < 0) throw new UsageError('Manifestul trebuie să aibă o coloană path (sau cale, fisier, file)');
  const shaColumn = lower.findIndex((c) => ['sha256', 'hash'].includes(c));
  const out = new Map<string, ManifestRow>();
  for (const { cells } of table.rows) {
    const key = toPosix(cells[pathColumn]).replace(/^\.\//, '');
    const fields: Record<string, string> = {};
    table.columns.forEach((name, i) => { if (i !== pathColumn && i !== shaColumn && cells[i] !== '') fields[name] = cells[i]; });
    out.set(key, { path: key, sha256: shaColumn >= 0 ? cells[shaColumn].toLowerCase() || null : null, fields });
  }
  return out;
}

/** Pasul 1. Nu deschide nicio conexiune la baza de date. O rulare întreruptă reia de unde a rămas: ce are aceeași dimensiune și dată nu se mai hash-uiește. */
async function cmdInventory(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { manifest: { type: 'string' }, out: { type: 'string' } } });
  const folder = positionals[0];
  if (!folder) throw new UsageError('Indicați dosarul sursă: inventory <dosar>');
  const root = await fsp.realpath(folder);
  if (!(await fsp.stat(root)).isDirectory()) throw new UsageError(`Nu este un dosar: ${folder}`);
  const out = path.resolve(values.out ?? 'inventar.csv');
  if (inside(root, out)) throw new UsageError('Inventarul nu se scrie în dosarul sursă');
  const manifest = values.manifest ? readManifest(values.manifest) : null;

  const known = new Map<string, InventoryRow>();
  const partial = `${out}.part`;
  for (const file of [out, partial]) {
    if (!fs.existsSync(file)) continue;
    try {
      for (const row of parseInventory(fs.readFileSync(file, 'utf8'))) known.set(row.path, row);
    } catch {
      // O ultimă linie scrisă pe jumătate înseamnă doar că fișierul se hash-uiește din nou.
    }
  }
  const fd = fs.openSync(partial, 'w', 0o600);
  fs.writeSync(fd, `${COLUMNS.join(SEP)}\n`);
  const summary = { files: 0, bytes: 0, reused: 0, byType: new Map<string, { n: number; bytes: number }>(), refused: [] as InventoryRow[], other: new Map<string, number>() };
  const seen = new Set<string>();
  const emit = (row: InventoryRow) => {
    fs.writeSync(fd, `${rowToLine(row)}\n`);
    if (row.status === 'ok' || row.status === 'hash_diferit_manifest') {
      summary.files++;
      summary.bytes += row.size ?? 0;
      const t = summary.byType.get(row.extension) ?? { n: 0, bytes: 0 };
      t.n++;
      t.bytes += row.size ?? 0;
      summary.byType.set(row.extension, t);
    }
    if (row.status !== 'ok') summary.other.set(row.status, (summary.other.get(row.status) ?? 0) + 1);
    if (row.status.startsWith('refuzat') || ['eroare_citire', 'lipsa_pe_disc', 'hash_diferit_manifest'].includes(row.status)) summary.refused.push(row);
  };

  for await (const item of walk(root)) {
    seen.add(item.rel);
    const fields = manifest?.get(item.rel)?.fields ?? {};
    const ext = path.extname(item.rel).slice(1).toLowerCase();
    if (item.kind !== 'file') {
      const status: InventoryStatus = item.kind === 'refused' ? 'refuzat_symlink' : item.kind === 'internal' ? 'ignorat_symlink_intern' : item.kind === 'special' ? 'ignorat_special' : 'refuzat_nume';
      emit({ path: item.rel, size: null, mtime: null, extension: ext, sha256: null, status, note: item.note, fields });
      continue;
    }
    const abs = path.join(root, item.rel);
    try {
      const stat = await fsp.lstat(abs);
      const mtime = stat.mtime.toISOString();
      const previous = known.get(item.rel);
      let sha256: string;
      let size: number;
      if (previous?.sha256 && previous.size === stat.size && previous.mtime === mtime) {
        ({ sha256 } = previous);
        size = stat.size;
        summary.reused++;
      } else {
        ({ sha256, size } = await hashFile(abs));
      }
      const declared = manifest?.get(item.rel);
      const mismatch = !!declared?.sha256 && declared.sha256 !== sha256;
      const notes = [mismatch ? `Manifestul declară ${declared!.sha256}` : '', manifest && !declared ? 'Nu apare în manifest' : ''].filter(Boolean).join('; ');
      emit({ path: item.rel, size, mtime, extension: ext, sha256, status: mismatch ? 'hash_diferit_manifest' : 'ok', note: notes, fields });
    } catch (err) {
      emit({ path: item.rel, size: null, mtime: null, extension: ext, sha256: null, status: 'eroare_citire', note: String((err as Error).message).slice(0, 300), fields });
    }
  }
  if (manifest) {
    for (const row of manifest.values()) {
      if (!seen.has(row.path)) emit({ path: row.path, size: null, mtime: null, extension: path.extname(row.path).slice(1).toLowerCase(), sha256: row.sha256, status: 'lipsa_pe_disc', note: 'Apare în manifest, dar nu există pe disc', fields: row.fields });
    }
  }
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(partial, out);

  say(`Inventar: ${out}`);
  say(`Fișiere: ${summary.files}, ${(summary.bytes / 1024 / 1024).toFixed(1)} MB${summary.reused ? ` (${summary.reused} preluate din rularea anterioară)` : ''}`);
  for (const [ext, t] of [...summary.byType.entries()].sort((a, b) => b[1].n - a[1].n)) say(`  .${ext || '(fără extensie)'}: ${t.n} fișiere, ${(t.bytes / 1024 / 1024).toFixed(1)} MB`);
  for (const [status, n] of summary.other) say(`  stare ${status}: ${n}`);
  for (const row of summary.refused.slice(0, 50)) shout(`ATENȚIE ${row.status}: ${row.path} (${row.note})`);
  return 0;
}

// Mapare -----------------------------------------------------------------------

const SET_KEYS = ['documentType', 'register', 'department', 'title', 'direction', 'regNumber', 'regYear', 'regDate', 'regLabel', 'issuer', 'recipient', 'summary', 'personalData', 'metadata'] as const;
type SetKey = typeof SET_KEYS[number];
type RuleSet = Partial<Record<Exclude<SetKey, 'metadata'>, string>> & { metadata?: Record<string, string> };

interface Rule { index: number; folder: RegExp | null; pattern: RegExp | null; ext: string[] | null; skip: boolean; set: RuleSet }
export interface Mapping { source: string; defaults: RuleSet; rules: Rule[] }

function globToRegex(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`, 'iu');
}

function cleanSet(raw: unknown, where: string, problems: string[]): RuleSet {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) { problems.push(`${where}: trebuie să fie un obiect`); return {}; }
  const out: RuleSet = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(SET_KEYS as readonly string[]).includes(key)) { problems.push(`${where}: câmp necunoscut „${key}”`); continue; }
    if (key === 'metadata') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) { problems.push(`${where}.metadata: trebuie să fie un obiect`); continue; }
      out.metadata = Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, String(v)]));
    } else if (value !== null && value !== undefined) {
      out[key as Exclude<SetKey, 'metadata'>] = String(value);
    }
  }
  return out;
}

export function loadMapping(file: string): { mapping: Mapping; sha256: string; problems: string[] } {
  const text = fs.readFileSync(file, 'utf8');
  const problems: string[] = [];
  let raw: any;
  try {
    raw = /\.json$/i.test(file) ? JSON.parse(text) : YAML.parse(text);
  } catch (err) {
    throw new UsageError(`Fișierul de mapare nu se poate citi: ${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new UsageError('Fișierul de mapare trebuie să fie un obiect');
  for (const key of Object.keys(raw)) if (!['source', 'defaults', 'rules'].includes(key)) problems.push(`Câmp necunoscut: „${key}”`);
  if (typeof raw.source !== 'string' || !raw.source.trim()) problems.push('Lipsește „source”: numele sursei, care identifică fișierele la o nouă rulare');
  if (!Array.isArray(raw.rules) || !raw.rules.length) problems.push('Lipsește lista „rules”');
  const rules: Rule[] = [];
  (Array.isArray(raw.rules) ? raw.rules : []).forEach((r: any, i: number) => {
    const where = `Regula ${i + 1}`;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) { problems.push(`${where}: trebuie să fie un obiect`); return; }
    for (const key of Object.keys(r)) if (!['match', 'skip', 'set'].includes(key)) problems.push(`${where}: câmp necunoscut „${key}”`);
    const match = r.match ?? {};
    for (const key of Object.keys(match)) if (!['folder', 'pattern', 'ext'].includes(key)) problems.push(`${where}.match: câmp necunoscut „${key}”`);
    let pattern: RegExp | null = null;
    if (match.pattern !== undefined) {
      try { pattern = new RegExp(String(match.pattern), 'iu'); } catch (err) { problems.push(`${where}: expresie invalidă: ${(err as Error).message}`); }
    }
    rules.push({
      index: i + 1,
      folder: match.folder !== undefined ? globToRegex(String(match.folder)) : null,
      pattern,
      ext: match.ext !== undefined ? (Array.isArray(match.ext) ? match.ext : [match.ext]).map((e: unknown) => String(e).toLowerCase().replace(/^\./, '')) : null,
      skip: r.skip === true,
      set: cleanSet(r.set, `${where}.set`, problems),
    });
  });
  return { mapping: { source: String(raw.source ?? '').trim(), defaults: cleanSet(raw.defaults, 'defaults', problems), rules }, sha256: sha256Of(text), problems };
}

interface Refs {
  types: Map<string, { id: number; name: string; fields: { key: string; label: string; type?: string; required?: boolean }[] }>;
  registers: Map<string, { id: number; code: string; name: string }>;
  departments: Map<string, { id: number; name: string }>;
}

const lookupKey = (s: string) => s.trim().toLowerCase();

async function loadRefs(db: Queryable): Promise<Refs> {
  const rows = async (sql: string) => (await db.query(sql)).rows as any[];
  const registers = new Map<string, any>();
  for (const r of await rows('SELECT id, code, name FROM registers')) {
    registers.set(lookupKey(r.code), r);
    registers.set(lookupKey(r.name), r);
  }
  return {
    types: new Map((await rows('SELECT id, name, fields FROM document_types')).map((t) => [lookupKey(t.name), t])),
    registers,
    departments: new Map((await rows('SELECT id, name FROM departments')).map((d) => [lookupKey(d.name), d])),
  };
}

export interface ItemPlan {
  title: string; typeId: number; departmentId: number; registerId: number | null; registerCode: string | null;
  regNumber: number | null; regYear: number | null; regDate: string | null; regLabel: string | null;
  direction: string; issuer: string | null; recipient: string | null; summary: string | null; personalData: boolean; metadata: Record<string, string>;
}

type PlanOutcome = { kind: 'skip'; rule: number } | { kind: 'unmatched' } | { kind: 'problems'; problems: string[] } | { kind: 'plan'; plan: ItemPlan; warnings: string[] };

function planItem(row: InventoryRow, mapping: Mapping, refs: Refs): PlanOutcome {
  const rel = row.path;
  const base = path.posix.basename(rel);
  const ext = path.posix.extname(base).slice(1).toLowerCase();
  let groups: Record<string, string> | undefined;
  const rule = mapping.rules.find((r) => {
    if (r.folder && !r.folder.test(rel)) return false;
    if (r.ext && !r.ext.includes(ext)) return false;
    if (r.pattern) {
      const m = r.pattern.exec(rel);
      if (!m) return false;
      groups = m.groups as Record<string, string> | undefined;
    }
    return true;
  });
  if (!rule) return { kind: 'unmatched' };
  if (rule.skip) return { kind: 'skip', rule: rule.index };
  const parts = rel.split('/');
  const vars: Record<string, string> = {
    ...row.fields,
    ...(groups ?? {}),
    path: rel, filename: base, stem: base.slice(0, base.length - path.posix.extname(base).length), ext,
    folder: parts.slice(0, -1).join('/'), parent: parts.at(-2) ?? '', top: parts.length > 1 ? parts[0] : '', mtime: (row.mtime ?? '').slice(0, 10),
  };
  const problems: string[] = [];
  const warnings: string[] = [];
  const render = (template: string | undefined): string | null => {
    if (template === undefined) return null;
    const value = template.replace(/\{([^{}]+)\}/g, (_, name: string) => {
      if (!Object.hasOwn(vars, name)) { problems.push(`Câmp lipsă în sursă: {${name}}`); return ''; }
      return vars[name] ?? '';
    });
    return value.trim() === '' ? null : value.trim();
  };
  const merged: RuleSet = { ...mapping.defaults, ...rule.set, metadata: { ...mapping.defaults.metadata, ...rule.set.metadata } };

  const typeName = render(merged.documentType);
  const type = typeName ? refs.types.get(lookupKey(typeName)) : undefined;
  if (!typeName) problems.push('Lipsește tipul de document');
  else if (!type) problems.push(`Tip de document inexistent: ${typeName}`);
  const departmentName = render(merged.department);
  const department = departmentName ? refs.departments.get(lookupKey(departmentName)) : undefined;
  if (!departmentName) problems.push('Lipsește departamentul');
  else if (!department) problems.push(`Departament inexistent: ${departmentName}`);
  const registerName = render(merged.register);
  const register = registerName ? refs.registers.get(lookupKey(registerName)) : undefined;
  if (registerName && !register) problems.push(`Registru inexistent: ${registerName}`);

  const title = render(merged.title) ?? vars.stem;
  const direction = render(merged.direction) ?? 'intern';
  if (!['intrat', 'iesit', 'intern'].includes(direction)) problems.push(`Tip de înregistrare invalid: ${direction}`);

  const rawNumber = render(merged.regNumber);
  let regNumber: number | null = null;
  if (rawNumber !== null) {
    regNumber = /^\d{1,9}$/.test(rawNumber) ? Number(rawNumber) : null;
    if (!regNumber) problems.push(`Număr de registru invalid: ${rawNumber}`);
  }
  const rawDate = render(merged.regDate);
  const regDate = rawDate ? parseDate(rawDate) : null;
  if (rawDate && !regDate) problems.push(`Dată de registru invalidă: ${rawDate}`);
  const rawYear = render(merged.regYear);
  let regYear: number | null = regDate ? Number(regDate.slice(0, 4)) : null;
  if (rawYear !== null) {
    regYear = /^\d{4}$/.test(rawYear) && Number(rawYear) >= 1900 && Number(rawYear) <= 2100 ? Number(rawYear) : null;
    if (regYear === null) problems.push(`An de registru invalid: ${rawYear}`);
    else if (regDate && Number(regDate.slice(0, 4)) !== regYear) warnings.push(`Anul registrului ${regYear} diferă de anul datei ${regDate}`);
  }
  const regLabelRaw = render(merged.regLabel);
  if (register && regNumber === null && !regLabelRaw) problems.push('Registrul cere un număr (regNumber) sau o etichetă (regLabel)');
  if (regNumber !== null && !register) problems.push('Numărul de registru cere un registru');
  if (regNumber !== null && !regYear) problems.push('Numărul de registru cere un an (regYear) sau o dată (regDate)');
  if ((regNumber !== null || regLabelRaw) && !regDate) problems.push('Numărul de registru cere data înregistrării (regDate)');
  const regLabel = regLabelRaw ?? (register && regNumber !== null && regYear ? `${register.code}-${String(regNumber).padStart(5, '0')}/${regYear}` : null);

  const metadata: Record<string, string> = {};
  const declared = type?.fields ?? [];
  for (const [key, template] of Object.entries(merged.metadata ?? {})) {
    const value = render(template);
    if (type && !declared.some((f) => f.key === key)) problems.push(`Câmp de metadate necunoscut pentru „${type.name}”: ${key}`);
    if (value) metadata[key] = value;
  }
  for (const field of declared) {
    const value = metadata[field.key];
    if (field.required && !value) problems.push(`Lipsește câmpul obligatoriu „${field.label}”`);
    if (value && field.type === 'number' && !Number.isFinite(Number(value))) problems.push(`Câmpul „${field.label}” trebuie să fie un număr: ${value}`);
    if (value && field.type === 'date') {
      const iso = parseDate(value);
      if (!iso) problems.push(`Câmpul „${field.label}” trebuie să fie o dată: ${value}`);
      else metadata[field.key] = iso;
    }
  }
  const personalRaw = render(merged.personalData);
  if (problems.length) return { kind: 'problems', problems };
  return {
    kind: 'plan',
    warnings,
    plan: {
      title, typeId: type!.id, departmentId: department!.id, registerId: register?.id ?? null, registerCode: register?.code ?? null,
      regNumber, regYear, regDate, regLabel, direction, issuer: render(merged.issuer), recipient: render(merged.recipient), summary: render(merged.summary),
      personalData: ['true', 'da', '1'].includes((personalRaw ?? '').toLowerCase()), metadata,
    },
  };
}

/** Eroare de mapare care nu depinde de fișier: un tip sau un departament scris greșit direct în regulă. */
function checkLiterals(mapping: Mapping, refs: Refs): string[] {
  const out: string[] = [];
  const check = (value: string | undefined, table: Map<string, unknown>, what: string, where: string) => {
    if (value !== undefined && !value.includes('{') && !table.has(lookupKey(value))) out.push(`${where}: ${what} inexistent: ${value}`);
  };
  const sets: [RuleSet, string][] = [[mapping.defaults, 'defaults'], ...mapping.rules.map((r): [RuleSet, string] => [r.set, `Regula ${r.index}`])];
  for (const [set, where] of sets) {
    check(set.documentType, refs.types, 'tip de document', where);
    check(set.department, refs.departments, 'departament', where);
    check(set.register, refs.registers, 'registru', where);
  }
  return out;
}

async function openServices() {
  const { Db } = await import('../src/db.js');
  const db = new Db();
  const present = await db.one(`SELECT to_regclass('public.migration_runs') AS t`);
  if (!present?.t) {
    await db.pool.end();
    throw new UsageError('Tabelele de migrare lipsesc. Porniți serverul actualizat o dată, ca să aplice migrările.');
  }
  return db;
}

/** Ocupările unui număr, căutate în documentele deja înregistrate. */
async function findCollision(c: Queryable, plan: ItemPlan): Promise<{ id: number; reg_label: string } | undefined> {
  if (plan.registerId !== null && plan.regNumber !== null) {
    const r = (await c.query('SELECT id, reg_label FROM documents WHERE register_id = $1 AND reg_year = $2 AND reg_number = $3', [plan.registerId, plan.regYear, plan.regNumber])).rows[0];
    if (r) return r;
  }
  if (plan.regLabel) return (await c.query('SELECT id, reg_label FROM documents WHERE reg_label = $1 LIMIT 1', [plan.regLabel])).rows[0];
  return undefined;
}

/** Pasul 2. Doar citește din baza de date. */
async function cmdMap(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { inventory: { type: 'string' }, mapping: { type: 'string' } } });
  const file = positionals[0] ?? values.mapping;
  if (!file) throw new UsageError('Indicați fișierul de mapare: map <mapare.yaml> [--inventory inventar.csv]');
  const { mapping, problems } = loadMapping(file);
  const db = await openServices();
  try {
    const refs = await loadRefs(db);
    problems.push(...checkLiterals(mapping, refs));
    const perType = new Map<string, number>();
    let planned = 0;
    let skipped = 0;
    const warnings: string[] = [];
    if (values.inventory) {
      const rows = parseInventory(fs.readFileSync(values.inventory, 'utf8'));
      const taken = new Map<string, string>();
      for (const row of rows) {
        if (row.status !== 'ok') {
          if (!row.status.startsWith('ignorat')) problems.push(`${row.path}: ${row.status} (${row.note})`);
          continue;
        }
        const outcome = planItem(row, mapping, refs);
        if (outcome.kind === 'unmatched') problems.push(`${row.path}: nicio regulă nu se potrivește`);
        else if (outcome.kind === 'problems') for (const p of outcome.problems) problems.push(`${row.path}: ${p}`);
        else if (outcome.kind === 'skip') skipped++;
        else {
          planned++;
          for (const w of outcome.warnings) warnings.push(`${row.path}: ${w}`);
          const { plan } = outcome;
          const typeName = [...refs.types.values()].find((t) => t.id === plan.typeId)!.name;
          perType.set(typeName, (perType.get(typeName) ?? 0) + 1);
          const key = plan.regLabel;
          if (key) {
            if (taken.has(key)) problems.push(`${row.path}: numărul ${key} apare și la ${taken.get(key)}`);
            taken.set(key, row.path);
          }
          const existing = await findCollision(db, plan);
          if (existing) problems.push(`${row.path}: numărul ${existing.reg_label} există deja în documentul ${existing.id}`);
        }
      }
      say(`Fișiere mapate: ${planned}, excluse prin regulă: ${skipped}`);
      for (const [name, n] of perType) say(`  ${name}: ${n}`);
    }
    for (const w of warnings.slice(0, 200)) shout(`ATENȚIE ${w}`);
    if (problems.length) {
      shout(`Maparea are ${problems.length} probleme:`);
      for (const p of problems.slice(0, 500)) shout(`  ${p}`);
      if (problems.length > 500) shout(`  … și încă ${problems.length - 500}`);
      return 1;
    }
    say('Maparea este validă. Nu s-a importat nimic.');
    return 0;
  } finally {
    await db.pool.end();
  }
}

// Import -----------------------------------------------------------------------

const ITEM_FAILED = new Set(['esuat', 'coliziune', 'refuzat']);

async function migrationUser(db: Queryable): Promise<{ id: number; username: string }> {
  const { NO_LOCAL_PASSWORD } = await import('../src/ldap-client.js');
  // Cont tehnic inactiv: deține documentele importate și nu se poate autentifica pe nicio cale.
  return (await db.query(
    `INSERT INTO users (username, full_name, password_hash, role, active) VALUES ($1,'Migrare arhivă',$2,'user',false)
     ON CONFLICT (username) DO UPDATE SET active = false RETURNING id, username`, [MIGRATION_USER, NO_LOCAL_PASSWORD])).rows[0];
}

async function cmdImport(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      inventory: { type: 'string' }, mapping: { type: 'string' }, root: { type: 'string' }, 'dry-run': { type: 'boolean' }, commit: { type: 'boolean' },
      limit: { type: 'string' }, 'max-mb': { type: 'string' },
    },
  });
  if (!values.inventory || !values.mapping || !values.root) throw new UsageError('import cere --inventory, --mapping și --root');
  if (!!values['dry-run'] === !!values.commit) throw new UsageError('Alegeți exact una dintre opțiunile --dry-run și --commit');
  const commit = !!values.commit;
  const limit = values.limit ? Number(values.limit) : Infinity;
  const maxBytes = (values['max-mb'] ? Number(values['max-mb']) : DEFAULT_MAX_MB) * 1024 * 1024;
  if (!(limit > 0) || !(maxBytes > 0)) throw new UsageError('--limit și --max-mb trebuie să fie pozitive');

  const inventoryText = fs.readFileSync(values.inventory, 'utf8');
  const rows = parseInventory(inventoryText);
  const { mapping, sha256: mappingSha, problems } = loadMapping(values.mapping);
  const root = await fsp.realpath(values.root);

  const db = await openServices();
  const lock = await db.pool.connect();
  try {
    const refs = await loadRefs(db);
    problems.push(...checkLiterals(mapping, refs));
    if (problems.length) {
      shout(`Maparea are ${problems.length} probleme. Rulați comanda map. Prima: ${problems[0]}`);
      return 1;
    }
    if (!(await lock.query('SELECT pg_try_advisory_lock($1) AS ok', [IMPORT_LOCK])).rows[0].ok) {
      shout('Un alt import rulează în acest moment.');
      return 1;
    }
    const { StorageService } = await import('../src/storage.js');
    const { AuditService } = await import('../src/audit.js');
    const { detectMime } = await import('../src/documents.js');
    const storage = new StorageService();
    await storage.onModuleInit();
    const audit = new AuditService(db);
    const dbName = (await db.one('SELECT current_database() AS n'))!.n;
    say(`Bază de date: ${dbName}. Mod: ${commit ? 'import' : 'simulare, fără modificări'}.`);
    const actor = commit ? await migrationUser(db) : null;
    const operator = process.env.SUDO_USER ?? os.userInfo().username;

    // Blocarea de mai sus arată că rulările rămase „în curs” au murit fără să se încheie.
    await db.query(`UPDATE migration_runs SET status = 'intrerupt', finished_at = now() WHERE status = 'in_curs'`);
    const run = (await db.one(
      `INSERT INTO migration_runs (source_name, source_root, inventory_file, inventory_sha256, mapping_sha256, mode, operator)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [mapping.source, root, path.resolve(values.inventory), sha256Of(inventoryText), mappingSha, commit ? 'import' : 'simulare', operator]))!.id as number;
    say(`Rulare: ${run}`);
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await db.query(
        `INSERT INTO migration_items (run_id, source_name, rel_path, size_bytes, sha256)
         SELECT $1, $2, p, s, h FROM unnest($3::text[], $4::bigint[], $5::text[]) AS t(p, s, h)`,
        [run, mapping.source, chunk.map((r) => r.path), chunk.map((r) => r.size), chunk.map((r) => r.sha256)]);
    }

    let stop = false;
    const onSignal = () => { stop = true; shout('Oprire cerută; se termină fișierul curent. Reluați cu aceeași comandă.'); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    const counts: Record<string, number> = { inventar: rows.length };
    const bump = (status: string) => { counts[status] = (counts[status] ?? 0) + 1; };
    const setItem = async (rel: string, status: string, extra: { documentId?: number | null; versionId?: number | null; regLabel?: string | null; detail?: string | null } = {}, client: Queryable = db) => {
      await client.query(
        `UPDATE migration_items SET status = $3, document_id = $4, version_id = $5, reg_label = $6, detail = $7, updated_at = now() WHERE run_id = $1 AND rel_path = $2`,
        [run, rel, status, extra.documentId ?? null, extra.versionId ?? null, extra.regLabel ?? null, extra.detail ?? null]);
    };
    const failItem = async (rel: string, status: 'esuat' | 'coliziune' | 'refuzat', detail: string, regLabel: string | null = null) => {
      await setItem(rel, status, { detail: detail.slice(0, 1000), regLabel });
      bump(status);
      // Doar eșecurile ajung în jurnal câte unul: succesele ar ține blocată scrierea în lanțul de audit la fiecare fișier.
      if (commit) await audit.log({ id: actor!.id, username: actor!.username }, { action: 'migrare.element_esuat', details: { rulare: run, cale: rel, stare: status, motiv: detail.slice(0, 500) } });
    };

    const seenLabels = new Map<string, string>();
    for (const row of rows) {
      // --limit numără fișierele scrise, pentru o rulare de probă; intrările refuzate sau sărite nu consumă din el.
      if (stop || (counts.importat ?? 0) + (counts.simulat ?? 0) >= limit) break;
      if (row.status !== 'ok') {
        if (row.status.startsWith('ignorat')) {
          await setItem(row.path, 'ignorat', { detail: row.note });
          bump('ignorat');
        } else {
          await failItem(row.path, 'refuzat', `${row.status}: ${row.note}`);
        }
        continue;
      }
      const outcome = planItem(row, mapping, refs);
      if (outcome.kind === 'skip') {
        await setItem(row.path, 'ignorat', { detail: `Exclus de regula ${outcome.rule}` });
        bump('ignorat');
        continue;
      }
      if (outcome.kind === 'unmatched') { await failItem(row.path, 'esuat', 'Nicio regulă de mapare nu se potrivește'); continue; }
      if (outcome.kind === 'problems') { await failItem(row.path, 'esuat', outcome.problems.join('; ')); continue; }
      const { plan } = outcome;

      // Ce s-a importat deja din această sursă nu se mai atinge; asta face reluarea sigură.
      const previous = await db.one(
        `SELECT sha256, document_id, version_id, reg_label, run_id FROM migration_items WHERE source_name = $1 AND rel_path = $2 AND status = 'importat' ORDER BY id DESC LIMIT 1`,
        [mapping.source, row.path]);
      if (previous && previous.sha256 === row.sha256) {
        await setItem(row.path, 'sarit', { documentId: previous.document_id, versionId: previous.version_id, regLabel: previous.reg_label, detail: `Importat la rularea ${previous.run_id}` });
        bump('sarit');
        continue;
      }
      if (previous) {
        await failItem(row.path, 'esuat', `Conținut diferit față de importul din rularea ${previous.run_id} (document ${previous.document_id}); nu se suprascrie`, previous.reg_label);
        continue;
      }

      const abs = path.join(root, ...row.path.split('/'));
      let data: Buffer | null = null;
      let mime = '';
      try {
        const real = await fsp.realpath(abs);
        if (!inside(root, real) || real !== abs) throw new Error('Calea a devenit link simbolic după inventar');
        if (commit) {
          const handle = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try {
            const { size } = await handle.stat();
            if (size > maxBytes) throw new Error(`Fișierul depășește limita de ${maxBytes / 1024 / 1024} MB (--max-mb)`);
            data = await handle.readFile();
          } finally {
            await handle.close();
          }
          const actual = sha256Of(data);
          if (actual !== row.sha256) throw new Error(`Hash diferit față de inventar: ${actual}`);
          mime = detectMime({ originalname: path.posix.basename(row.path), mimetype: '', buffer: data, size: data.length }, path.posix.basename(row.path));
        } else {
          const { sha256: actual, size } = await hashFile(abs);
          if (actual !== row.sha256) throw new Error(`Hash diferit față de inventar: ${actual}`);
          if (size > maxBytes) throw new Error(`Fișierul depășește limita de ${maxBytes / 1024 / 1024} MB (--max-mb)`);
          const head = Buffer.alloc(Math.min(size, 65536));
          const handle = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try { await handle.read(head, 0, head.length, 0); } finally { await handle.close(); }
          detectMime({ originalname: path.posix.basename(row.path), mimetype: '', buffer: head, size }, path.posix.basename(row.path));
        }
      } catch (err) {
        const e = err as { getResponse?: () => { message?: string }; message: string };
        await failItem(row.path, 'esuat', e.getResponse?.().message ?? e.message);
        continue;
      }

      if (plan.regLabel && seenLabels.has(plan.regLabel)) {
        await failItem(row.path, 'coliziune', `Numărul ${plan.regLabel} apare și la ${seenLabels.get(plan.regLabel)}`, plan.regLabel);
        continue;
      }
      const existing = await findCollision(db, plan);
      if (existing) {
        await failItem(row.path, 'coliziune', `Numărul ${existing.reg_label} există deja în documentul ${existing.id}; nu se renumerotează`, existing.reg_label);
        continue;
      }
      if (plan.regLabel) seenLabels.set(plan.regLabel, row.path);
      if (!commit) {
        await setItem(row.path, 'simulat', { regLabel: plan.regLabel });
        bump('simulat');
        continue;
      }

      const key = await storage.put(data!);
      try {
        await db.tx(async (c) => {
          const doc = (await c.query(
            `INSERT INTO documents (title, direction, register_id, reg_number, reg_year, reg_label, reg_date, issuer, recipient, summary,
               document_type_id, department_id, owner_id, metadata, personal_data)
             VALUES ($1,$2,$3,$4,$5,$6,($7::date)::timestamp AT TIME ZONE 'Europe/Bucharest',$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
            [plan.title, plan.direction, plan.registerId, plan.regNumber, plan.regYear, plan.regLabel, plan.regDate, plan.issuer, plan.recipient, plan.summary,
              plan.typeId, plan.departmentId, actor!.id, JSON.stringify(plan.metadata), plan.personalData])).rows[0];
          // Rândul cu ocr_status = 'in_asteptare' este chiar coada OCR a serverului.
          const version = (await c.query(
            `INSERT INTO document_versions (document_id, version_no, filename, mime, size_bytes, sha256, storage_key, created_by)
             VALUES ($1,1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [doc.id, path.posix.basename(row.path), mime, data!.length, row.sha256, key, actor!.id])).rows[0];
          // Numerele noi din registrul curent nu pot ajunge peste cele istorice.
          if (plan.registerId !== null && plan.regNumber !== null) {
            await c.query(
              `INSERT INTO register_counters (register_id, year, last_number) VALUES ($1,$2,$3)
               ON CONFLICT (register_id, year) DO UPDATE SET last_number = GREATEST(register_counters.last_number, excluded.last_number)`,
              [plan.registerId, plan.regYear, plan.regNumber]);
          }
          await setItem(row.path, 'importat', { documentId: doc.id, versionId: version.id, regLabel: plan.regLabel }, c);
        });
        bump('importat');
      } catch (err) {
        await storage.remove(key);
        const code = (err as { code?: string }).code;
        // Cineva a ocupat numărul între verificare și scriere.
        if (code === '23505') await failItem(row.path, 'coliziune', `Numărul ${plan.regLabel} a fost ocupat în timpul importului`, plan.regLabel);
        else await failItem(row.path, 'esuat', `Eroare la scriere: ${(err as Error).message}`);
      }
      if ((counts.importat ?? 0) % 50 === 0 && counts.importat) say(`  ${counts.importat} importate…`);
    }

    const pending = (await db.one(`SELECT count(*)::int AS n FROM migration_items WHERE run_id = $1 AND status = 'in_asteptare'`, [run]))!.n;
    counts.neprocesate = pending;
    const status = pending > 0 ? 'intrerupt' : 'finalizat';
    await db.tx(async (c) => {
      await c.query(`UPDATE migration_runs SET status = $2, finished_at = now(), counts = $3 WHERE id = $1`, [run, status, JSON.stringify(counts)]);
      await audit.log(actor ? { id: actor.id, username: actor.username } : null, {
        action: commit ? 'migrare.import' : 'migrare.simulare',
        details: { rulare: run, sursa: mapping.source, stare: status, operator, ...counts },
      }, c);
    });
    say(`Rulare ${run}: ${status}. ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    await lock.query('SELECT pg_advisory_unlock($1)', [IMPORT_LOCK]);
    const failures = (counts.esuat ?? 0) + (counts.coliziune ?? 0) + (counts.refuzat ?? 0);
    if (failures) {
      shout(`${failures} fișiere nu s-au importat. Vedeți raportul: report ${run}`);
      return 1;
    }
    return 0;
  } finally {
    lock.release();
    await db.pool.end();
  }
}

// Raport -----------------------------------------------------------------------

interface ReportSummary {
  run: number; source: string; root: string; mode: string; runStatus: string; startedAt: string; finishedAt: string | null; operator: string | null;
  sourceFiles: number; imported: number; skipped: number; excluded: number; failed: number; collisions: number; refused: number; pending: number;
  verified: number; matched: number; mismatched: number; eliminated: number; recount: number | null;
  ocr: Record<string, number>; conform: boolean; reasons: string[]; csvSha256?: string; inventorySha256: string; generatedAt: string;
}

async function cmdReport(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { out: { type: 'string' }, recount: { type: 'boolean' } } });
  const runId = Number(positionals[0]);
  if (!Number.isInteger(runId)) throw new UsageError('Indicați numărul rulării: report <rulare>');
  const db = await openServices();
  try {
    const run = await db.one('SELECT * FROM migration_runs WHERE id = $1', [runId]);
    if (!run) throw new UsageError(`Rularea ${runId} nu există`);
    if (run.mode !== 'import') throw new UsageError(`Rularea ${runId} este o simulare: nu are fișiere stocate de verificat`);
    const { StorageService } = await import('../src/storage.js');
    const { AuditService } = await import('../src/audit.js');
    const storage = new StorageService();
    await storage.onModuleInit();
    const audit = new AuditService(db);

    const outDir = path.resolve(values.out ?? 'raport-migrare');
    await fsp.mkdir(outDir, { recursive: true });
    const csvPath = path.join(outDir, `raport-migrare-${runId}.csv`);
    const pdfPath = path.join(outDir, `raport-migrare-${runId}.pdf`);

    const tally: Record<string, number> = {};
    const problems: { path: string; status: string; detail: string }[] = [];
    let verified = 0;
    let matched = 0;
    let mismatched = 0;
    let eliminated = 0;
    let nonFiles = 0;
    let refusedFiles = 0;
    const ocr: Record<string, number> = {};
    const csvLines: string[] = [];
    const header = ['Cale', 'Dimensiune', 'SHA-256 inventar', 'SHA-256 recalculat', 'Stare', 'Verificare', 'Număr registru', 'Document', 'Detalii'];
    csvLines.push(header.map(encodeCell).join(SEP));

    let lastId = 0;
    for (;;) {
      const batch = (await db.query(
        `SELECT i.*, v.storage_key, v.sha256 AS version_sha, v.ocr_status, d.status AS document_status
         FROM migration_items i LEFT JOIN document_versions v ON v.id = i.version_id LEFT JOIN documents d ON d.id = i.document_id
         WHERE i.run_id = $1 AND i.id > $2 ORDER BY i.id LIMIT 200`, [runId, lastId])).rows;
      if (!batch.length) break;
      for (const item of batch) {
        lastId = item.id;
        tally[item.status] = (tally[item.status] ?? 0) + 1;
        if (item.status === 'ignorat' && item.sha256 === null) nonFiles++;
        if (item.status === 'refuzat' && /^(hash_diferit_manifest|eroare_citire):/.test(item.detail ?? '')) refusedFiles++;
        let verifiedSha: string | null = null;
        let verify: 'ok' | 'nepotrivire' | 'eliminat' | null = null;
        let detail: string = item.detail ?? '';
        if (item.status === 'importat' || item.status === 'sarit') {
          verified++;
          if (!item.version_id) {
            verify = 'nepotrivire';
            detail = 'Versiunea documentului lipsește';
          } else if (!item.storage_key) {
            if (item.document_status === 'eliminat') {
              verify = 'eliminat';
              eliminated++;
              detail = 'Eliminat legal după termenul de păstrare';
            } else {
              verify = 'nepotrivire';
              detail = 'Documentul nu mai are fișier stocat';
            }
          } else {
            try {
              verifiedSha = sha256Of(await storage.get(item.storage_key));
              if (verifiedSha !== item.sha256) { verify = 'nepotrivire'; detail = 'Fișierul stocat diferă de inventar'; }
              else if (item.version_sha !== item.sha256) { verify = 'nepotrivire'; detail = `Baza de date declară alt hash: ${item.version_sha}`; }
              else verify = 'ok';
            } catch (err) {
              verify = 'nepotrivire';
              // AES-GCM refuză orice octet modificat, deci un fișier alterat ajunge aici.
              detail = `Fișierul stocat nu se poate citi sau decripta: ${(err as Error).message}`;
            }
          }
          if (verify === 'ok') matched++;
          if (verify === 'nepotrivire') { mismatched++; problems.push({ path: item.rel_path, status: 'nepotrivire hash', detail }); }
          if (item.ocr_status) ocr[item.ocr_status] = (ocr[item.ocr_status] ?? 0) + 1;
          await db.query('UPDATE migration_items SET verify_status = $2, verified_sha256 = $3 WHERE id = $1', [item.id, verify, verifiedSha]);
        } else if (ITEM_FAILED.has(item.status)) {
          problems.push({ path: item.rel_path, status: item.status, detail });
        } else if (item.status === 'in_asteptare') {
          problems.push({ path: item.rel_path, status: 'neprocesat', detail: 'Rularea s-a oprit înainte de acest fișier' });
        }
        csvLines.push([item.rel_path, item.size_bytes ?? '', item.sha256 ?? '', verifiedSha ?? '', item.status, verify ?? '', item.reg_label ?? '', item.document_id ?? '', detail].map(encodeCell).join(SEP));
      }
    }

    // „Fișiere în sursă” = fișierele obișnuite din inventar. Linkurile și fișierele speciale nu au conținut de numărat.
    const refused = tally.refuzat ?? 0;
    const excluded = (tally.ignorat ?? 0) - nonFiles;
    const sourceFiles = Object.entries(tally).filter(([s]) => s !== 'refuzat').reduce((a, [, n]) => a + n, 0) - nonFiles;
    const accounted = (tally.importat ?? 0) + (tally.sarit ?? 0) + excluded + (tally.esuat ?? 0) + (tally.coliziune ?? 0);
    const pending = tally.in_asteptare ?? 0;
    const reasons: string[] = [];
    if (mismatched) reasons.push(`${mismatched} fișiere nu corespund inventarului`);
    if (tally.esuat) reasons.push(`${tally.esuat} fișiere eșuate`);
    if (tally.coliziune) reasons.push(`${tally.coliziune} coliziuni de număr`);
    if (refused) reasons.push(`${refused} intrări refuzate din inventar`);
    if (pending) reasons.push(`${pending} fișiere neprocesate: rularea nu s-a încheiat`);
    if (accounted + pending !== sourceFiles) reasons.push(`Contabilizare greșită: ${accounted + pending} din ${sourceFiles}`);
    const declaredInventory = Number(run.counts?.inventar ?? -1);
    if (declaredInventory >= 0 && declaredInventory !== sourceFiles + refused + nonFiles) reasons.push(`Inventarul avea ${declaredInventory} intrări, rularea are ${sourceFiles + refused + nonFiles}`);
    // Inventarul folosit la import trebuie să fie același; dacă a dispărut între timp, rămâne cel înregistrat în rulare.
    if (run.inventory_file && fs.existsSync(run.inventory_file) && sha256Of(fs.readFileSync(run.inventory_file, 'utf8')) !== run.inventory_sha256) {
      reasons.push('Fișierul de inventar s-a schimbat după import');
    }

    let recount: number | null = null;
    if (values.recount) {
      recount = 0;
      try {
        for await (const entry of walk(await fsp.realpath(run.source_root))) if (entry.kind === 'file') recount++;
        if (recount !== sourceFiles + refusedFiles) reasons.push(`Sursa are acum ${recount} fișiere, inventarul are ${sourceFiles + refusedFiles}`);
      } catch (err) {
        reasons.push(`Sursa nu se poate renumăra: ${(err as Error).message}`);
      }
    }

    const summary: ReportSummary = {
      run: runId, source: run.source_name, root: run.source_root, mode: run.mode, runStatus: run.status,
      startedAt: new Date(run.started_at).toISOString(), finishedAt: run.finished_at ? new Date(run.finished_at).toISOString() : null, operator: run.operator,
      sourceFiles, imported: tally.importat ?? 0, skipped: tally.sarit ?? 0, excluded, failed: tally.esuat ?? 0, collisions: tally.coliziune ?? 0, refused, pending,
      verified, matched, mismatched, eliminated, recount, ocr, conform: reasons.length === 0, reasons, inventorySha256: run.inventory_sha256, generatedAt: new Date().toISOString(),
    };

    const csv = `﻿${csvLines.join('\r\n')}\r\n`;
    summary.csvSha256 = sha256Of(csv);
    const pdf = await reportPdf(summary, problems);
    await fsp.writeFile(csvPath, csv, { mode: 0o600 });
    await fsp.writeFile(pdfPath, pdf, { mode: 0o600 });

    const csvKey = await storage.put(Buffer.from(csv));
    const pdfKey = await storage.put(pdf);
    await db.tx(async (c) => {
      await c.query(
        `UPDATE migration_runs SET report = $2, report_ok = $3, report_at = now(), report_csv_key = $4, report_pdf_key = $5 WHERE id = $1`,
        [runId, JSON.stringify({ ...summary, problems: problems.slice(0, 200), problemsTotal: problems.length }), summary.conform, csvKey, pdfKey]);
      await audit.log(null, {
        action: 'migrare.raport',
        details: { rulare: runId, conform: summary.conform, operator: process.env.SUDO_USER ?? os.userInfo().username, importate: summary.imported, sarite: summary.skipped, esuate: summary.failed, nepotriviri: mismatched, motive: reasons.slice(0, 20) },
      }, c);
    });
    if (run.report_csv_key) await storage.remove(run.report_csv_key);
    if (run.report_pdf_key) await storage.remove(run.report_pdf_key);

    say(`Fișiere în sursă: ${sourceFiles}; importate: ${summary.imported}; sărite: ${summary.skipped}; excluse: ${summary.excluded}; eșuate: ${summary.failed}; coliziuni: ${summary.collisions}; refuzate: ${refused}; neprocesate: ${pending}`);
    say(`Hash-uri recalculate: ${verified}; potrivite: ${matched}; nepotrivite: ${mismatched}`);
    say(`Raport: ${csvPath}`);
    say(`Raport: ${pdfPath}`);
    if (!summary.conform) {
      shout('');
      shout(`*** RAPORT NECONFORM pentru rularea ${runId} ***`);
      for (const r of reasons) shout(`  - ${r}`);
      for (const p of problems.slice(0, 50)) shout(`  ${p.status}: ${p.path} ${p.detail}`);
      if (problems.length > 50) shout(`  … și încă ${problems.length - 50}, în CSV`);
      return 2;
    }
    say(`Raport CONFORM pentru rularea ${runId}.`);
    return 0;
  } finally {
    await db.pool.end();
  }
}

/** Raportul de predare, de tipărit și semnat. Fiecare pagină poartă rularea, numărul paginii și amprenta CSV-ului complet. */
async function reportPdf(s: ReportSummary, problems: { path: string; status: string; detail: string }[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(path.join(FONT_DIR, 'DejaVuSans.ttf')), { subset: true });
  const bold = await doc.embedFont(fs.readFileSync(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf')), { subset: true });
  doc.setTitle(`Raport de integritate, rularea ${s.run}`);
  doc.setCreator('SeaDoc');
  const A4 = { width: 595.28, height: 841.89 };
  const margin = 50;
  const ink = rgb(0.08, 0.08, 0.08);
  let page = doc.addPage([A4.width, A4.height]);
  let y = A4.height - margin;
  const fresh = () => { page = doc.addPage([A4.width, A4.height]); y = A4.height - margin; };
  const need = (h: number) => { if (y - h < margin + 24) fresh(); };
  const wrap = (text: string, f: PDFFont, size: number, width: number) => {
    const out: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
      // Căile și hash-urile lungi nu au spații: se rup pe caractere.
      let piece = word;
      while (f.widthOfTextAtSize(piece, size) > width) {
        let cut = piece.length - 1;
        while (cut > 1 && f.widthOfTextAtSize(piece.slice(0, cut), size) > width) cut--;
        if (line) { out.push(line); line = ''; }
        out.push(piece.slice(0, cut));
        piece = piece.slice(cut);
      }
      const next = line ? `${line} ${piece}` : piece;
      if (line && f.widthOfTextAtSize(next, size) > width) { out.push(line); line = piece; } else line = next;
    }
    if (line) out.push(line);
    return out;
  };
  const para = (text: string, size = 10, f = font, gap = 3, color = ink) => {
    for (const line of wrap(text, f, size, A4.width - margin * 2)) {
      need(size * 1.4);
      page.drawText(line, { x: margin, y: y - size, size, font: f, color });
      y -= size * 1.4;
    }
    y -= gap;
  };
  const row = (label: string, value: string) => {
    const lines = wrap(value, font, 10, A4.width - margin * 2 - 210);
    need(lines.length * 14 + 2);
    page.drawText(label, { x: margin, y: y - 10, size: 10, font, color: rgb(0.3, 0.3, 0.3) });
    lines.forEach((line, i) => page.drawText(line, { x: margin + 210, y: y - 10 - i * 14, size: 10, font: bold, color: ink }));
    y -= lines.length * 14 + 2;
  };
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' }) : '—');

  para('Raport de integritate a migrării arhivei', 16, bold, 4);
  para('SeaDoc · Fișiere numărate, hash-uri comparate, erori listate', 9.5, font, 12, rgb(0.3, 0.3, 0.3));

  const boxHeight = 40;
  need(boxHeight + 10);
  const tone = s.conform ? rgb(0.07, 0.42, 0.22) : rgb(0.72, 0.09, 0.09);
  page.drawRectangle({ x: margin, y: y - boxHeight, width: A4.width - margin * 2, height: boxHeight, borderColor: tone, borderWidth: 1.5 });
  page.drawText(s.conform ? 'CONFORM' : 'NECONFORM', { x: margin + 12, y: y - 27, size: 17, font: bold, color: tone });
  y -= boxHeight + 10;
  for (const reason of s.reasons) para(`• ${reason}`, 10, font, 1, tone);
  y -= 8;

  para('Rulare', 11.5, bold, 4);
  row('Număr rulare', String(s.run));
  row('Sursă', s.source);
  row('Dosar sursă', s.root);
  row('Operator', s.operator ?? '—');
  row('Pornită', when(s.startedAt));
  row('Încheiată', when(s.finishedAt));
  row('Raport generat', when(s.generatedAt));
  y -= 8;

  para('Fișiere', 11.5, bold, 4);
  row('Numărate în sursă (inventar)', String(s.sourceFiles));
  if (s.recount !== null) row('Renumărate acum în sursă', String(s.recount));
  row('Importate în această rulare', String(s.imported));
  row('Importate anterior (sărite)', String(s.skipped));
  row('Excluse prin mapare', String(s.excluded));
  row('Eșuate', String(s.failed));
  row('Coliziuni de număr', String(s.collisions));
  row('Refuzate din inventar', String(s.refused));
  row('Neprocesate', String(s.pending));
  y -= 8;

  para('Hash-uri SHA-256 recalculate din stocarea decriptată', 11.5, bold, 4);
  row('Verificate', String(s.verified));
  row('Identice cu inventarul', String(s.matched));
  row('Diferite sau ilizibile', String(s.mismatched));
  if (s.eliminated) row('Eliminate legal', String(s.eliminated));
  row('Amprentă inventar', s.inventorySha256);
  row('Amprentă raport CSV', s.csvSha256 ?? '—');
  if (Object.keys(s.ocr).length) row('Stare OCR', Object.entries(s.ocr).map(([k, v]) => `${k}: ${v}`).join(', '));
  y -= 8;

  if (problems.length) {
    para(`Erori (${problems.length})`, 11.5, bold, 4);
    const limit = 300;
    for (const p of problems.slice(0, limit)) para(`${p.status} · ${p.path}${p.detail ? ` · ${p.detail}` : ''}`, 8.5, font, 2);
    if (problems.length > limit) para(`Încă ${problems.length - limit} erori se găsesc în raportul CSV.`, 9, bold, 4);
    y -= 8;
  } else {
    para('Nu există erori.', 10, font, 10);
  }

  need(150);
  para('Semnături la recepție', 11.5, bold, 18);
  const columnWidth = (A4.width - margin * 2 - 30) / 2;
  const signY = y;
  [['Am predat,', 0], ['Am primit,', columnWidth + 30]].forEach(([title, offset]) => {
    const x = margin + (offset as number);
    page.drawText(title as string, { x, y: signY - 10, size: 10, font: bold, color: ink });
    for (const [i, label] of ['Nume și funcție', 'Data', 'Semnătura'].entries()) {
      const lineY = signY - 44 - i * 34;
      page.drawText(label, { x, y: lineY + 4, size: 8, font, color: rgb(0.35, 0.35, 0.35) });
      page.drawLine({ start: { x: x + 70, y: lineY + 2 }, end: { x: x + columnWidth, y: lineY + 2 }, thickness: 0.6, color: rgb(0.3, 0.3, 0.3) });
    }
  });

  const total = doc.getPageCount();
  doc.getPages().forEach((p, i) => {
    p.drawText(`Rularea ${s.run} · ${s.conform ? 'CONFORM' : 'NECONFORM'} · CSV ${(s.csvSha256 ?? '').slice(0, 16)}… · pagina ${i + 1} din ${total}`, { x: margin, y: 28, size: 7.5, font, color: rgb(0.4, 0.4, 0.4) });
  });
  return Buffer.from(await doc.save());
}

const USAGE = `Comenzi:
  inventory <dosar> [--manifest fisier.csv] [--out inventar.csv]
  map <mapare.yaml|mapare.json> [--inventory inventar.csv]
  import --inventory inventar.csv --mapping mapare.yaml --root <dosar> --dry-run|--commit [--limit N] [--max-mb N]
  report <rulare> [--out dosar] [--recount]`;

async function main(): Promise<number> {
  // `npm run -w apps/api` schimbă dosarul curent; căile relative se citesc față de locul de unde a fost lansată comanda.
  if (process.env.INIT_CWD) process.chdir(process.env.INIT_CWD);
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'inventory': return cmdInventory(rest);
    case 'map': return cmdMap(rest);
    case 'import': return cmdImport(rest);
    case 'report': return cmdReport(rest);
    default:
      shout(USAGE);
      return 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    const code = String((err as NodeJS.ErrnoException).code ?? '');
    shout(err instanceof UsageError || code.startsWith('ERR_PARSE_ARGS') || code === 'ENOENT' ? `Eroare: ${(err as Error).message}` : String((err as Error).stack ?? err));
    process.exitCode = 1;
  });
}
