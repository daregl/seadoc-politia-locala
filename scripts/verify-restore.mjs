// Verifică o restaurare: fiecare fișier se decriptează, amprenta se compară, lanțul de audit se recalculează.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const key = Buffer.from(env.STORAGE_KEY, 'hex');
const dir = process.env.RESTORE_FILES;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

function decrypt(name) {
  const raw = fs.readFileSync(path.join(dir, name));
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(name));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

const { rows } = await client.query('SELECT id, sha256, storage_key, searchable_key FROM document_versions WHERE storage_key IS NOT NULL');
let ok = 0;
const errors = [];
for (const v of rows) {
  try {
    if (crypto.createHash('sha256').update(decrypt(v.storage_key)).digest('hex') !== v.sha256) throw new Error('amprentă diferită');
    if (v.searchable_key) decrypt(v.searchable_key);
    ok++;
  } catch (err) {
    errors.push(`versiunea ${v.id}: ${err.message}`);
  }
}
const chain = (await client.query(
  `WITH c AS (SELECT a.seq, a.hash, a.prev_hash, lag(a.hash, 1, '') OVER (ORDER BY a.seq) AS ep, audit_row_hash(a.prev_hash, a) AS eh FROM audit_log a)
   SELECT count(*)::int AS n, count(*) FILTER (WHERE prev_hash <> ep OR hash <> eh)::int AS bad FROM c`)).rows[0];
const docs = (await client.query('SELECT count(*)::int AS n FROM documents')).rows[0].n;
await client.end();
console.log(`documente: ${docs}; fișiere verificate: ${ok}/${rows.length}; audit: ${chain.n} rânduri, ${chain.bad} alterate`);
for (const e of errors) console.error(e);
if (errors.length || chain.bad) process.exit(1);
console.log('Restaurare verificată.');
