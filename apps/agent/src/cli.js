#!/usr/bin/env node
// Agentul local SeaDoc. Rulează ca utilizator obișnuit, fără drepturi de administrator.
import path from 'node:path';
import crypto from 'node:crypto';
import { X509Certificate } from 'node:crypto';
import { importP12 } from './drivers/p12.js';
import { createAgent } from './server.js';
import { homeDir, loadConfig, normalizeOrigin, saveConfig } from './store.js';

const USAGE = `Utilizare: seadoc-agent <comandă>

  start                     pornește agentul pe 127.0.0.1
  pair [--new]              afișează tokenul de asociere (--new îl înlocuiește)
  origin add <origine>      permite o origine, de exemplu https://seadoc.ctp-iasi.ro
  origin remove <origine>   retrage o origine
  import-p12 <fișier.p12>   adaugă certificatele dintr-un fișier PKCS#12 (cere parola)
  pkcs11 <modul>            setează modulul PKCS#11 al tokenului (fișierul .so/.dll)
  list                      afișează certificatele cunoscute

Configurația este în ${homeDir()}.`;

/** Citește o linie: ascuns din terminal, sau prima linie când intrarea vine prin pipe. */
function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => { data += c; });
      stdin.on('end', () => resolve(data.split(/\r?\n/)[0]));
      stdin.on('error', reject);
      return;
    }
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') { stdin.setRawMode(false); process.exit(130); }
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'start': {
      const config = loadConfig();
      if (!config.allowedOrigins.length) console.error('Atenție: nicio origine permisă. Adăugați una cu „seadoc-agent origin add”; până atunci, toate cererile sunt respinse.');
      const agent = createAgent(config);
      const port = await agent.listen();
      // Prima linie este citită de scripturi.
      console.log(JSON.stringify({ agent: 'seadoc', listening: `http://127.0.0.1:${port}`, port }));
      const stop = () => agent.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'pair': {
      const config = loadConfig();
      if (args[0] === '--new') {
        config.pairingToken = crypto.randomBytes(32).toString('hex');
        saveConfig(config);
      }
      console.log(config.pairingToken);
      return;
    }
    case 'origin': {
      const config = loadConfig();
      const origin = normalizeOrigin(args[1] ?? '');
      if (args[0] === 'add') config.allowedOrigins = [...new Set([...config.allowedOrigins, origin])];
      else if (args[0] === 'remove') config.allowedOrigins = config.allowedOrigins.filter((o) => o !== origin);
      else throw new Error(USAGE);
      saveConfig(config);
      console.log(config.allowedOrigins.join('\n'));
      return;
    }
    case 'import-p12': {
      if (!args[0]) throw new Error(USAGE);
      const config = loadConfig();
      const file = path.resolve(args[0]);
      const entries = importP12(file, await readSecret('Parola fișierului: '));
      config.certificates = [...config.certificates.filter((c) => !entries.some((e) => e.id === c.id)), ...entries];
      saveConfig(config);
      for (const e of entries) console.log(`${e.id}\t${new X509Certificate(e.certPem).subject.replace(/\n/g, ', ')}`);
      return;
    }
    case 'pkcs11': {
      if (!args[0]) throw new Error(USAGE);
      const config = loadConfig();
      config.pkcs11 = { modulePath: path.resolve(args[0]) };
      saveConfig(config);
      console.log(config.pkcs11.modulePath);
      return;
    }
    case 'list': {
      const config = loadConfig();
      for (const e of config.certificates) console.log(`${e.id}\t${new X509Certificate(e.certPem).subject.replace(/\n/g, ', ')}`);
      return;
    }
    default:
      console.error(USAGE);
      process.exitCode = command ? 2 : 0;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
