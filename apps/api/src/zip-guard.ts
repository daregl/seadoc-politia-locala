// Fișierele Office sunt arhive ZIP. Înainte de a le da unei biblioteci care le dezarhivează în memorie,
// se măsoară volumul real, nu cel declarat în antet, fără să se păstreze conținutul.
import zlib from 'node:zlib';

export class ZipLimitError extends Error {}

export interface ZipLimits { maxEntries: number; maxTotalBytes: number }
export const OFFICE_ZIP_LIMITS: ZipLimits = { maxEntries: 20_000, maxTotalBytes: 256 * 1024 * 1024 };

interface Entry { method: number; compressedSize: number; localOffset: number }

function centralDirectory(b: Buffer, limits: ZipLimits): Entry[] {
  // Sfârșitul directorului central e în ultimii 64 KB (comentariul are cel mult 65535 de octeți).
  let eocd = -1;
  for (let p = b.length - 22; p >= Math.max(0, b.length - 22 - 65_535); p--) {
    if (b.readUInt32LE(p) === 0x06054b50) { eocd = p; break; }
  }
  if (eocd < 0) throw new ZipLimitError('Arhiva Office este invalidă');
  const count = b.readUInt16LE(eocd + 10);
  const offset = b.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new ZipLimitError('Arhivele ZIP64 nu sunt acceptate pentru previzualizare');
  if (count > limits.maxEntries) throw new ZipLimitError('Arhiva Office conține prea multe fișiere');
  const entries: Entry[] = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) throw new ZipLimitError('Arhiva Office este invalidă');
    entries.push({ method: b.readUInt16LE(p + 10), compressedSize: b.readUInt32LE(p + 20), localOffset: b.readUInt32LE(p + 42) });
    p += 46 + b.readUInt16LE(p + 28) + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
  }
  return entries;
}

function inflatedSize(raw: Buffer, budget: number): Promise<number> {
  return new Promise((done, fail) => {
    const inflate = zlib.createInflateRaw({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
    let size = 0;
    inflate.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > budget) {
        inflate.destroy();
        fail(new ZipLimitError('Arhiva Office se dezarhivează la o dimensiune excesivă'));
      }
    });
    inflate.on('end', () => done(size));
    inflate.on('error', () => fail(new ZipLimitError('Arhiva Office este invalidă')));
    inflate.end(raw);
  });
}

export async function assertZipBounded(b: Buffer, limits: ZipLimits = OFFICE_ZIP_LIMITS): Promise<void> {
  let total = 0;
  for (const e of centralDirectory(b, limits)) {
    if (e.localOffset + 30 > b.length || b.readUInt32LE(e.localOffset) !== 0x04034b50) throw new ZipLimitError('Arhiva Office este invalidă');
    const start = e.localOffset + 30 + b.readUInt16LE(e.localOffset + 26) + b.readUInt16LE(e.localOffset + 28);
    const raw = b.subarray(start, start + e.compressedSize);
    if (e.method === 0) total += raw.length;
    else if (e.method === 8) total += await inflatedSize(raw, limits.maxTotalBytes - total);
    else throw new ZipLimitError('Arhiva Office folosește o metodă de compresie necunoscută');
    if (total > limits.maxTotalBytes) throw new ZipLimitError('Arhiva Office se dezarhivează la o dimensiune excesivă');
  }
}
