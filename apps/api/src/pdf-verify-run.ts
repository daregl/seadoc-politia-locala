// Rularea verificatorului în firul izolat, împreună cu rădăcinile de încredere configurate.
import { Logger } from '@nestjs/common';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { detachedCopy, runInWorker, WorkerLimitError, WorkerLimits } from './bounded-worker.js';
import { config } from './config.js';
import { fail } from './http.js';
import type { TrustRootPem, VerifyReport } from './pdf-signatures.js';

export const VERIFY_LIMITS: WorkerLimits = { timeoutMs: 30_000, maxOldMb: 192 };
const MAX_ROOT_FILES = 200;
const MAX_ROOT_FILE_BYTES = 1024 * 1024;

export async function loadTrustRoots(): Promise<TrustRootPem[]> {
  const dir = config.trustRootsDir;
  if (!dir) return [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    new Logger('Semnături').warn(`TRUST_ROOTS_DIR nu se poate citi: ${dir}`);
    return [];
  }
  const out: TrustRootPem[] = [];
  for (const file of names.filter((n) => /\.(pem|crt|cer)$/i.test(n)).sort().slice(0, MAX_ROOT_FILES)) {
    const full = path.join(dir, file);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_ROOT_FILE_BYTES) continue;
    out.push({ file, pem: await fs.readFile(full, 'utf8') });
  }
  return out;
}

/** Fișierul ostil dă un raport `esuat`, nu o eroare de server. Doar coada plină este 503. */
export async function verifyPdfBytes(data: Buffer): Promise<VerifyReport> {
  const copy = detachedCopy(data);
  try {
    return await runInWorker<VerifyReport>('pdf-verify', { data: copy, roots: await loadTrustRoots() }, VERIFY_LIMITS, [copy.buffer]);
  } catch (err) {
    if (!(err instanceof WorkerLimitError)) throw err;
    if (err.kind === 'ocupat') fail(503, err.message);
    return {
      status: 'esuat',
      message: err.message,
      fileSha256: crypto.createHash('sha256').update(data).digest('hex'),
      fileSize: data.length,
      checkedAt: new Date().toISOString(),
      trustRootsConfigured: 0,
      trustRootsRejected: [],
      signatures: [],
      truncated: false,
      notes: [],
    };
  }
}
