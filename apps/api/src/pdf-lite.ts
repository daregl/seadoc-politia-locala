// Citire minimă a structurii PDF, fără dependențe: obiecte, fluxuri de obiecte, trailer.
// Se folosește pentru semnături, deci pe fișiere ostile: adâncime, număr de obiecte și volumul
// dezarhivat sunt limitate, iar orice eroare de sintaxă este o excepție, nu o stare ciudată.
import zlib from 'node:zlib';

export class PdfError extends Error {}

export interface PdfName { k: 'name'; name: string }
export interface PdfNum { k: 'num'; v: number; raw: string }
export interface PdfRef { k: 'ref'; num: number; gen: number }
/** `start`/`end` sunt pozițiile delimitatorilor în fișier (end = după `>` sau `)`). */
export interface PdfStr { k: 'str'; hex: boolean; raw: Buffer; start: number; end: number }
export interface PdfDict { k: 'dict'; map: Map<string, PdfValue> }
export type PdfValue = PdfName | PdfNum | PdfRef | PdfStr | PdfDict | PdfValue[] | boolean | null;

export const MAX_DEPTH = 48;
const MAX_OBJECTS = 500_000;
const MAX_CONTAINER_ITEMS = 1_000_000;
const OBJSTM_BUDGET = 64 * 1024 * 1024;

const isWs = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = (c: number) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
const isHex = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const INT = /^[+-]?\d+$/;
const REAL = /^[+-]?(\d+\.?\d*|\.\d+)$/;

export class Lexer {
  constructor(readonly b: Buffer, public p = 0, readonly end = b.length) {}

  skip() {
    const { b, end } = this;
    while (this.p < end) {
      const c = b[this.p];
      if (isWs(c)) { this.p++; continue; }
      if (c === 37) { // comentariu
        while (this.p < end && b[this.p] !== 10 && b[this.p] !== 13) this.p++;
        continue;
      }
      return;
    }
  }

  private word(): string {
    const s = this.p;
    while (this.p < this.end && !isWs(this.b[this.p]) && !isDelim(this.b[this.p])) this.p++;
    return this.b.toString('latin1', s, this.p);
  }

  startsWith(text: string): boolean {
    return this.p + text.length <= this.end && this.b.toString('latin1', this.p, this.p + text.length) === text;
  }

  value(depth = 0): PdfValue {
    if (depth > MAX_DEPTH) throw new PdfError('Structură PDF prea adâncă');
    this.skip();
    if (this.p >= this.end) throw new PdfError('Sfârșit neașteptat');
    const c = this.b[this.p];
    if (c === 60) return this.b[this.p + 1] === 60 ? this.dict(depth) : this.hexString();
    if (c === 40) return this.literalString();
    if (c === 47) return this.name();
    if (c === 91) return this.array(depth);
    const w = this.word();
    if (!w) throw new PdfError('Simbol neașteptat');
    if (INT.test(w)) {
      // `N G R` este o referință; altfel, un număr obișnuit.
      const save = this.p;
      this.skip();
      const g = this.word();
      if (/^\d+$/.test(g)) {
        this.skip();
        if (this.b[this.p] === 82 /* R */ && (this.p + 1 >= this.end || isWs(this.b[this.p + 1]) || isDelim(this.b[this.p + 1]))) {
          this.p++;
          return { k: 'ref', num: Number(w), gen: Number(g) };
        }
      }
      this.p = save;
      return { k: 'num', v: Number(w), raw: w };
    }
    if (REAL.test(w)) return { k: 'num', v: Number(w), raw: w };
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    throw new PdfError(`Simbol necunoscut în PDF`);
  }

  private name(): PdfName {
    this.p++;
    const s = this.p;
    while (this.p < this.end && !isWs(this.b[this.p]) && !isDelim(this.b[this.p])) this.p++;
    const raw = this.b.toString('latin1', s, this.p);
    return { k: 'name', name: raw.includes('#') ? raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : raw };
  }

  private array(depth: number): PdfValue[] {
    this.p++;
    const out: PdfValue[] = [];
    for (;;) {
      this.skip();
      if (this.p >= this.end) throw new PdfError('Listă neterminată');
      if (this.b[this.p] === 93) { this.p++; return out; }
      if (out.length >= MAX_CONTAINER_ITEMS) throw new PdfError('Listă prea mare');
      out.push(this.value(depth + 1));
    }
  }

