// Conversia Office în HTML curat. Rulează în firul izolat; HTML-ul iese doar prin lista de permisiuni de mai jos.
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import sanitizeHtml from 'sanitize-html';
import { assertZipBounded } from './zip-guard.js';

export const MAX_SHEETS = 30;
export const MAX_ROWS = 2_000;
export const MAX_COLS = 100;
export const MAX_HTML_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_URI = 6 * 1024 * 1024;
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const POLICY: sanitizeHtml.IOptions = {
  allowedTags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
    'blockquote', 'pre', 'code', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'a', 'img', 'section'],
  allowedAttributes: { a: ['href', 'target', 'rel'], img: ['src', 'alt'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan', 'scope'], ol: ['start'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['data'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'template'],
  parseStyleAttributes: false,
  transformTags: {
    a: (tagName, attribs) => {
      const href = attribs.href ?? '';
      // Doar legăturile absolute rămân; ancorele interne și căile relative ar ținti aplicația.
      return SAFE_LINK.test(href)
        ? { tagName, attribs: { href, target: '_blank', rel: 'noopener noreferrer' } as sanitizeHtml.Attributes }
        : { tagName, attribs: {} as sanitizeHtml.Attributes };
    },
  },
  // Doar imagini încorporate, în formate raster; niciodată o adresă externă.
  exclusiveFilter: (frame) => frame.tag === 'img' && !(DATA_IMAGE.test(frame.attribs.src ?? '') && frame.attribs.src.length <= MAX_IMAGE_URI),
};

export const sanitize = (html: string) => sanitizeHtml(html, POLICY);

export interface OfficePreview {
  format: 'docx' | 'xlsx' | 'pptx';
  html: string;
  truncated: boolean;
  notes: string[];
}

async function docx(data: Buffer): Promise<OfficePreview> {
  const out = await mammoth.convertToHtml({ buffer: data });
  const notes: string[] = [];
  if (out.messages.some((m) => /external/i.test(m.message))) notes.push('Imaginile externe din document nu sunt încărcate.');
  return { format: 'docx', html: sanitize(out.value), truncated: false, notes };
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
  }
  if (typeof value !== 'object') return String(value);
  if ('richText' in value) return value.richText.map((r) => r.text).join('');
  if ('error' in value) return String(value.error);
  // O legătură din foaia de calcul se afișează doar ca text.
  if ('text' in value) return typeof value.text === 'string' ? value.text : cellText(value.text as ExcelJS.CellValue);
  if ('result' in value) return cellText((value.result ?? '') as ExcelJS.CellValue);
  if ('formula' in value || 'sharedFormula' in value) return '';
  return '';
}

async function xlsx(data: Buffer): Promise<OfficePreview> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as any);
  const sheets = wb.worksheets.filter((s) => s.state === 'visible' || !s.state);
  const parts: string[] = [];
  let truncated = false;
  if (sheets.length > MAX_SHEETS) truncated = true;
  for (const sheet of sheets.slice(0, MAX_SHEETS)) {
    const rows: string[] = [];
    const lastRow = Math.min(sheet.actualRowCount ? sheet.rowCount : 0, MAX_ROWS);
    const lastCol = Math.min(sheet.columnCount, MAX_COLS);
    if (sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLS) truncated = true;
    for (let r = 1; r <= lastRow; r++) {
      const row = sheet.getRow(r);
      if (!row.hasValues) { rows.push('<tr></tr>'); continue; }
      const cells: string[] = [];
      for (let c = 1; c <= lastCol; c++) {
        const cell = row.getCell(c);
        const merged = cell.isMerged && cell.master.address !== cell.address;
        cells.push(`<td>${merged ? '' : escapeHtml(cellText(cell.value))}</td>`);
      }
      rows.push(`<tr>${cells.join('')}</tr>`);
    }
    parts.push(`<section><h2>${escapeHtml(sheet.name)}</h2>${rows.length ? `<table><tbody>${rows.join('')}</tbody></table>` : '<p>Foaie goală</p>'}</section>`);
  }
  const notes = truncated ? [`Previzualizarea arată cel mult ${MAX_SHEETS} de foi, ${MAX_ROWS} de rânduri și ${MAX_COLS} de coloane. Descărcați fișierul pentru tot conținutul.`] : [];
  return { format: 'xlsx', html: sanitize(parts.join('')), truncated, notes };
}

const decodeXml = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
  .replace(/&amp;/g, '&');

/** Textul fiecărui diapozitiv, cu aceeași citire a XML-ului ca la extragerea pentru căutare. */
export async function pptxSlides(data: Buffer): Promise<{ index: number; paragraphs: string[] }[]> {
  const zip = await JSZip.loadAsync(data);
  const slideNo = (n: string) => Number(/slide(\d+)\.xml$/.exec(n)![1]);
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => slideNo(a) - slideNo(b));
  const slides = [];
  for (const n of names) {
    const xml = await zip.files[n].async('string');
    const paragraphs = xml.split(/<\/a:p>/)
      .map((p) => [...p.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)</g)].map((m) => decodeXml(m[1])).join(''))
      .map((t) => t.trim()).filter(Boolean);
    slides.push({ index: slideNo(n), paragraphs });
  }
  return slides;
}

async function pptx(data: Buffer): Promise<OfficePreview> {
  const slides = await pptxSlides(data);
  const html = slides.map((s) =>
    `<section><h2>Diapozitivul ${s.index}</h2>${s.paragraphs.length ? s.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('') : '<p>Fără text</p>'}</section>`).join('');
  return { format: 'pptx', html: sanitize(html), truncated: false, notes: ['Se afișează doar textul diapozitivelor, fără aspectul lor grafic.'] };
}

export async function convertOffice(data: Buffer, mime: string): Promise<OfficePreview> {
  await assertZipBounded(data);
  const out = mime.includes('wordprocessing') ? await docx(data) : mime.includes('spreadsheet') ? await xlsx(data) : await pptx(data);
  if (Buffer.byteLength(out.html) > MAX_HTML_BYTES) throw new Error('Documentul este prea mare pentru previzualizare');
  return out;
}
