import fontkit from '@pdf-lib/fontkit';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PDFDocument, PDFFont, rgb } from 'pdf-lib';

const require = createRequire(import.meta.url);
const FONT_DIR = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
const regularBytes = fs.readFileSync(path.join(FONT_DIR, 'DejaVuSans.ttf'));
const boldBytes = fs.readFileSync(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'));

export interface Letterhead { name: string; address?: string; phone?: string; email?: string }

const PAGE = { width: 595.28, height: 841.89 }; // A4
const MARGIN = { left: 64, right: 64, top: 60, bottom: 64 };
const BODY_SIZE = 10.5;
const LINE = 15;

/** Înlocuiește {{camp}} cu valoarea; un câmp fără valoare devine o linie de completat de mână. */
export function fillTemplate(text: string, values: Record<string, string | null | undefined>): string {
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, key: string) => {
    const value = values[key.toLowerCase()];
    return value == null || value === '' ? '________' : value;
  });
}

/** Câmpurile folosite de un șablon, pentru lista din pagina de administrare. */
export function templateFields(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1].toLowerCase()))];
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') { out.push(''); continue; }
    // Spațiile de la început păstrează alinierea din șablon (semnături pe două coloane).
    const words = paragraph.split(/(\s+)/);
    let line = '';
    for (const word of words) {
      const next = line + word;
      if (line && font.widthOfTextAtSize(next.trimEnd(), size) > width) {
        out.push(line.trimEnd());
        line = word.trimStart();
        // Un cuvânt mai lung decât rândul se taie.
        while (font.widthOfTextAtSize(line, size) > width) {
          let cut = line.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        line = next;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Un document A4 cu antetul instituției, titlul și textul șablonului completat. */
export async function renderLetter(head: Letterhead, title: string, body: string, footer: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(title);
  pdf.setProducer('SeaDoc');
  pdf.setCreator('SeaDoc');
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  const width = PAGE.width - MARGIN.left - MARGIN.right;
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.38, 0.38, 0.42);

  let page = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN.top;
  const pages = [page];

  // Antet
  page.drawText(head.name.toUpperCase(), { x: MARGIN.left, y, size: 12, font: bold, color: ink });
  y -= 15;
  const contact = [head.address, head.phone && `Tel. ${head.phone}`, head.email].filter(Boolean).join(' · ');
  if (contact) {
    for (const line of wrap(contact, regular, 8.5, width)) {
      page.drawText(line, { x: MARGIN.left, y, size: 8.5, font: regular, color: muted });
      y -= 11;
    }
  }
  y -= 4;
  page.drawLine({ start: { x: MARGIN.left, y }, end: { x: PAGE.width - MARGIN.right, y }, thickness: 0.8, color: ink });
  y -= 30;

  for (const line of wrap(title, bold, 12.5, width)) {
    page.drawText(line, { x: MARGIN.left, y, size: 12.5, font: bold, color: ink });
    y -= 17;
  }
  y -= 12;

  for (const line of wrap(body, regular, BODY_SIZE, width)) {
    if (y < MARGIN.bottom + LINE) {
      page = pdf.addPage([PAGE.width, PAGE.height]);
      pages.push(page);
      y = PAGE.height - MARGIN.top;
    }
    if (line) page.drawText(line, { x: MARGIN.left, y, size: BODY_SIZE, font: regular, color: ink });
    y -= LINE;
  }

  pages.forEach((p, i) => {
    const text = `${footer} · pagina ${i + 1} din ${pages.length}`;
    p.drawText(text, { x: MARGIN.left, y: 34, size: 7.5, font: regular, color: muted });
  });
  return Buffer.from(await pdf.save());
}