  private dict(depth: number): PdfDict {
    this.p += 2;
    const map = new Map<string, PdfValue>();
    for (;;) {
      this.skip();
      if (this.p >= this.end) throw new PdfError('Dicționar neterminat');
      if (this.b[this.p] === 62 && this.b[this.p + 1] === 62) { this.p += 2; return { k: 'dict', map }; }
      if (this.b[this.p] !== 47) throw new PdfError('Cheie invalidă în dicționar');
      if (map.size >= MAX_CONTAINER_ITEMS) throw new PdfError('Dicționar prea mare');
      const key = this.name().name;
      map.set(key, this.value(depth + 1));
    }
  }

  private hexString(): PdfStr {
    const start = this.p++;
    while (this.p < this.end && this.b[this.p] !== 62) {
      const c = this.b[this.p];
      if (!isHex(c) && !isWs(c)) throw new PdfError('Șir hexazecimal invalid');
      this.p++;
    }
    if (this.p >= this.end) throw new PdfError('Șir hexazecimal neterminat');
    this.p++;
    return { k: 'str', hex: true, raw: this.b.subarray(start, this.p), start, end: this.p };
  }

  private literalString(): PdfStr {
    const start = this.p++;
    let depth = 1;
    while (this.p < this.end && depth > 0) {
      const c = this.b[this.p++];
      if (c === 92) this.p++;
      else if (c === 40) depth++;
      else if (c === 41) depth--;
    }
    if (depth > 0) throw new PdfError('Șir neterminat');
    return { k: 'str', hex: false, raw: this.b.subarray(start, this.p), start, end: this.p };
  }
}

export const isDict = (v: PdfValue | undefined): v is PdfDict => !!v && typeof v === 'object' && !Array.isArray(v) && v.k === 'dict';
export const isRef = (v: PdfValue | undefined): v is PdfRef => !!v && typeof v === 'object' && !Array.isArray(v) && v.k === 'ref';
export const isStr = (v: PdfValue | undefined): v is PdfStr => !!v && typeof v === 'object' && !Array.isArray(v) && v.k === 'str';
export const isNum = (v: PdfValue | undefined): v is PdfNum => !!v && typeof v === 'object' && !Array.isArray(v) && v.k === 'num';
export const isName = (v: PdfValue | undefined, name?: string): v is PdfName =>
  !!v && typeof v === 'object' && !Array.isArray(v) && v.k === 'name' && (name === undefined || v.name === name);

/** Octeții unui șir PDF, după decodare. */
export function strBytes(s: PdfStr): Buffer {
  if (s.hex) {
    let hex = s.raw.toString('latin1', 1, s.raw.length - 1).replace(/[^0-9a-fA-F]/g, '');
    if (hex.length % 2) hex += '0';
    return Buffer.from(hex, 'hex');
  }
  const body = s.raw.subarray(1, s.raw.length - 1);
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== 92) { out.push(c); continue; }
    const n = body[++i];
    if (n === undefined) break;
    const simple: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
    if (n in simple) out.push(simple[n]);
    else if (n >= 48 && n <= 55) {
      let v = n - 48;
      for (let d = 0; d < 2 && body[i + 1] >= 48 && body[i + 1] <= 55; d++) v = v * 8 + (body[++i] - 48);
      out.push(v & 255);
    } else if (n === 13) { if (body[i + 1] === 10) i++; } else if (n !== 10) out.push(n);
  }
  return Buffer.from(out);
}

