const TZ = 'Europe/Bucharest';
const dateFmt = new Intl.DateTimeFormat('ro-RO', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('ro-RO', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const numberFmt = new Intl.NumberFormat('ro-RO');

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const fmtDate = (value: string | null | undefined, empty = '–'): string => {
  const d = parse(value);
  return d ? dateFmt.format(d) : empty;
};
export const fmtDateTime = (value: string | null | undefined, empty = '–'): string => {
  const d = parse(value);
  return d ? dateTimeFmt.format(d) : empty;
};
export const fmtNumber = (value: number): string => numberFmt.format(value);

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${numberFmt.format(Math.round(bytes / 102.4) / 10)} KB`;
  return `${numberFmt.format(Math.round(bytes / 104857.6) / 10)} MB`;
}

export function fmtHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || Number.isNaN(Number(hours))) return '–';
  const n = Number(hours);
  if (n < 48) return `${numberFmt.format(Math.round(n * 10) / 10)} ore`;
  return `${numberFmt.format(Math.round((n / 24) * 10) / 10)} zile`;
}

/** Plural românesc: 1 document, 2 documente, 20 de documente. */
export function plural(n: number, one: string, many: string): string {
  if (n === 1) return `1 ${one}`;
  const rest = n % 100;
  const de = n !== 0 && (rest === 0 || rest >= 20);
  return `${numberFmt.format(n)} ${de ? 'de ' : ''}${many}`;
}

/** Expeditorul unui email, în forma „Nume <adresă>”. */
export const senderLabel = (m: { fromName: string | null; fromAddress: string | null }): string => (m.fromName && m.fromAddress ? `${m.fromName} <${m.fromAddress}>` : m.fromName ?? m.fromAddress ?? '');

export const shortHash = (hash: string | null | undefined): string => (hash ? `${hash.slice(0, 12)}…` : '–');
