// Limitele pentru imagini și pentru randarea PDF: dimensiunile se citesc din antet, înainte de orice decodare.
import UTIF from 'utif2';

export class ImageLimitError extends Error {}

export const imageLimits = () => ({
  maxPixels: Number(process.env.OCR_MAX_PIXELS ?? 40_000_000),
  maxPages: Number(process.env.OCR_MAX_PAGES ?? 200),
});

/** Peste atât, un TIFF decomprimat nu mai încape rezonabil în memorie, indiferent de numărul de pixeli. */
const MAX_TIFF_RAW_BYTES = 320 * 1024 * 1024;

const tooLarge = (w: number, h: number, maxPixels: number) =>
  new ImageLimitError(`Imaginea are ${w}×${h} pixeli, peste limita de ${Math.round(maxPixels / 1_000_000)} megapixeli pentru OCR`);

export function assertPixels(width: number, height: number, maxPixels = imageLimits().maxPixels) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new ImageLimitError('Dimensiuni de imagine invalide');
  if (width * height > maxPixels) throw tooLarge(width, height, maxPixels);
}

export function pngSize(data: Buffer): { width: number; height: number } {
  if (data.length < 24 || data.toString('latin1', 12, 16) !== 'IHDR') throw new ImageLimitError('PNG fără antet valid');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

export function jpegSize(data: Buffer): { width: number; height: number } {
  let p = 2;
  while (p + 9 < data.length) {
    if (data[p] !== 0xff) { p++; continue; }
    const marker = data[p + 1];
    if (marker === 0xff) { p++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) return { width: data.readUInt16BE(p + 7), height: data.readUInt16BE(p + 5) };
    p += 2 + data.readUInt16BE(p + 2);
  }
  throw new ImageLimitError('JPEG fără antet valid');
}

export function assertImageBounded(data: Buffer, mime: string) {
  const { width, height } = mime === 'image/png' ? pngSize(data) : jpegSize(data);
  assertPixels(width, height);
  return { width, height };
}

export interface TiffPageInfo { width: number; height: number }

/**
 * Parcurge directoarele TIFF fără să decodeze nimic: număr de pagini, cicluri și dimensiuni.
 * Biblioteca de decodare ar urmări orbește un lanț circular de directoare.
 */
export function tiffPages(data: Buffer): TiffPageInfo[] {
  const { maxPages, maxPixels } = imageLimits();
  const bom = data.toString('latin1', 0, 2);
  if (data.length < 8 || (bom !== 'II' && bom !== 'MM')) throw new ImageLimitError('TIFF fără antet valid');
  const le = bom === 'II';
  const u16 = (p: number) => (le ? data.readUInt16LE(p) : data.readUInt16BE(p));
  const u32 = (p: number) => (le ? data.readUInt32LE(p) : data.readUInt32BE(p));
  if (u16(2) !== 42) throw new ImageLimitError('Doar TIFF clasic este acceptat');
  const pages: TiffPageInfo[] = [];
  const seen = new Set<number>();
  let offset = u32(4);
  while (offset !== 0) {
    if (seen.has(offset)) throw new ImageLimitError('TIFF cu directoare circulare');
    seen.add(offset);
    if (pages.length >= maxPages) throw new ImageLimitError(`TIFF cu mai mult de ${maxPages} de pagini, peste limita pentru OCR`);
    if (offset + 2 > data.length) throw new ImageLimitError('TIFF trunchiat');
    const count = u16(offset);
    const end = offset + 2 + count * 12;
    if (count === 0 || end + 4 > data.length) throw new ImageLimitError('TIFF trunchiat');
    let width = 0;
    let height = 0;
    let samples = 1;
    let bits = 1;
    for (let i = 0; i < count; i++) {
      const e = offset + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      const value = type === 3 && n === 1 ? u16(e + 8) : type === 4 && n === 1 ? u32(e + 8) : null;
      if (tag === 256) width = value ?? 0;
      else if (tag === 257) height = value ?? 0;
      else if (tag === 277) samples = value ?? 1;
      else if (tag === 258) {
        if (value !== null) bits = value;
        else if (type === 3 && n > 0) {
          const at = n <= 2 ? e + 8 : u32(e + 8);
          bits = at + 2 <= data.length ? u16(at) : 0;
        }
      }
    }
    assertPixels(width, height, maxPixels);
    if (samples < 1 || samples > 8 || bits < 1 || bits > 32 || (width * height * samples * bits) / 8 > MAX_TIFF_RAW_BYTES) {
      throw new ImageLimitError('TIFF cu un format de pixeli peste limitele pentru OCR');
    }
    pages.push({ width, height });
    offset = u32(end);
  }
  if (!pages.length) throw new ImageLimitError('TIFF fără pagini');
  return pages;
}

/** Rulează în firul izolat: decodează o singură pagină în RGBA. */
export function decodeTiffPage(data: Buffer, page: number): { width: number; height: number; rgba: Uint8Array } {
  tiffPages(data);
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const ifds = UTIF.decode(ab);
  const ifd = ifds[page];
  if (!ifd) throw new ImageLimitError('Pagină TIFF inexistentă');
  (UTIF.decodeImage as (b: ArrayBuffer, i: UTIF.IFD, all: UTIF.IFD[]) => void)(ab, ifd, ifds);
  assertPixels(ifd.width, ifd.height);
  const rgba = UTIF.toRGBA8(ifd);
  const copy = new Uint8Array(rgba.length);
  copy.set(rgba);
  return { width: ifd.width, height: ifd.height, rgba: copy };
}
