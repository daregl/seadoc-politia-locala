// Exportul complet al datelor, în formate deschise, ca instituția să nu depindă de furnizor.
// Utilizare: npm run export:full -w apps/api -- /cale/catre/dosar-export
// Rezultatul: tabele/*.csv (toate tabelele, UTF-8), fisiere/ (documentele decriptate, cu numele originale),
// manifest.json (rânduri pe tabel, SHA-256 pentru fiecare fișier) și CITESTE.txt.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config } from '../src/config.js';
import { StorageService } from '../src/storage.js';

// Sesiunile și stările de autentificare sunt temporare și conțin secrete; nu fac parte din date.
const SKIP = new Set(['sessions', 'oidc_login_states', 'signing_sessions', 'schema_migrations']);
// Coloane cu secrete, golite în export.
const REDACT: Record<string, string[]> = { users: ['password_hash', 'totp_secret'], api_tokens: ['token_hash'] };

const csvCell = (value: unknown): string => {
  if (value == null) return '';
  let s = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[";\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
};
const safeName = (name: string) => name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 150) || 'fisier';

async function main() {
  const out = path.resolve(process.argv[2] ?? `export-seadoc-${new Date().toISOString().slice(0, 10)}`);
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`Dosarul ${out} există și nu este gol`);
  fs.mkdirSync(path.join(out, 'tabele'), { recursive: true });
  fs.mkdirSync(path.join(out, 'fisiere'), { recursive: true });
  const db = new pg.Client({ connectionString: config.databaseUrl });
  await db.connect();
  const storage = new StorageService();
  const manifest: { generatedAt: string; database: string; tables: Record<string, number>; files: { path: string; sha256: string; bytes: number; source: string }[]; problems: string[] } = {
    generatedAt: new Date().toISOString(), database: new URL(config.databaseUrl).pathname.slice(1), tables: {}, files: [], problems: [],
  };
  try {
    // O singură imagine a bazei: rândurile exportate sunt consistente între ele.
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = (await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows.map((r) => r.tablename as string);
    for (const table of tables) {
      if (SKIP.has(table)) continue;
      const cols = (await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table])).rows.map((r) => r.column_name as string);
      // Textul extras din documente poate fi mare; rămâne în CSV, la fel ca restul.
      const select = cols.map((c) => (REDACT[table]?.includes(c) ? `NULL AS "${c}"` : c === 'search' ? `NULL AS "${c}"` : `"${c}"`)).join(', ');
      const file = fs.createWriteStream(path.join(out, 'tabele', `${table}.csv`));
      file.write(cols.join(';') + '\n');
      const cursorName = `c_${table}`;
      await db.query(`DECLARE ${cursorName} NO SCROLL CURSOR FOR SELECT ${select} FROM "${table}"`);
      let count = 0;
      for (;;) {
        const batch = await db.query(`FETCH 2000 FROM ${cursorName}`);
        if (!batch.rows.length) break;
        for (const row of batch.rows) file.write(cols.map((c) => csvCell(row[c])).join(';') + '\n');
        count += batch.rows.length;
      }
      await db.query(`CLOSE ${cursorName}`);
      await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())));
      manifest.tables[table] = count;
      console.log(`${table}: ${count} rânduri`);
    }

    const write = async (rel: string, key: string, expectedSha: string | null, source: string) => {
      try {
        const data = await storage.get(key);
        const sha = crypto.createHash('sha256').update(data).digest('hex');
        if (expectedSha && sha !== expectedSha) manifest.problems.push(`${rel}: amprenta nu corespunde celei din baza de date`);
        fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
        fs.writeFileSync(path.join(out, rel), data);
        manifest.files.push({ path: rel, sha256: sha, bytes: data.length, source });
      } catch (err) {
        manifest.problems.push(`${rel}: nu a putut fi citit (${String((err as Error).message ?? err)})`);
      }
    };
    const versions = await db.query(
      `SELECT v.id, v.document_id, v.version_no, v.filename, v.sha256, v.storage_key, v.searchable_key, d.reg_label
       FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.storage_key IS NOT NULL ORDER BY v.document_id, v.version_no`);
    for (const v of versions.rows) {
      const dir = `fisiere/documente/${v.document_id}${v.reg_label ? `_${safeName(v.reg_label)}` : ''}`;
      await write(`${dir}/v${v.version_no}_${safeName(v.filename)}`, v.storage_key, v.sha256, `document_versions.id=${v.id}`);
      if (v.searchable_key) await write(`${dir}/v${v.version_no}_cautabil.pdf`, v.searchable_key, null, `document_versions.id=${v.id} (PDF căutabil)`);
    }
    // Versiunile semnate cu certificat sunt versiuni ale documentului și au ieșit mai sus.
    for (const p of (await db.query('SELECT id, case_id, filename, sha256, storage_key FROM case_photos')).rows) {
      await write(`fisiere/lucrari/${p.case_id}/foto${p.id}_${safeName(p.filename)}`, p.storage_key, p.sha256, `case_photos.id=${p.id}`);
    }
    for (const x of (await db.query('SELECT id, proof_filename, proof_sha256, proof_key FROM dispatches WHERE proof_key IS NOT NULL')).rows) {
      await write(`fisiere/expedieri/${x.id}_${safeName(x.proof_filename)}`, x.proof_key, x.proof_sha256, `dispatches.id=${x.id}`);
    }
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(out, 'CITESTE.txt'), [
    'Export complet SeaDoc',
    `Generat la: ${manifest.generatedAt}`,
    '',
    'tabele/   Un fișier CSV pentru fiecare tabel (UTF-8, separator ;, prima linie = numele coloanelor).',
    '          Parolele, secretele MFA și tokenurile sunt golite. Valorile JSON sunt scrise ca text JSON.',
    'fisiere/  Documentele decriptate, cu numele originale: documente/<id>_<număr>/v<versiune>_<nume>,',
    '          inclusiv versiunile semnate, plus fotografiile din teren și dovezile de expediere.',
    'manifest.json  Numărul de rânduri pe tabel și amprenta SHA-256 a fiecărui fișier.',
    '',
    `Fișiere: ${manifest.files.length}. Probleme: ${manifest.problems.length}.`,
    ...manifest.problems.map((p) => `  - ${p}`),
  ].join('\n') + '\n');
  console.log(`Export scris în ${out}: ${Object.keys(manifest.tables).length} tabele, ${manifest.files.length} fișiere, ${manifest.problems.length} probleme`);
  if (manifest.problems.length) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
