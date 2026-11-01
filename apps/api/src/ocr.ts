import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import fontkit from '@pdf-lib/fontkit';
import JSZip from 'jszip';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import { createWorker, Worker } from 'tesseract.js';
import { AuditService } from './audit.js';
import { detachedCopy, runInWorker } from './bounded-worker.js';
import { assertImageBounded, assertPixels, imageLimits, ImageLimitError, tiffPages } from './image-bounds.js';
import { assertZipBounded } from './zip-guard.js';
import { config } from './config.js';
import { Db } from './db.js';
import { StorageService } from './storage.js';

const require = createRequire(import.meta.url);
const OCR_DPI = 200;
const MIN_CHARS_PER_PAGE = 25;
const MAX_TEXT_PAGES = 5_000;
// Un flux PDF de câțiva MB se poate dezarhiva în zeci de GB; se măsoară înainte ca pdf.js să-l încarce.
const PDF_PREFLIGHT = { maxPerStream: 512 * 1024 * 1024, maxTotal: 6 * 1024 * 1024 * 1024 };
const WORKER_LIMITS = { timeoutMs: 120_000, maxOldMb: 192, patient: true };
const FONT_PATH = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf/DejaVuSans.ttf');
const LANG_DIR = path.join(path.dirname(require.resolve('@tesseract.js-data/ron/package.json')), '4.0.0_best_int');

async function pdfjs() {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

async function openPdf(data: Buffer) {
  const lib = await pdfjs();
  // Imaginile peste limită nu se decodează; o pagină care depinde de ele rămâne fără acea imagine.
  return lib.getDocument({ data: new Uint8Array(data), useSystemFonts: false, disableFontFace: true, verbosity: 0, maxImageSize: imageLimits().maxPixels }).promise;
}

export async function pdfText(data: Buffer): Promise<string[]> {
  const doc = await openPdf(data);
  const pages: string[] = [];
  if (doc.numPages > MAX_TEXT_PAGES) {
    await doc.loadingTask.destroy();
    throw new ImageLimitError(`PDF cu ${doc.numPages} de pagini, peste limita de ${MAX_TEXT_PAGES}`);
  }
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((it: any) => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : '')).join('').replace(/[ \t]+/g, ' ').trim());
  }
  await doc.loadingTask.destroy();
  return pages;
}

