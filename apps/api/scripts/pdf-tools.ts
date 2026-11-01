// Generatoare de PDF pentru datele demonstrative și pentru teste: PDF cu strat de text și PDF „scanat”, doar imagine.
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import fontkit from '@pdf-lib/fontkit';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PDFDocument, PDFFont, rgb } from 'pdf-lib';

const require = createRequire(import.meta.url);
const FONT_DIR = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
const REGULAR = path.join(FONT_DIR, 'DejaVuSans.ttf');
const BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 56;

export interface PdfSpec {
  title: string;
  /** Linii scurte sub titlu: număr, dată, emitent. */
  lines?: string[];
  paragraphs: string[];
  /** Antet afișat pe fiecare pagină. */
  header?: string;
  /** Data metadatelor; două fișiere cu același text și date diferite au amprente diferite. */
  createdAt?: Date;
}

function wrap(text: string, measure: (s: string) => number, maxWidth: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next) > maxWidth) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}

/** PDF normal, cu text selectabil și diacritice corecte. */
export async function textPdf(spec: PdfSpec): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(REGULAR), { subset: true });
  const bold = await doc.embedFont(fs.readFileSync(BOLD), { subset: true });
  doc.setTitle(spec.title);
  doc.setCreator('SeaDoc');
  doc.setProducer('SeaDoc');
  if (spec.createdAt) {
    doc.setCreationDate(spec.createdAt);
    doc.setModificationDate(spec.createdAt);
  }
  const maxWidth = A4.width - MARGIN * 2;
  let page = doc.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;
  const newPage = () => {
    page = doc.addPage([A4.width, A4.height]);
    y = A4.height - MARGIN;
    drawHeader();
  };
  const drawHeader = () => {
    if (!spec.header) return;
    page.drawText(spec.header, { x: MARGIN, y, size: 8, font, color: rgb(0.35, 0.35, 0.35) });
    y -= 22;
  };
  const write = (text: string, f: PDFFont, size: number, gap: number) => {
    for (const line of wrap(text, (s) => f.widthOfTextAtSize(s, size), maxWidth)) {
      if (y < MARGIN + size) newPage();
      page.drawText(line, { x: MARGIN, y, size, font: f, color: rgb(0.08, 0.08, 0.08) });
      y -= size * 1.45;
    }
    y -= gap;
  };
  drawHeader();
  write(spec.title, bold, 15, 8);
  for (const line of spec.lines ?? []) write(line, font, 9.5, 0);
  y -= 12;
  for (const paragraph of spec.paragraphs) write(paragraph, font, 10.5, 8);
  return Buffer.from(await doc.save());
}

let fontRegistered = false;

/** PNG cu textul randat la 200 dpi, ca o pagină trecută prin scaner. */
export function scannedPagePng(spec: PdfSpec): { png: Buffer; width: number; height: number } {
  if (!fontRegistered) {
    GlobalFonts.registerFromPath(REGULAR, 'DejaVu Sans');
    GlobalFonts.registerFromPath(BOLD, 'DejaVu Sans Bold');
    fontRegistered = true;
  }
  const dpi = 200;
  const width = Math.round((A4.width / 72) * dpi);
  const height = Math.round((A4.height / 72) * dpi);
  const margin = Math.round((MARGIN / 72) * dpi);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#111111';
  ctx.textBaseline = 'top';
  let y = margin;
  const write = (text: string, font: string, size: number, gap: number) => {
    ctx.font = `${size}px "${font}"`;
    for (const line of wrap(text, (s) => ctx.measureText(s).width, width - margin * 2)) {
      if (y + size > height - margin) return;
      ctx.fillText(line, margin, y);
      y += Math.round(size * 1.4);
    }
    y += gap;
  };
  write(spec.title, 'DejaVu Sans Bold', 46, 24);
  for (const line of spec.lines ?? []) write(line, 'DejaVu Sans', 32, 2);
  y += 24;
  for (const paragraph of spec.paragraphs) write(paragraph, 'DejaVu Sans', 34, 20);
  return { png: canvas.toBuffer('image/png'), width, height };
}

/** PDF dintr-o singură imagine, fără niciun strat de text: are nevoie de OCR ca să poată fi căutat. */
export async function scannedPdf(spec: PdfSpec): Promise<Buffer> {
  const { png } = scannedPagePng(spec);
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(png);
  const page = doc.addPage([A4.width, A4.height]);
  page.drawImage(image, { x: 0, y: 0, width: A4.width, height: A4.height });
  doc.setTitle(spec.title);
  doc.setCreator('SeaDoc');
  doc.setProducer('Scaner');
  return Buffer.from(await doc.save());
}
