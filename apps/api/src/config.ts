import { config as load } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
load({ path: path.join(ROOT, '.env'), quiet: true });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Lipsește variabila de mediu ${name}`);
  return value;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.PORT ?? 4100),
  host: process.env.HOST ?? '127.0.0.1',
  storageKey: Buffer.from(required('STORAGE_KEY'), 'hex'),
  signatureSecret: required('SIGNATURE_SECRET'),
  storageDir: path.resolve(ROOT, process.env.STORAGE_DIR ?? '.data/files'),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  // Numărul de proxy-uri de încredere din fața aplicației (0 = fără proxy).
  trustProxy: Number(process.env.TRUST_PROXY ?? 0),
  // Altă construcție a interfeței, pentru previzualizare fără să atingem cea servită live.
  webDist: process.env.WEB_DIST ? path.resolve(ROOT, process.env.WEB_DIST) : path.join(ROOT, 'apps/web/dist'),
  migrationsDir: path.join(ROOT, 'apps/api/migrations'),
  schedulerMs: Number(process.env.SCHEDULER_MS ?? 60_000),
  ocrPollMs: Number(process.env.OCR_POLL_MS ?? 2_000),
  sessionHours: 10,
  maxUploadBytes: 50 * 1024 * 1024,
  // Fișiere PEM cu rădăcinile de încredere pentru verificarea semnăturilor; fără ele, lanțul rămâne neverificat.
  trustRootsDir: process.env.TRUST_ROOTS_DIR ? path.resolve(ROOT, process.env.TRUST_ROOTS_DIR) : null,
  // Originea agentului local de semnare; pagina web are voie să o apeleze prin CSP.
  agentOrigin: process.env.SIGN_AGENT_ORIGIN ?? 'http://127.0.0.1:47800',
  signSessionTtlSeconds: Number(process.env.SIGN_SESSION_TTL_SECONDS ?? 300),
};
if (config.storageKey.length !== 32) throw new Error('STORAGE_KEY trebuie să aibă 64 de caractere hex');
