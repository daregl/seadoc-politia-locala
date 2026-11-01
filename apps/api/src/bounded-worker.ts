// Prelucrarea fișierelor primite (PDF, Office, TIFF) rulează în fire izolate, cu timp și memorie limitate.
// Un fișier ostil termină firul lui, nu serverul.
import { Worker } from 'node:worker_threads';

export type WorkerFailure = 'timp_depasit' | 'memorie_depasita' | 'esuat' | 'ocupat';

export class WorkerLimitError extends Error {
  constructor(readonly kind: WorkerFailure, message: string) {
    super(message);
  }
}

export interface WorkerLimits {
  timeoutMs: number;
  maxOldMb: number;
  /** Lucrările din coada OCR așteaptă un loc liber; cererile HTTP primesc 503. */
  patient?: boolean;
}

const MAX_ACTIVE = 2;
const MAX_WAITING = 8;
let active = 0;
const waiting: (() => void)[] = [];

async function slot(patient = false): Promise<void> {
  if (active < MAX_ACTIVE) { active++; return; }
  if (!patient && waiting.length >= MAX_WAITING) throw new WorkerLimitError('ocupat', 'Serverul prelucrează prea multe fișiere. Încercați din nou peste câteva momente.');
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

export async function runInWorker<T>(op: string, payload: unknown, limits: WorkerLimits, transfer: ArrayBuffer[] = []): Promise<T> {
  await slot(limits.patient);
  try {
    return await new Promise<T>((resolve, reject) => {
      const worker = new Worker(new URL('./sandbox-worker.js', import.meta.url), {
        workerData: { op, payload },
        transferList: transfer,
        resourceLimits: { maxOldGenerationSizeMb: limits.maxOldMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
        stdout: false,
        stderr: false,
      });
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new WorkerLimitError('timp_depasit', 'Prelucrarea fișierului a depășit timpul permis.')));
      }, limits.timeoutMs);
      worker.once('message', (msg: { ok: boolean; result?: T; error?: string }) => {
        finish(() => (msg.ok ? resolve(msg.result as T) : reject(new WorkerLimitError('esuat', msg.error ?? 'Prelucrarea fișierului a eșuat.'))));
      });
      worker.once('error', (err: Error & { code?: string }) => {
        const memory = err.code === 'ERR_WORKER_OUT_OF_MEMORY';
        finish(() => reject(new WorkerLimitError(memory ? 'memorie_depasita' : 'esuat', memory ? 'Prelucrarea fișierului a depășit memoria permisă.' : 'Prelucrarea fișierului a eșuat.')));
      });
      worker.once('exit', () => {
        finish(() => reject(new WorkerLimitError('esuat', 'Prelucrarea fișierului s-a întrerupt.')));
      });
    });
  } finally {
    release();
  }
}

/** Copie proprie, ca să poată fi transferată firului fără să atingă bufferul apelantului. */
export function detachedCopy(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  return copy;
}

export const asBuffer = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);
