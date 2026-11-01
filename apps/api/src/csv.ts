// CSV fără dependențe de aplicație: folosit de importul ERP și de instrumentul de migrare, care poate rula fără bază de date.

export interface RawTable { columns: string[]; rows: { line: number; cells: string[] }[]; malformed: { line: number; reason: string }[] }

// Formele vechi cu sedilă, frecvente în exporturile din sisteme mai vechi.
const COMMA_FORMS: Record<string, string> = { ş: 'ș', Ş: 'Ș', ţ: 'ț', Ţ: 'Ț' };
export const fixDiacritics = (text: string) => text.replace(/[şŞţŢ]/g, (c) => COMMA_FORMS[c]);

/** UTF-8 dacă octeții sunt valizi; altfel Windows-1250, codarea obișnuită a exporturilor românești. */
export function decodeCsv(data: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    text = new TextDecoder('windows-1250').decode(data);
  }
  return fixDiacritics(text.replace(/^﻿/, ''));
}

/** Delimitatorul cel mai frecvent în antet, în afara ghilimelelor. */
function detectDelimiter(text: string): string {
  const firstLine: Record<string, number> = { ';': 0, ',': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in firstLine) firstLine[ch]++;
  }
  return Object.entries(firstLine).sort((a, b) => b[1] - a[1])[0][0];
}

/** Parser RFC 4180. O ghilimea neînchisă nu oprește citirea: rândul se raportează, iar ce s-a citit până la el rămâne. */
export function parseCsv(text: string): RawTable {
  const delimiter = detectDelimiter(text);
  const records: { line: number; cells: string[]; bad?: string }[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let wasQuoted = false;
  let line = 1;
  let startLine = 1;
  const endCell = () => { cells.push(wasQuoted ? cell : cell.trim()); cell = ''; wasQuoted = false; };
  const endRecord = () => {
    endCell();
    if (cells.some((c) => c !== '')) records.push({ line: startLine, cells });
    cells = [];
    startLine = line;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === '') {
      inQuotes = true; wasQuoted = true; cell = '';
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      line++;
      endRecord();
    } else {
      cell += ch;
    }
  }
  if (inQuotes) {
    // Tot ce urmează după ghilimeaua neînchisă a ajuns într-o singură celulă, deci nu se poate folosi.
    records.push({ line: startLine, cells: [], bad: 'Ghilimele neînchise: rândul și tot ce urmează după el nu s-au putut citi' });
  } else if (cell !== '' || cells.length) {
    endRecord();
  }
  const header = records.shift();
  if (!header || header.bad) return { columns: [], rows: [], malformed: [{ line: 1, reason: 'Fișierul nu are antet' }] };
  const columns = header.cells.map((c) => c.trim());
  const rows: RawTable['rows'] = [];
  const malformed: RawTable['malformed'] = [];
  for (const r of records) {
    if (r.bad) malformed.push({ line: r.line, reason: r.bad });
    else if (r.cells.length !== columns.length) malformed.push({ line: r.line, reason: `Rândul are ${r.cells.length} coloane, antetul are ${columns.length}` });
    else rows.push({ line: r.line, cells: r.cells });
  }
  return { columns, rows, malformed };
}

/** Data în formă ISO; acceptă și formele românești zz.ll.aaaa și zz/ll/aaaa. Respinge datele imposibile. */
export function parseDate(value: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const ro = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(value);
  const [y, m, d] = iso ? [+iso[1], +iso[2], +iso[3]] : ro ? [+ro[3], +ro[2], +ro[1]] : [0, 0, 0];
  if (!y) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Celulă pentru fișierele citite și de oameni, în Excel: ce ar putea fi luat drept formulă primește un apostrof în față.
 * Spre deosebire de `csvCell`, are drum înapoi, prin `decodeCell`, fiindcă inventarul este și intrarea importului.
 */
export function encodeCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (/^['=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export const decodeCell = (s: string) => (/^'['=+\-@\t\r]/.test(s) ? s.slice(1) : s);