async function officeText(data: Buffer, mime: string): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const names = Object.keys(zip.files).filter((n) =>
    mime.includes('wordprocessing') ? /^word\/(document|header\d*|footer\d*)\.xml$/.test(n)
      : mime.includes('spreadsheet') ? /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/.test(n)
        : /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const parts: string[] = [];
  for (const name of names.sort()) {
    const xml = await zip.files[name].async('string');
    const texts = [...xml.matchAll(/<(?:w:t|t|a:t|v)(?:\s[^>]*)?>([^<]*)</g)].map((m) => m[1]);
    parts.push(texts.join(' '));
  }
  return parts.join('\n').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// Modelul de limbă amestecă formele vechi cu sedilă (ş, ţ) cu cele corecte, cu virgulă.
const COMMA_FORMS: Record<string, string> = { ş: 'ș', Ş: 'Ș', ţ: 'ț', Ţ: 'Ț' };
const fixDiacritics = (text: string) => text.replace(/[şŞţŢ]/g, (c) => COMMA_FORMS[c]);

const OFFICE = /(wordprocessingml|spreadsheetml|presentationml)/;
const OCR_IMAGES = new Set(['image/png', 'image/jpeg']);

export interface ExtractResult { text: string; searchable?: Buffer; ocrUsed: boolean; applicable: boolean }

@Injectable()
export class OcrService implements OnModuleDestroy {
  private readonly log = new Logger('OCR');
  private worker: Worker | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  afterProcess: (versionId: number) => Promise<void> = async () => {};

  constructor(private readonly db: Db, private readonly storage: StorageService, private readonly audit: AuditService) {}

  private async tesseract(): Promise<Worker> {
    if (!this.worker) {
      this.worker = await createWorker('ron', 1, { langPath: LANG_DIR, gzip: true, cacheMethod: 'none' });
    }
    return this.worker;
  }

  /** Recunoaște o imagine și așterne textul invizibil pe pagina PDF dată. */
  private async ocrPage(png: Buffer, page: any, font: any, imgWidth: number): Promise<string> {
    const worker = await this.tesseract();
    const { data } = await worker.recognize(png, {}, { text: true, blocks: true });
    const { width, height } = page.getSize();
    const scale = width / imgWidth;
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          for (const word of line.words) {
            const text = fixDiacritics(word.text.trim());
            if (!text) continue;
            const w = (word.bbox.x1 - word.bbox.x0) * scale;
            const h = Math.max((word.bbox.y1 - word.bbox.y0) * scale, 1);
            const unit = font.widthOfTextAtSize(text, 1) || 1;
            page.drawText(text, {
              x: word.bbox.x0 * scale,
              y: height - word.bbox.y1 * scale,
              size: Math.max(Math.min(w / unit, h * 1.4), 1),
              font,
              color: rgb(0, 0, 0),
              opacity: 0,
            });
          }
        }
      }
    }
    return fixDiacritics(data.text);
  }

  private async searchableFromPdf(data: Buffer, pagesText: string[]): Promise<{ pdf: Buffer; text: string }> {
    const source = await openPdf(data);
    const out = await PDFDocument.load(data, { ignoreEncryption: true });
    out.registerFontkit(fontkit);
    const font = await out.embedFont(fs.readFileSync(FONT_PATH), { subset: true });
    const texts: string[] = [];
    const { maxPages, maxPixels } = imageLimits();
    const toRecognize = pagesText.filter((p) => p.length < MIN_CHARS_PER_PAGE).length;
    if (toRecognize > maxPages) {
      await source.loadingTask.destroy();
      throw new ImageLimitError(`PDF cu ${toRecognize} de pagini de recunoscut, peste limita de ${maxPages} pentru OCR`);
    }
    for (let i = 1; i <= source.numPages; i++) {
      const existing = pagesText[i - 1] ?? '';
      // Paginile care au deja text rămân neatinse; se recunosc doar cele scanate.
      if (existing.length >= MIN_CHARS_PER_PAGE) { texts.push(existing); continue; }
      const page = await source.getPage(i);
      // O pagină enormă se randează la rezoluție mai mică, nu cu toată memoria serverului.
      const unit = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(OCR_DPI / 72, Math.sqrt(maxPixels / Math.max(unit.width * unit.height, 1))) });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas: canvas as any, canvasContext: canvas.getContext('2d') as any, viewport }).promise;
      const png = canvas.toBuffer('image/png');
      texts.push(await this.ocrPage(png, out.getPage(i - 1), font, canvas.width));
    }
    await source.loadingTask.destroy();
    return { pdf: Buffer.from(await out.save()), text: texts.join('\n') };
  }

  /** Fiecare pagină TIFF se decodează într-un fir izolat și ajunge în PDF ca imagine PNG. */
  private async searchableFromTiff(data: Buffer): Promise<{ pdf: Buffer; text: string }> {
    const pages = tiffPages(data);
    const out = await PDFDocument.create();
    out.registerFontkit(fontkit);
    const font = await out.embedFont(fs.readFileSync(FONT_PATH), { subset: true });
    const texts: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      const copy = detachedCopy(data);
      const { width, height, rgba } = await runInWorker<{ width: number; height: number; rgba: Uint8Array }>('tiff-page', { data: copy, page: i }, WORKER_LIMITS, [copy.buffer]);
      assertPixels(width, height);
      if (rgba.length !== width * height * 4) throw new ImageLimitError('Pagină TIFF cu date incomplete');
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      const image = ctx.createImageData(width, height);
      image.data.set(rgba);
      ctx.putImageData(image, 0, 0);
      const png = canvas.toBuffer('image/png');
      const pageWidth = (width / OCR_DPI) * 72;
      const pageHeight = (height / OCR_DPI) * 72;
      const page = out.addPage([pageWidth, pageHeight]);
      page.drawImage(await out.embedPng(png), { x: 0, y: 0, width: pageWidth, height: pageHeight });
      texts.push(await this.ocrPage(png, page, font, width));
    }
    return { pdf: Buffer.from(await out.save()), text: texts.join('\n') };
  }

  private async searchableFromImage(data: Buffer, mime: string): Promise<{ pdf: Buffer; text: string }> {
    assertImageBounded(data, mime);
    const img = await loadImage(data);
    const out = await PDFDocument.create();
    out.registerFontkit(fontkit);
    const font = await out.embedFont(fs.readFileSync(FONT_PATH), { subset: true });
    const embedded = mime === 'image/png' ? await out.embedPng(data) : await out.embedJpg(data);
    const pageWidth = (img.width / OCR_DPI) * 72;
    const pageHeight = (img.height / OCR_DPI) * 72;
    const page = out.addPage([pageWidth, pageHeight]);
    page.drawImage(embedded, { x: 0, y: 0, width: pageWidth, height: pageHeight });
    const text = await this.ocrPage(data, page, font, img.width);
    return { pdf: Buffer.from(await out.save()), text };
  }

  async extract(data: Buffer, mime: string): Promise<ExtractResult> {
    if (mime === 'application/pdf') {
      const copy = detachedCopy(data);
      await runInWorker('pdf-preflight', { data: copy, ...PDF_PREFLIGHT }, WORKER_LIMITS, [copy.buffer]);
      const pages = await pdfText(data);
      const needsOcr = pages.some((p) => p.length < MIN_CHARS_PER_PAGE);
      if (!needsOcr) return { text: pages.join('\n'), ocrUsed: false, applicable: true };
      const { pdf, text } = await this.searchableFromPdf(data, pages);
      return { text, searchable: pdf, ocrUsed: true, applicable: true };
    }
    if (OCR_IMAGES.has(mime)) {
      const { pdf, text } = await this.searchableFromImage(data, mime);
      return { text, searchable: pdf, ocrUsed: true, applicable: true };
    }
    if (mime === 'image/tiff') {
      const { pdf, text } = await this.searchableFromTiff(data);
      return { text, searchable: pdf, ocrUsed: true, applicable: true };
    }
    if (OFFICE.test(mime)) await assertZipBounded(data);
    if (OFFICE.test(mime)) return { text: await officeText(data, mime), ocrUsed: false, applicable: true };
    if (mime.startsWith('text/')) return { text: data.toString('utf8'), ocrUsed: false, applicable: true };
    return { text: '', ocrUsed: false, applicable: false };
  }

  start() {
    // La repornire, lucrările întrerupte se reiau.
    void this.db.query(`UPDATE document_versions SET ocr_status = 'in_asteptare' WHERE ocr_status = 'in_lucru'`).then(() => {
      if (this.stopped) return;
      const tick = () => void this.drain().catch((err) => this.log.error(`Coada OCR: ${(err as Error).message}`));
      this.timer = setInterval(tick, config.ocrPollMs);
      tick();
    });
  }

  /** Procesează pe rând versiunile în așteptare. Întoarce când coada e goală. */
  drain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    // Un apel făcut în timpul procesării așteaptă aceeași coadă, nu întoarce imediat.
    this.running ??= this.work().finally(() => { this.running = null; });
    return this.running;
  }

  private async work(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const v = await this.db.one(
        `UPDATE document_versions SET ocr_status = 'in_lucru' WHERE id = (
           SELECT id FROM document_versions WHERE ocr_status = 'in_asteptare' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING id, document_id, storage_key, mime`);
      if (!v) return;
      await this.process(v);
    }
  }

  private async process(v: { id: number; document_id: number; storage_key: string; mime: string }) {
    const started = Date.now();
    try {
      const result = await this.extract(await this.storage.get(v.storage_key), v.mime);
      const searchableKey = result.searchable ? await this.storage.put(result.searchable) : null;
      const text = result.text.replace(/\u0000/g, '');
      await this.db.tx(async (c) => {
        await c.query(
          `UPDATE document_versions SET ocr_status = $2, text_content = $3, searchable_key = $4, ocr_used = $5 WHERE id = $1`,
          [v.id, result.applicable ? 'finalizat' : 'neaplicabil', text, searchableKey, result.ocrUsed]);
        // Indexul folosește mereu cea mai nouă versiune.
        await c.query(
          `UPDATE documents SET content_text = $2 WHERE id = $1 AND status <> 'arhivat' AND status <> 'eliminat'
             AND NOT EXISTS (SELECT 1 FROM document_versions n WHERE n.document_id = $1 AND n.id > $3)`,
          [v.document_id, text, v.id]);
        await this.audit.log(null, {
          action: result.ocrUsed ? 'document.ocr' : 'document.text_extras', documentId: v.document_id,
          details: { versiune: v.id, caractere: text.length, durataMs: Date.now() - started },
        }, c);
      });
      await this.afterProcess(v.id);
    } catch (err) {
      this.log.error(`Versiunea ${v.id}: ${(err as Error).message}`);
      await this.db.query(`UPDATE document_versions SET ocr_status = 'esuat', ocr_error = $2 WHERE id = $1`, [v.id, String((err as Error).message).slice(0, 500)]);
      await this.audit.log(null, { action: 'document.ocr_esuat', documentId: v.document_id, details: { versiune: v.id } });
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
    if (this.worker) await this.worker.terminate();
    this.worker = null;
  }
}