/** Text dintr-un șir PDF: UTF-16BE cu BOM, UTF-8 cu BOM, altfel latin1 (aproximarea PDFDocEncoding). */
export function strText(s: PdfStr): string {
  const b = strBytes(s);
  if (b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le');
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.toString('utf8', 3);
  return b.toString('latin1');
}

export function serialize(v: PdfValue): string {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (Array.isArray(v)) return `[${v.map(serialize).join(' ')}]`;
  switch (v.k) {
    case 'name': return `/${encodeName(v.name)}`;
    case 'num': return v.raw;
    case 'ref': return `${v.num} ${v.gen} R`;
    case 'str': return v.raw.toString('latin1');
    case 'dict': return `<<${[...v.map].map(([key, value]) => `/${encodeName(key)} ${serialize(value)}`).join(' ')}>>`;
  }
}

function encodeName(name: string): string {
  return name.replace(/[^\x21-\x7e]|[#()<>[\]{}/%]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export const num = (v: number): PdfNum => ({ k: 'num', v, raw: String(v) });
export const ref = (n: number, gen = 0): PdfRef => ({ k: 'ref', num: n, gen });
export const name = (n: string): PdfName => ({ k: 'name', name: n });
export const dict = (entries: Record<string, PdfValue> = {}): PdfDict => ({ k: 'dict', map: new Map(Object.entries(entries)) });
export const literal = (text: string): PdfStr => {
  const raw = Buffer.from(`(${text.replace(/[\\()]/g, '\\$&')})`, 'latin1');
  return { k: 'str', hex: false, raw, start: -1, end: -1 };
};

export interface PdfObject {
  num: number;
  gen: number;
  value: PdfValue;
  /** Ordinea din fișier: obiectul cu poziția cea mai mare este cel în vigoare. */
  pos: number;
  /** Poziția cuvântului `obj` și sfârșitul obiectului; -1 pentru obiectele din fluxuri de obiecte. */
  start: number;
  end: number;
  stream?: { start: number; end: number };
  compressed: boolean;
}

export interface ParsedPdf {
  bytes: Buffer;
  objects: Map<number, PdfObject>;
  /** Toate obiectele de pe nivelul de sus, inclusiv cele înlocuite prin revizii ulterioare. */
  topLevel: PdfObject[];
  trailer: Map<string, PdfValue>;
  startxref: number | null;
  xrefKind: 'tabel' | 'flux' | null;
  syntaxErrors: number;
  /** Fluxuri de obiecte care nu s-au putut citi (criptate, alt filtru, peste buget). */
  unreadObjectStreams: number;
  maxObjectNumber: number;
  encrypted: boolean;
}

function digitsBefore(b: Buffer, from: number): { value: string; pos: number } | null {
  let p = from;
  while (p >= 0 && b[p] >= 48 && b[p] <= 57) p--;
  if (p === from || from - p > 10) return null;
  return { value: b.toString('latin1', p + 1, from + 1), pos: p };
}

/** Citește antetul `N G` din fața cuvântului `obj` de la poziția dată. */
function objectHeader(b: Buffer, objPos: number): { num: number; gen: number; start: number } | null {
  let p = objPos - 1;
  if (p < 0 || !isWs(b[p])) return null;
  while (p >= 0 && isWs(b[p])) p--;
  const g = digitsBefore(b, p);
  if (!g) return null;
  p = g.pos;
  if (p < 0 || !isWs(b[p])) return null;
  while (p >= 0 && isWs(b[p])) p--;
  const n = digitsBefore(b, p);
  if (!n) return null;
  if (n.pos >= 0 && !isWs(b[n.pos]) && !isDelim(b[n.pos])) return null;
  return { num: Number(n.value), gen: Number(g.value), start: n.pos + 1 };
}

function streamEnd(b: Buffer, start: number, length: PdfValue | undefined): number {
  if (isNum(length) && Number.isInteger(length.v) && length.v >= 0 && start + length.v <= b.length) {
    let p = start + length.v;
    while (p < b.length && isWs(b[p])) p++;
    if (b.toString('latin1', p, p + 9) === 'endstream') return start + length.v;
  }
  const end = b.indexOf('endstream', start, 'latin1');
  return end < 0 ? b.length : end;
}

export function parsePdf(bytes: Buffer): ParsedPdf {
  if (bytes.toString('latin1', 0, 5) !== '%PDF-') throw new PdfError('Fișierul nu începe cu antet PDF');
  const topLevel: PdfObject[] = [];
  const trailers: { pos: number; dict: PdfDict }[] = [];
  let syntaxErrors = 0;

  let p = 0;
  let nextTrailer = bytes.indexOf('trailer', 0, 'latin1');
  const refreshTrailer = () => { if (nextTrailer >= 0 && nextTrailer < p) nextTrailer = bytes.indexOf('trailer', p, 'latin1'); };

  for (;;) {
    refreshTrailer();
    const o = bytes.indexOf('obj', p, 'latin1');
    if (nextTrailer >= 0 && (o < 0 || nextTrailer < o)) {
      const lx = new Lexer(bytes, nextTrailer + 7);
      try {
        const d = lx.value();
        if (isDict(d)) trailers.push({ pos: nextTrailer, dict: d });
        p = lx.p;
      } catch {
        syntaxErrors++;
        p = nextTrailer + 7;
      }
      continue;
    }
    if (o < 0) break;
    const prev = bytes.toString('latin1', Math.max(0, o - 3), o);
    const header = prev === 'end' ? null : objectHeader(bytes, o);
    if (!header) { p = o + 3; continue; }
    if (topLevel.length >= MAX_OBJECTS) throw new PdfError('PDF cu prea multe obiecte');
    const lx = new Lexer(bytes, o + 3);
    let value: PdfValue;
    try {
      value = lx.value();
    } catch {
      syntaxErrors++;
      p = o + 3;
      continue;
    }
    lx.skip();
    const obj: PdfObject = { num: header.num, gen: header.gen, value, pos: header.start, start: header.start, end: lx.p, compressed: false };
    if (isDict(value) && lx.startsWith('stream')) {
      let s = lx.p + 6;
      if (bytes[s] === 13 && bytes[s + 1] === 10) s += 2;
      else if (bytes[s] === 10 || bytes[s] === 13) s += 1;
      const e = streamEnd(bytes, s, value.map.get('Length'));
      obj.stream = { start: s, end: e };
      obj.end = Math.min(e + 9, bytes.length);
      p = obj.end;
      if (isName(value.map.get('Type'), 'XRef')) trailers.push({ pos: header.start, dict: value });
    } else {
      p = lx.p;
    }
    topLevel.push(obj);
  }

  const trailer = new Map<string, PdfValue>();
  for (const t of trailers.sort((a, b) => a.pos - b.pos)) {
    for (const key of ['Root', 'Info', 'ID', 'Encrypt', 'Size']) {
      const v = t.dict.map.get(key);
      if (v !== undefined) trailer.set(key, v);
    }
  }
  const encrypted = trailer.has('Encrypt');

  const objects = new Map<number, PdfObject>();
  for (const obj of topLevel) {
    const cur = objects.get(obj.num);
    if (!cur || obj.pos >= cur.pos) objects.set(obj.num, obj);
  }

  // Fluxuri de obiecte: fiecare obiect se așază la poziția fluxului care îl conține.
  let unreadObjectStreams = 0;
  let budget = OBJSTM_BUDGET;
  for (const container of topLevel) {
    if (!container.stream || !isDict(container.value) || !isName(container.value.map.get('Type'), 'ObjStm')) continue;
    if (encrypted) { unreadObjectStreams++; continue; }
    const content = decodeObjectStream(bytes, container, budget);
    if (!content) { unreadObjectStreams++; continue; }
    budget -= content.length;
    const n = container.value.map.get('N');
    const first = container.value.map.get('First');
    if (!isNum(n) || !isNum(first) || n.v < 0 || n.v > 100_000 || first.v < 0 || first.v > content.length) { syntaxErrors++; continue; }
    try {
      const head = new Lexer(content, 0, first.v);
      const pairs: [number, number][] = [];
      for (let i = 0; i < n.v; i++) {
        const a = head.value();
        const b = head.value();
        if (!isNum(a) || !isNum(b)) throw new PdfError('Antet invalid');
        pairs.push([a.v, b.v]);
      }
      for (const [objNum, offset] of pairs) {
        if (first.v + offset >= content.length || objects.size >= MAX_OBJECTS) continue;
        const cur = objects.get(objNum);
        if (cur && cur.pos > container.pos) continue;
        try {
          objects.set(objNum, { num: objNum, gen: 0, value: new Lexer(content, first.v + offset).value(), pos: container.pos, start: -1, end: -1, compressed: true });
        } catch {
          syntaxErrors++;
        }
      }
    } catch {
      syntaxErrors++;
    }
  }

  let maxObjectNumber = 0;
  for (const n of objects.keys()) if (n > maxObjectNumber) maxObjectNumber = n;

  // Referința finală `startxref` și felul tabelului pe care îl indică.
  let startxref: number | null = null;
  let xrefKind: ParsedPdf['xrefKind'] = null;
  const sx = bytes.lastIndexOf('startxref', bytes.length, 'latin1');
  if (sx >= 0) {
    const m = /^\s*(\d{1,12})/.exec(bytes.toString('latin1', sx + 9, sx + 40));
    if (m) {
      const offset = Number(m[1]);
      if (offset < bytes.length) {
        startxref = offset;
        const lx = new Lexer(bytes, offset);
        lx.skip();
        if (lx.startsWith('xref')) xrefKind = 'tabel';
        else if (/^\d+\s+\d+\s+obj/.test(bytes.toString('latin1', lx.p, lx.p + 40))) xrefKind = 'flux';
      }
    }
  }

  return { bytes, objects, topLevel, trailer, startxref, xrefKind, syntaxErrors, unreadObjectStreams, maxObjectNumber, encrypted };
}

function decodeObjectStream(bytes: Buffer, container: PdfObject, budget: number): Buffer | null {
  const d = container.value as PdfDict;
  const raw = bytes.subarray(container.stream!.start, container.stream!.end);
  const filter = d.map.get('Filter');
  const names = filter === undefined || filter === null ? [] : Array.isArray(filter) ? filter : [filter];
  if (d.map.get('DecodeParms') != null) {
    const parms = d.map.get('DecodeParms');
    const single = Array.isArray(parms) ? parms[0] : parms;
    if (isDict(single) && isNum(single.map.get('Predictor')) && (single.map.get('Predictor') as PdfNum).v > 1) return null;
  }
  if (names.length === 0) return raw.length <= budget ? raw : null;
  if (names.length !== 1 || !isName(names[0], 'FlateDecode') || budget <= 0) return null;
  try {
    return zlib.inflateSync(raw, { maxOutputLength: budget, finishFlush: zlib.constants.Z_SYNC_FLUSH });
  } catch {
    return null;
  }
}

/** Urmărește referințele până la o valoare; ciclurile și țintele absente dau `null`. */
export function resolve(pdf: ParsedPdf, v: PdfValue | undefined): PdfValue {
  let cur: PdfValue | undefined = v;
  for (let hops = 0; hops < 32; hops++) {
    if (!isRef(cur)) return cur ?? null;
    cur = pdf.objects.get(cur.num)?.value ?? null;
  }
  return null;
}

/** Verifică fiecare flux Flate până la o limită, fără să păstreze conținutul dezarhivat. */
export async function assertStreamsBounded(pdf: ParsedPdf, maxPerStream: number, maxTotal: number): Promise<void> {
  let total = 0;
  for (const obj of pdf.topLevel) {
    if (!obj.stream || !isDict(obj.value)) continue;
    const filter = obj.value.map.get('Filter');
    const names = filter === undefined || filter === null ? [] : Array.isArray(filter) ? filter : [filter];
    const flate = names.filter((n) => isName(n, 'FlateDecode') || isName(n, 'Fl')).length;
    if (!flate) continue;
    const used = await inflatedSize(pdf.bytes.subarray(obj.stream.start, obj.stream.end), flate, maxPerStream);
    total += used;
    if (used > maxPerStream || total > maxTotal) throw new PdfError('PDF-ul conține fluxuri care se dezarhivează la dimensiuni excesive');
  }
}

async function inflatedSize(raw: Buffer, layers: number, limit: number): Promise<number> {
  return new Promise((done) => {
    const first = zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
    let tail: zlib.Inflate = first;
    for (let i = 1; i < layers; i++) {
      const next = zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
      next.on('error', () => settle());
      tail.pipe(next);
      tail = next;
    }
    let size = 0;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      first.destroy();
      if (tail !== first) tail.destroy();
      done(size);
    };
    first.on('error', settle);
    tail.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) settle();
    });
    tail.on('end', settle);
    first.end(raw);
  });
}
